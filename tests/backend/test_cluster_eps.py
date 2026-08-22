"""Tests for the adaptive DBSCAN epsilon.

The fixtures are synthetic point clouds rather than real UMAP output, because
what the rule has to get right is a *shape*: well-separated blobs must
cluster, a structureless cloud must not collapse into one blob, and the scale
of the coordinates must not matter — which is the whole reason a fixed eps
fails on small albums.
"""

import re
from pathlib import Path

import numpy as np
import pytest
from sklearn.cluster import DBSCAN

from photomap.backend.cluster_eps import (
    CANDIDATE_QUANTILES,
    DEFAULT_CLUSTER_MIN_SAMPLES,
    FALLBACK_CLUSTER_EPS,
    MAX_EPS_SPAN_FRACTION,
    MAX_NEIGHBOR_PAIRS,
    MAX_TOP_CLUSTER_SHARE,
    MIN_CLUSTER_EPS,
    _k_distances,
    adaptive_cluster_eps,
    cached_adaptive_cluster_eps,
    resolve_album_cluster_eps,
    resolve_cluster_eps,
)


def blobs(n_per_blob=40, n_blobs=5, spread=0.15, scale=1.0, seed=0):
    """``n_blobs`` tight gaussian blobs on a circle of radius ``scale``."""
    rng = np.random.default_rng(seed)
    angles = np.linspace(0, 2 * np.pi, n_blobs, endpoint=False)
    centers = np.stack([np.cos(angles), np.sin(angles)], axis=1) * scale
    points = [c + rng.normal(0, spread * scale, size=(n_per_blob, 2)) for c in centers]
    return np.vstack(points).astype(np.float32)


def cluster_stats(coords, eps, min_samples=DEFAULT_CLUSTER_MIN_SAMPLES):
    labels = DBSCAN(eps=eps, min_samples=min_samples).fit(coords).labels_
    clustered = labels[labels != -1]
    top = float(np.bincount(clustered).max()) / labels.size if clustered.size else 0.0
    return len(set(clustered.tolist())), float((labels == -1).mean()), top


def test_finds_the_blobs():
    coords = blobs()
    n_clusters, noise, _ = cluster_stats(coords, adaptive_cluster_eps(coords))
    assert n_clusters == 5
    assert noise < 0.2


def test_is_scale_invariant():
    """The same shape at 100x the coordinate span must cluster the same way.

    This is the property a fixed eps lacks and the reason small albums broke:
    UMAP's output scale depends on the point count, so an eps tuned on one
    album is meaningless on another.
    """
    small = blobs(scale=1.0)
    large = blobs(scale=100.0)

    eps_small = adaptive_cluster_eps(small)
    eps_large = adaptive_cluster_eps(large)

    assert cluster_stats(small, eps_small)[0] == cluster_stats(large, eps_large)[0] == 5
    # Scaling the coordinates scales the chosen eps by the same factor.
    assert eps_large == pytest.approx(eps_small * 100, rel=0.05)


def test_a_tiny_album_still_clusters():
    """The failure this feature exists to fix: 200-odd points, where a fixed
    0.07 produced zero clusters and 100% noise."""
    coords = blobs(n_per_blob=40, n_blobs=5, scale=8.0)
    assert cluster_stats(coords, 0.07)[0] == 0  # the old fixed default

    n_clusters, noise, _ = cluster_stats(coords, adaptive_cluster_eps(coords))
    assert n_clusters > 1
    assert noise < 0.3


def test_stops_before_one_cluster_swallows_the_map():
    """On a map with structure, the scan stops climbing while the biggest
    cluster is still a cluster rather than a blob."""
    coords = blobs(n_per_blob=80, n_blobs=6, spread=0.08)
    _, _, top = cluster_stats(coords, adaptive_cluster_eps(coords))
    assert top <= MAX_TOP_CLUSTER_SHARE + 0.01


def test_structureless_cloud_does_not_climb():
    """A single gaussian cloud has nothing to separate, so every candidate is
    over the share cap. The documented fallback is the *smallest* candidate:
    climbing would only merge the map faster, and going lower just converts
    the blob into noise without revealing anything."""
    rng = np.random.default_rng(1)
    coords = rng.normal(0, 1, size=(600, 2)).astype(np.float32)

    distances = _k_distances(coords, DEFAULT_CLUSTER_MIN_SAMPLES)
    smallest_candidate = float(np.percentile(distances, CANDIDATE_QUANTILES[0]))

    assert adaptive_cluster_eps(coords) == pytest.approx(smallest_candidate)


def test_degenerate_inputs_fall_back_rather_than_raise():
    # Fewer points than min_samples: no k-distance exists.
    assert adaptive_cluster_eps(np.zeros((3, 2), dtype=np.float32)) == FALLBACK_CLUSTER_EPS
    # Every point identical: every k-distance is 0, and eps=0 clusters nothing.
    assert adaptive_cluster_eps(np.ones((50, 2), dtype=np.float32)) == FALLBACK_CLUSTER_EPS
    assert adaptive_cluster_eps(np.empty((0, 2), dtype=np.float32)) == FALLBACK_CLUSTER_EPS


# ---------------------------------------------------------------------------
# resolve_cluster_eps: which clamps apply to which values
# ---------------------------------------------------------------------------


def test_explicit_eps_is_not_span_clamped():
    """A number the user typed is theirs to keep.

    The span clamp would silently retune a stored Cluster Strength on a small
    album — 0.9 on a 50-point map becomes 0.33 — which makes the control lie
    about what it does. It applies to derived values only.
    """
    coords = blobs(n_per_blob=10, n_blobs=5, scale=1.0)  # span ~2
    assert resolve_cluster_eps(coords, 0.9) == pytest.approx(0.9)


def test_derived_eps_is_span_clamped():
    """Sparse enough that the derived eps would otherwise span a quarter of
    the map — which is the "no structure here" case the clamp is for."""
    rng = np.random.default_rng(3)
    coords = rng.uniform(0, 1, size=(30, 2)).astype(np.float32)
    span = float(np.ptp(coords, axis=0).max())

    assert adaptive_cluster_eps(coords) > span * MAX_EPS_SPAN_FRACTION
    assert resolve_cluster_eps(coords, None) == pytest.approx(span * MAX_EPS_SPAN_FRACTION)


def test_span_clamp_leaves_a_well_structured_map_alone():
    """The clamp is a bound on absurdity, not a second opinion: on a map with
    real clusters it must not override what the scan chose."""
    coords = blobs(n_per_blob=60)
    assert resolve_cluster_eps(coords, None) == pytest.approx(adaptive_cluster_eps(coords))


def test_resolved_eps_never_goes_below_the_ui_floor():
    coords = blobs()
    assert resolve_cluster_eps(coords, 0.0) >= MIN_CLUSTER_EPS


def test_pair_budget_shrinks_an_absurd_eps():
    """The guard the Cluster Strength control needs: asking for a radius that
    covers the whole map is an out-of-memory crash on a large album, not a
    slow response."""
    rng = np.random.default_rng(2)
    coords = rng.normal(0, 1, size=(12_000, 2)).astype(np.float32)

    from sklearn.neighbors import KDTree

    resolved = resolve_cluster_eps(coords, 50.0)  # every point sees every other
    pairs = int(KDTree(coords).query_radius(coords, r=resolved, count_only=True).sum())

    assert resolved < 50.0
    assert pairs <= MAX_NEIGHBOR_PAIRS


def test_pair_budget_leaves_a_reasonable_eps_alone():
    coords = blobs()
    assert resolve_cluster_eps(coords, 0.3) == pytest.approx(0.3)


# ---------------------------------------------------------------------------
# Album-level resolution and caching
# ---------------------------------------------------------------------------


def test_requested_beats_stored_beats_derived(tmp_path):
    coords = blobs()
    derived = resolve_album_cluster_eps(coords, tmp_path)

    assert resolve_album_cluster_eps(coords, tmp_path, requested=0.3) == pytest.approx(0.3)
    assert resolve_album_cluster_eps(coords, tmp_path, stored=0.4) == pytest.approx(0.4)
    assert resolve_album_cluster_eps(coords, tmp_path, requested=0.3, stored=0.4) == pytest.approx(0.3)
    assert resolve_album_cluster_eps(coords, tmp_path) == pytest.approx(derived)


def test_derived_value_is_cached_on_disk(tmp_path, monkeypatch):
    coords = blobs()
    first = cached_adaptive_cluster_eps(coords, tmp_path)
    assert (tmp_path / "umap_eps_auto.npz").exists()

    def _boom(*args, **kwargs):
        raise AssertionError("recomputed despite a warm cache")

    monkeypatch.setattr("photomap.backend.cluster_eps.resolve_cluster_eps", _boom)
    assert cached_adaptive_cluster_eps(coords, tmp_path) == pytest.approx(first)


def test_cache_is_keyed_on_the_coordinates(tmp_path):
    """A re-index writes new coordinates to the same path. Serving the old
    value would cluster the new map at the old scale."""
    first = cached_adaptive_cluster_eps(blobs(scale=1.0), tmp_path)
    second = cached_adaptive_cluster_eps(blobs(scale=50.0), tmp_path)
    assert second != pytest.approx(first)


def test_cache_is_keyed_on_min_samples(tmp_path):
    coords = blobs(n_per_blob=60)
    assert cached_adaptive_cluster_eps(coords, tmp_path, min_samples=5) != pytest.approx(
        cached_adaptive_cluster_eps(coords, tmp_path, min_samples=25)
    )


def test_unreadable_cache_is_ignored_not_fatal(tmp_path):
    (tmp_path / "umap_eps_auto.npz").write_bytes(b"not an npz")
    assert cached_adaptive_cluster_eps(blobs(), tmp_path) > 0


def test_unwritable_cache_dir_still_returns_a_value(tmp_path, monkeypatch):
    """Caching is an optimization; losing it must not lose the feature."""
    monkeypatch.setattr(
        "photomap.backend.cluster_eps.atomic_savez",
        lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")),
    )
    assert cached_adaptive_cluster_eps(blobs(), Path(tmp_path)) > 0


def test_spinner_min_matches_the_floor_the_server_enforces():
    """The Cluster Strength spinner refuses what the server would floor.

    The frontend reads its floor off the input's own ``min`` attribute rather
    than hardcoding a number, so the two can only drift here — and drifting
    means either the spinner accepts a value the map then clusters at
    something else, or it refuses one the server would have honored.
    """
    template = (
        Path(__file__).parent.parent.parent
        / "photomap"
        / "frontend"
        / "templates"
        / "modules"
        / "umap-floating-window.html"
    ).read_text(encoding="utf-8")
    spinner = template[template.index('id="umapEpsSpinner"') :]
    spinner = spinner[: spinner.index(">")]
    match = re.search(r'min="([^"]+)"', spinner)
    assert match, "the Cluster Strength spinner has lost its min attribute"
    assert float(match.group(1)) == pytest.approx(MIN_CLUSTER_EPS)
