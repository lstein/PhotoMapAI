"""Choosing the DBSCAN epsilon for an album's semantic map.

``eps`` is the one clustering parameter with no album-independent right
answer.  UMAP's output coordinates have no fixed scale — their span grows as
the point count shrinks — so an eps that carves a 40,000-image library into
useful clusters labels a 200-image album as *entirely* unclustered.  That is
not hypothetical: a 240-image album at the old 0.07 default produced zero
clusters and 100% noise, which reads as "the semantic map is broken".

The adaptive rule here is a refinement of the median k-distance heuristic
(the standard DBSCAN eps rule, and what InvokeAI's image map uses): instead
of taking the median outright, candidate eps values are drawn from the
k-distance distribution and the **largest one whose biggest cluster still
stays under a share of the album** is chosen.

Why the extra step: the median makes about half the points core points by
construction, which lands around 25-35% noise on a large library — much more
unclustered than a hand-tuned eps gives.  Walking up the quantiles instead
stops right before one cluster swallows the map, which is the real trade-off
a user is making when they nudge the Cluster Strength control.  Measured
against a set of real albums, the rule reproduces hand-tuned values on the
large ones (0.119 vs a hand-set 0.12 on 38k images; 0.051 vs 0.05 on 86k)
while rescuing the small ones.

Nothing here is cached in memory: the caller holds the coordinates, and the
resolved value is cached on disk by :func:`cached_adaptive_cluster_eps`.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import numpy as np

from .util import atomic_savez

logger = logging.getLogger(__name__)

# DBSCAN min_samples the app uses everywhere. Mirrored by the routers.
DEFAULT_CLUSTER_MIN_SAMPLES = 10

# Fallback when the coordinates cannot support a k-distance at all (fewer
# points than neighbors, or every point coincident). Matches the historical
# album default, so a degenerate album behaves exactly as it used to.
FALLBACK_CLUSTER_EPS = 0.2

# Quantiles of the k-distance distribution, ascending, that the scan walks.
# Coarse on purpose: each step costs a DBSCAN fit, and the resulting eps
# values are within a few percent of each other near the knee anyway.
CANDIDATE_QUANTILES: tuple[int, ...] = (40, 50, 60, 70, 80, 90)

# A cluster holding more than this share of the album is a blob, not a
# cluster: it is what the map looks like just before every point merges into
# one component. Measured on real albums, this is also the knee — the last
# candidate below it consistently landed on the value a human had tuned by
# hand.
MAX_TOP_CLUSTER_SHARE = 0.25

# eps is clamped to this fraction of the coordinate span, and *only* when the
# value was derived rather than typed by a user (see resolve_cluster_eps).
# A derived eps a quarter as wide as the whole map means there is no density
# structure to find, and clustering at that radius says nothing.
#
# InvokeAI's image map uses 0.05 here, and copying that number was a mistake
# worth recording: it suits a *median* k-distance, which sits low in the
# distribution. The scan below deliberately climbs past the median, so 0.05
# clamped values that were correct — on a map of five well-separated blobs it
# overrode the scan's answer outright, and on real albums it collapsed the
# tuning for the smallest one. The pair budget below, not this, is what
# bounds memory; this is only a sanity bound on an automatically chosen
# number, so it is set where it catches absurdity and nothing else.
MAX_EPS_SPAN_FRACTION = 0.25

# sklearn's DBSCAN materializes every point's radius neighborhood as int64
# index arrays, so its peak memory tracks the neighbor-pair count rather than
# the point count. 50M pairs is roughly 400MB.
MAX_NEIGHBOR_PAIRS = 50_000_000

# Hard floor for the pair-budget shrink. A fully coincident map cannot meet
# the budget at any positive radius, so the loop needs a bound to terminate.
MIN_BUDGETED_EPS = 1e-6

# Floor for any resolved eps: DBSCAN at 0 clusters nothing, and the UI's
# spinner will not accept a smaller number either.
MIN_CLUSTER_EPS = 0.01

_CACHE_FILENAME = "umap_eps_auto.npz"


def _k_distances(coords: np.ndarray, min_samples: int) -> np.ndarray | None:
    """Each point's distance to its ``min_samples``-th nearest neighbor.

    ``None`` when the map is too small to have one. Imported lazily because
    importing sklearn's neighbors module is not free and most requests never
    reach here.
    """
    n_points = coords.shape[0]
    k = min(min_samples, n_points - 1)
    if k < 1:
        return None

    from sklearn.neighbors import NearestNeighbors

    # k + 1 neighbors because the first neighbor of a point is itself.
    distances, _ = NearestNeighbors(n_neighbors=k + 1).fit(coords).kneighbors(coords)
    return distances[:, -1]


def _top_cluster_share(coords: np.ndarray, eps: float, min_samples: int) -> float:
    """Share of the album held by the largest cluster at ``eps``.

    Noise (label -1) is excluded, so an eps that clusters nothing scores 0
    and the scan keeps climbing.
    """
    from sklearn.cluster import DBSCAN

    labels = DBSCAN(eps=eps, min_samples=min_samples).fit(coords).labels_
    clustered = labels[labels != -1]
    if clustered.size == 0:
        return 0.0
    return float(np.bincount(clustered).max()) / float(labels.size)


def adaptive_cluster_eps(
    coords: np.ndarray, min_samples: int = DEFAULT_CLUSTER_MIN_SAMPLES
) -> float:
    """Pick an eps for ``coords``: the loosest one that has not yet collapsed
    the map into a single cluster.

    Candidates are quantiles of the k-distance distribution, so they are
    expressed in the units of *these* coordinates — which is what makes the
    result independent of album size and of UMAP's arbitrary output scale.
    The scan walks them upward and keeps the last one whose largest cluster
    is under :data:`MAX_TOP_CLUSTER_SHARE`.

    If even the smallest candidate is over that share the map has no
    structure to separate (a few dozen near-identical images, say); the
    smallest candidate is returned, since going lower only converts the blob
    into noise without revealing anything.
    """
    distances = _k_distances(coords, min_samples)
    if distances is None:
        return FALLBACK_CLUSTER_EPS

    candidates = [float(np.percentile(distances, q)) for q in CANDIDATE_QUANTILES]
    # Coincident points give zero k-distances, and eps=0 clusters nothing.
    candidates = [eps for eps in candidates if eps > 0]
    if not candidates:
        return FALLBACK_CLUSTER_EPS

    best = candidates[0]
    for eps in candidates:
        if _top_cluster_share(coords, eps, min_samples) > MAX_TOP_CLUSTER_SHARE:
            # Every later candidate is larger and so at least as blobby;
            # stopping here is what bounds the scan to a few DBSCAN fits.
            break
        best = eps
    return best


def _shrink_eps_to_pair_budget(coords: np.ndarray, eps: float) -> float:
    """Shrink ``eps`` until DBSCAN's neighbor-pair count fits the budget.

    A span-based bound cannot do this job: a dense blob concentrates most of
    its pairs in a small region, so a modest eps on a wide map can still
    materialize billions of them. Counting pairs with a KD-tree is cheap, so
    the guard measures the thing it is actually protecting.

    This is why the guard exists at all: the Cluster Strength control lets a
    user ask for an eps far looser than an album can afford, and on a
    six-figure album that is an out-of-memory crash rather than a slow
    response.
    """
    if coords.shape[0] < 2:
        return eps

    from sklearn.neighbors import KDTree

    tree = KDTree(coords)
    while eps > MIN_BUDGETED_EPS:
        pairs = int(tree.query_radius(coords, r=eps, count_only=True).sum())
        if pairs <= MAX_NEIGHBOR_PAIRS:
            return eps
        eps *= 0.7
    return eps


def resolve_cluster_eps(
    coords: np.ndarray,
    eps: float | None = None,
    min_samples: int = DEFAULT_CLUSTER_MIN_SAMPLES,
) -> float:
    """The eps that will actually be used for ``coords``.

    ``None`` means "no one has chosen a value" — the album has never had its
    Cluster Strength adjusted — and resolves to :func:`adaptive_cluster_eps`.

    The two clamps are deliberately not applied alike:

    * The **span clamp** applies only to a derived value. A number the user
      typed is theirs to keep; silently retuning it would make the control
      lie about what it does.
    * The **pair budget** applies to every value, derived or typed, because
      it is a memory bound rather than a quality opinion. It is applied last
      so nothing can re-inflate eps past it.

    Every caller that clusters an album must route through this, so that
    ``/umap_data`` and ``/cluster_labels`` agree on cluster ids for the same
    request — they hand back ids that the UI joins on.
    """
    if eps is None:
        eps = adaptive_cluster_eps(coords, min_samples)
        span = float(np.ptp(coords, axis=0).max()) if coords.shape[0] > 1 else 0.0
        if span > 0:
            eps = min(eps, span * MAX_EPS_SPAN_FRACTION)
    return _shrink_eps_to_pair_budget(coords, max(eps, MIN_CLUSTER_EPS))


def resolve_album_cluster_eps(
    coords: np.ndarray | None,
    cache_dir: Path,
    requested: float | None = None,
    stored: float | None = None,
    min_samples: int = DEFAULT_CLUSTER_MIN_SAMPLES,
) -> float:
    """Resolve the eps for one album request: ``requested`` beats ``stored``
    beats adaptive.

    ``requested`` is the query parameter (the Cluster Strength control sends
    it on every fetch), ``stored`` the album's saved ``umap_eps``.  Both are
    ``None`` for an album nobody has tuned, which is what selects the
    adaptive value.

    The single entry point every clustering caller shares: ``/umap_data``,
    ``/cluster_labels`` and ``/get_umap_eps`` must agree on the number, or
    the cluster ids the first two return refer to different clusterings and
    the map's hover labels attach to the wrong blobs.

    ``coords`` may be ``None`` or empty — an album can be configured before
    it is indexed, and the semantic map is opened on exactly that album while
    the first index runs. With nothing to cluster there is nothing to derive
    from and nothing to protect against, so the number passes through
    unclamped and no cache entry is written.
    """
    eps = requested if requested is not None else stored
    if coords is None or coords.shape[0] == 0:
        return eps if eps is not None else FALLBACK_CLUSTER_EPS
    if eps is None:
        return cached_adaptive_cluster_eps(coords, cache_dir, min_samples)
    return resolve_cluster_eps(coords, eps, min_samples)


def _coords_fingerprint(coords: np.ndarray, min_samples: int) -> str:
    """Identity of a (coordinates, min_samples) pair for cache validation.

    Hashes the coordinate bytes rather than trusting the file's mtime: a
    re-index writes new coordinates for the same album at the same path, and
    a stale adaptive eps would then cluster the new map at the old scale.
    Hashing a six-figure album's coordinates is about a megabyte of blake2b,
    far below the cost of the scan it guards.
    """
    digest = hashlib.blake2b(np.ascontiguousarray(coords, dtype=np.float32).tobytes(), digest_size=16)
    digest.update(str(min_samples).encode("ascii"))
    return digest.hexdigest()


def cached_adaptive_cluster_eps(
    coords: np.ndarray,
    cache_dir: Path,
    min_samples: int = DEFAULT_CLUSTER_MIN_SAMPLES,
) -> float:
    """:func:`resolve_cluster_eps` with ``eps=None``, memoized on disk.

    The scan is a few seconds on a six-figure album — fine once, wasteful on
    every open of the semantic map. The cache sits beside ``umap.npz`` (it
    describes the same coordinates and dies with them) and is keyed by a
    fingerprint of those coordinates, so a re-index invalidates it.

    Cache failures are logged and swallowed: recomputing is always correct,
    just slower.
    """
    cache_path = cache_dir / _CACHE_FILENAME
    fingerprint = _coords_fingerprint(coords, min_samples)

    try:
        if cache_path.exists():
            with np.load(cache_path, allow_pickle=False) as data:
                if str(data["fingerprint"]) == fingerprint:
                    return float(data["eps"])
    except Exception as e:
        logger.warning(f"Ignoring unreadable adaptive-eps cache {cache_path}: {e}")

    eps = resolve_cluster_eps(coords, None, min_samples)

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        atomic_savez(
            cache_path,
            eps=np.float64(eps),
            fingerprint=np.array(fingerprint),
        )
    except OSError as e:
        logger.warning(f"Could not save adaptive-eps cache {cache_path}: {e}")

    return eps
