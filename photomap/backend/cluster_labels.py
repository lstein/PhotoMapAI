"""Cluster auto-labeling — vocabulary cache and per-album label computation.

Loads `cluster_vocab.txt` (bundled in `photomap.backend.data`) and embeds each
phrase through the project's pluggable text encoder, with prompt-template
ensembling for label quality. Embeddings are cached per encoder under the
user cache dir so multiple albums sharing an encoder reuse the same vectors.

`compute_cluster_labels` re-runs DBSCAN on the album's cached UMAP coordinates
(same params as the /umap_data router so cluster IDs match), computes each
cluster's high-dim CLIP centroid, and scores it against the vocabulary in one
matrix multiply. Results are cached next to `umap.npz`, keyed by `(eps,
min_samples)` since cluster IDs are unstable across both UMAP regeneration
and DBSCAN parameter changes.
"""

from __future__ import annotations

import hashlib
import importlib.resources
import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from platformdirs import user_cache_dir, user_config_dir
from sklearn.cluster import DBSCAN

from .encoders import get_cached_encoder
from .util import BoundedLRU, is_cuda_oom

if TYPE_CHECKING:
    from .embeddings import Embeddings

logger = logging.getLogger(__name__)

# Prompt-template ensemble for text encoding. Each vocabulary phrase is encoded
# through every template, the per-template embeddings are L2-normalized, then
# mean-pooled and re-normalized — standard zero-shot CLIP recipe. The mix is
# photo-heavy (PhotoMapAI's dominant content) but keeps a few non-photo
# templates so AI-generated drawings/paintings score reasonably too.
PROMPT_TEMPLATES: tuple[str, ...] = (
    "a photo of a {}",
    "a photo of the {}",
    "a picture of {}",
    "an image of {}",
    "a drawing of {}",
    "a painting of {}",
    "{}",
)

VOCAB_PACKAGE = "photomap.backend.data"
VOCAB_FILENAME = "cluster_vocab.txt"

# User-editable vocabulary file in the platform config dir (sibling of
# config.yaml). Optional — when present, its phrases are unioned with the
# bundled vocab. This is the recommended place for hand-curated additions for
# users who installed via pip and don't have a checkout of the source tree.
USER_VOCAB_FILENAME = "cluster_vocab_extra.txt"

# Phrases per encoder batch. Each batch encodes `phrases * len(PROMPT_TEMPLATES)`
# strings — for SigLIP-large at max_length=64, batch=32 means ~1 GiB of forward
# activations, which fits even on a 16 GiB GPU shared with other workloads.
# Was 128 before; that produced ~4 GiB activations and OOM'd on repeated calls
# because PyTorch's allocator fragments between forward passes. We also retry
# with a halved batch in `_encode_phrases_ensembled` if an OOM slips through.
VOCAB_BATCH_PHRASES = 32


# Single-flight guard for vocab cache builds. Both /cluster_labels and
# /image_label dispatch through `asyncio.to_thread`, so concurrent FastAPI
# requests run `get_or_build_vocab_embeddings` in independent worker threads.
# On a cold cache, every caller would otherwise re-load the encoder and
# re-encode the full vocabulary before the first writer's atomic rename
# lands. Per-encoder locks let unrelated specs build in parallel.
_VOCAB_BUILD_LOCKS_MUTEX = threading.Lock()
_VOCAB_BUILD_LOCKS: dict[str, threading.Lock] = {}


def _vocab_build_lock(encoder_spec: str) -> threading.Lock:
    with _VOCAB_BUILD_LOCKS_MUTEX:
        lock = _VOCAB_BUILD_LOCKS.get(encoder_spec)
        if lock is None:
            lock = threading.Lock()
            _VOCAB_BUILD_LOCKS[encoder_spec] = lock
        return lock


def vocab_file_path() -> Path:
    """Filesystem path to the bundled `cluster_vocab.txt`."""
    resource = importlib.resources.files(VOCAB_PACKAGE) / VOCAB_FILENAME
    return Path(str(resource))


def user_vocab_file_path() -> Path:
    """Filesystem path to the user-editable extra vocab file.

    Lives next to `config.yaml` under `platformdirs.user_config_dir`. May not
    exist — callers must handle that case. We never auto-create it; absence is
    the natural "no user additions" state.
    """
    return Path(user_config_dir("photomap", "photomap")) / USER_VOCAB_FILENAME


def _read_vocab_file(path: Path) -> list[str]:
    """Lowercase, strip, drop blanks and `#` comments. Does NOT dedupe."""
    out: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line.lower())
    return out


def load_vocab_phrases(
    path: Path | None = None,
    user_path: Path | None = None,
) -> list[str]:
    """Return deduped phrases from the bundled vocab plus any user extras.

    `path` overrides the bundled vocab location; `user_path` overrides the
    user file location. Defaults read both standard locations; the user file
    is optional and silently skipped when absent.
    """
    target = path or vocab_file_path()
    user_target = user_path or user_vocab_file_path()

    phrases = _read_vocab_file(target)
    if user_target.exists():
        phrases.extend(_read_vocab_file(user_target))

    seen: set[str] = set()
    out: list[str] = []
    for p in phrases:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _sanitize_spec(spec: str) -> str:
    """Encoder spec → filesystem-safe filename stem."""
    return spec.replace("/", "__").replace(":", "__")


def vocab_cache_path(encoder_spec: str) -> Path:
    """Filesystem path to the vocab embeddings cache for a given encoder spec.

    Cross-platform: uses `platformdirs.user_cache_dir` so the cache lives under
    `~/.cache/photomap/cluster_vocab/` on Linux, `~/Library/Caches/photomap/`
    on macOS, and `%LOCALAPPDATA%\\photomap\\Cache\\` on Windows.
    """
    base = Path(user_cache_dir("photomap", "photomap")) / "cluster_vocab"
    return base / f"{_sanitize_spec(encoder_spec)}.npz"


def _try_cuda_empty_cache() -> None:
    """Defragment torch's CUDA allocator if torch+CUDA are available, else no-op."""
    try:
        import torch
    except ImportError:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _encode_phrases_ensembled(encoder, phrases: list[str]) -> np.ndarray:
    """Encode each phrase as the L2-normalized mean of its template variants.

    Adaptively halves the batch size when a CUDA OOM is raised — vocab building
    is a hot spot for OOM with large text encoders (SigLIP-large at batch=128
    can need ~4 GiB of activation memory per forward), and PyTorch's allocator
    fragments across repeated calls.
    """
    if not phrases:
        return np.zeros((0, encoder.embedding_dim), dtype=np.float32)

    # Defragment before we start — earlier calls may have left the allocator
    # holding blocks too small to satisfy the activation tensors we need.
    _try_cuda_empty_cache()

    n_templates = len(PROMPT_TEMPLATES)
    out = np.zeros((len(phrases), encoder.embedding_dim), dtype=np.float32)
    current_batch = VOCAB_BATCH_PHRASES
    start = 0
    while start < len(phrases):
        chunk = phrases[start : start + current_batch]
        expanded = [tpl.format(p) for p in chunk for tpl in PROMPT_TEMPLATES]
        try:
            # encode_text returns (len(expanded), D), already L2-normalized per row.
            feats = encoder.encode_text(expanded)
        except Exception as err:
            if not is_cuda_oom(err) or current_batch <= 1:
                raise
            new_batch = max(1, current_batch // 2)
            logger.warning(
                "Vocab encode hit CUDA OOM at batch=%d; retrying at batch=%d",
                current_batch,
                new_batch,
            )
            _try_cuda_empty_cache()
            current_batch = new_batch
            continue  # same start, smaller chunk on next loop

        pooled = feats.reshape(len(chunk), n_templates, -1).mean(axis=1)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        norms = np.where(norms > 0, norms, 1.0)  # avoid div-by-zero on a zero row
        out[start : start + len(chunk)] = (pooled / norms).astype(np.float32)
        start += len(chunk)

    # Release activation memory back to the allocator pool so it's available to
    # the next caller (label compute, search query, etc.) without growing total
    # process VRAM.
    _try_cuda_empty_cache()
    return out


def _vocab_sources_max_mtime(vocab_path: Path) -> float:
    """Max mtime across the bundled vocab and (if present) the user extras file."""
    mtimes = [vocab_path.stat().st_mtime]
    user_path = user_vocab_file_path()
    if user_path.exists():
        mtimes.append(user_path.stat().st_mtime)
    return max(mtimes)


def vocab_fingerprint(phrases: list[str] | None = None) -> str:
    """Stable hash of the loaded phrase set.

    Why: mtime-only invalidation can't detect when the user extras file is
    deleted or renamed — the bundled vocab's mtime is unchanged, so the cache
    looks fresh while the phrase list has actually shrunk. Comparing a content
    fingerprint catches add/remove/rename regardless of mtime direction.
    """
    if phrases is None:
        phrases = load_vocab_phrases()
    h = hashlib.sha256()
    for p in sorted(set(phrases)):
        h.update(p.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def _read_cached_vocab(
    cache_path: Path,
    vocab_path: Path,
    encoder_spec: str,
) -> tuple[list[str], np.ndarray] | None:
    """Return cached (phrases, embeddings) if valid, else None to signal rebuild."""
    if not cache_path.exists():
        return None
    if cache_path.stat().st_mtime < _vocab_sources_max_mtime(vocab_path):
        return None
    try:
        data = np.load(cache_path, allow_pickle=False)
        stored_spec = str(data["encoder_spec"])
        stored_templates = int(data["n_templates"])
    except (OSError, KeyError, ValueError) as err:
        logger.warning("Vocab cache at %s unreadable (%s); will rebuild", cache_path, err)
        return None
    if stored_spec != encoder_spec:
        logger.info(
            "Vocab cache encoder mismatch (stored=%s, requested=%s); will rebuild",
            stored_spec,
            encoder_spec,
        )
        return None
    if stored_templates != len(PROMPT_TEMPLATES):
        logger.info(
            "Vocab cache template count mismatch (stored=%d, current=%d); will rebuild",
            stored_templates,
            len(PROMPT_TEMPLATES),
        )
        return None
    phrases = [str(p) for p in data["phrases"]]
    # Mtime check above can miss two cases:
    #   - User extras file deleted/renamed: bundled mtime stays the same, but
    #     the phrase set just shrank.
    #   - User extras file added back with an mtime older than the cache.
    # Compare actual phrase sets to catch both.
    current_phrases = load_vocab_phrases(vocab_path)
    if set(phrases) != set(current_phrases):
        logger.info(
            "Vocab cache phrase set changed (cached=%d, current=%d); will rebuild",
            len(phrases),
            len(current_phrases),
        )
        return None
    embeddings = np.asarray(data["embeddings"], dtype=np.float32)
    return phrases, embeddings


def get_or_build_vocab_embeddings(
    encoder_spec: str,
    *,
    cache_dir: str | None = None,
) -> tuple[list[str], np.ndarray]:
    """Load or build the vocab embeddings cache for `encoder_spec`.

    Returns `(phrases, embeddings)` where `embeddings` is `(N, D)` float32 and
    L2-normalized after template-ensemble mean-pooling. The cache rebuilds when:

    - the file is missing,
    - either vocab source file has been edited since the cache was written,
    - the stored phrase set differs from what's on disk now (catches user
      extras file deletion/rename, which mtime alone misses),
    - the stamped encoder spec doesn't match (defensive against filename collisions),
    - `len(PROMPT_TEMPLATES)` has changed since the cache was written.

    `cache_dir` is forwarded to `get_cached_encoder` to point at the album's
    preferred model-weight cache (only meaningful on a cold first build).
    """
    vocab_path = vocab_file_path()
    cache_path = vocab_cache_path(encoder_spec)

    cached = _read_cached_vocab(cache_path, vocab_path, encoder_spec)
    if cached is not None:
        return cached

    # Serialize concurrent builds for the same encoder. Re-check inside the
    # lock so the second waiter picks up the first builder's atomic rename
    # instead of redundantly re-encoding the full vocabulary.
    with _vocab_build_lock(encoder_spec):
        cached = _read_cached_vocab(cache_path, vocab_path, encoder_spec)
        if cached is not None:
            return cached

        logger.info("Building vocab embeddings cache at %s", cache_path)
        phrases = load_vocab_phrases(vocab_path)
        encoder = get_cached_encoder(encoder_spec, cache_dir=cache_dir)
        embeddings = _encode_phrases_ensembled(encoder, phrases)

        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = cache_path.with_name(cache_path.name + ".tmp")
        # Open via file handle so numpy doesn't second-guess the suffix.
        with tmp_path.open("wb") as fh:
            np.savez(
                fh,
                encoder_spec=np.array(encoder_spec),
                n_templates=np.array(len(PROMPT_TEMPLATES)),
                phrases=np.array(phrases),
                embeddings=embeddings,
            )
        tmp_path.replace(cache_path)
        logger.info(
            "Vocab embeddings cached: %d phrases, dim=%d",
            len(phrases),
            embeddings.shape[1] if len(phrases) else 0,
        )
        return phrases, embeddings


# ---------------------------------------------------------------------------
# Per-album cluster label computation
# ---------------------------------------------------------------------------


def labels_cache_path(
    embeddings: Embeddings, cluster_eps: float, cluster_min_samples: int
) -> Path:
    """Where the per-album label cache lives — next to `umap.npz`.

    Filename embeds `(eps, min_samples)` because DBSCAN cluster IDs are
    unstable across both UMAP regeneration and parameter changes, so each
    parameter combination gets its own cache file.
    """
    return (
        embeddings.embeddings_path.parent
        / f"cluster_labels_eps{cluster_eps:g}_ms{cluster_min_samples}.npz"
    )


def _cluster_centroids_and_medoids(
    high_dim: np.ndarray,
    labels: np.ndarray,
    cluster_ids: list[int],
    filenames: np.ndarray,
    filename_map: dict[str, int],
) -> tuple[np.ndarray, np.ndarray]:
    """Per cluster: L2-normalized centroid, and the sorted-frame index of the medoid.

    The medoid is the real cluster member whose high-dim embedding has the
    highest cosine similarity to the cluster centroid — i.e. the most
    representative image in the cluster. Indices are returned in the same
    coordinate system the frontend uses (``filename_map`` lookup), so the
    frontend can pass them directly to ``thumbnails/{album}/{index}``.
    """
    centroids = np.zeros((len(cluster_ids), high_dim.shape[1]), dtype=np.float32)
    medoid_indices = np.zeros(len(cluster_ids), dtype=np.int32)
    for i, cid in enumerate(cluster_ids):
        member_mask = labels == cid
        members = high_dim[member_mask]
        mean = members.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm > 0:
            mean = mean / norm
        centroids[i] = mean.astype(np.float32)
        # Pick the medoid: argmax of cosine sim to the centroid. Both sides are
        # L2-normalized, so a dot product is the cosine.
        sims = members @ mean
        member_raw_indices = np.where(member_mask)[0]
        medoid_raw_idx = int(member_raw_indices[int(np.argmax(sims))])
        medoid_indices[i] = int(filename_map[filenames[medoid_raw_idx]])
    return centroids, medoid_indices


def compute_cluster_labels(
    embeddings: Embeddings,
    *,
    cluster_eps: float,
    cluster_min_samples: int,
    top_k: int = 3,
) -> dict[int, dict]:
    """Compute top-k vocabulary labels for every non-noise DBSCAN cluster.

    Returns a mapping `{cluster_id: {"label": str, "alternates": list[str],
    "score": float}}` where `alternates` has length `top_k - 1` and `score`
    is the cosine similarity of the cluster centroid to the chosen label.
    Cluster `-1` (DBSCAN noise) is omitted.
    """
    umap_coords = embeddings.umap_embeddings
    if umap_coords.shape[0] == 0:
        return {}

    labels = (
        DBSCAN(eps=cluster_eps, min_samples=cluster_min_samples)
        .fit(umap_coords)
        .labels_
    )
    cluster_ids = sorted({int(c) for c in labels if c != -1})
    if not cluster_ids:
        return {}

    phrases, vocab_emb = get_or_build_vocab_embeddings(
        embeddings.encoder_spec, cache_dir=embeddings._clip_root()
    )
    if not phrases:
        return {}

    cached = embeddings.open_cached_embeddings(embeddings.embeddings_path)
    high_dim = cached["embeddings"]
    centroids, medoid_indices = _cluster_centroids_and_medoids(
        high_dim, labels, cluster_ids, cached["filenames"], cached["filename_map"]
    )

    scores = centroids @ vocab_emb.T  # (C, V)
    k = min(top_k, len(phrases))
    # argsort is fine — vocab is ~2-3k, cluster count is ~1k; this is milliseconds.
    top_idx = np.argsort(-scores, axis=1)[:, :k]

    out: dict[int, dict] = {}
    for i, cid in enumerate(cluster_ids):
        top_phrases = [phrases[int(j)] for j in top_idx[i]]
        out[cid] = {
            "label": top_phrases[0],
            "alternates": top_phrases[1:],
            "score": float(scores[i, int(top_idx[i, 0])]),
            "medoid_index": int(medoid_indices[i]),
        }
    return out


def _read_cached_labels(
    cache_path: Path, umap_path: Path, embeddings_path: Path
) -> dict[int, dict] | None:
    """Return cached labels if newer than UMAP, source embeddings, and vocab, else None."""
    if not cache_path.exists():
        return None
    cache_mtime = cache_path.stat().st_mtime
    if umap_path.exists() and cache_mtime < umap_path.stat().st_mtime:
        return None
    if cache_mtime < embeddings_path.stat().st_mtime:
        return None
    # Vocab edits change the candidate label strings (and, indirectly, the chosen
    # top-1 once vocab embeddings rebuild). Without this check, a vocab refresh
    # would silently leave every album's labels stale until the album reindexes.
    # Both the bundled vocab and the user extras file count as sources.
    vocab_path = vocab_file_path()
    if vocab_path.exists() and cache_mtime < _vocab_sources_max_mtime(vocab_path):
        return None
    try:
        data = np.load(cache_path, allow_pickle=False)
        cluster_ids = [int(c) for c in data["cluster_ids"]]
        labels = [str(x) for x in data["labels"]]
        alternates_arr = data["alternates"]
        scores = [float(s) for s in data["scores"]]
        # Medoid array was added later; older caches omit it.
        medoids = (
            [int(m) for m in data["medoids"]] if "medoids" in data.files else [None] * len(cluster_ids)
        )
        # Vocab fingerprint was added to catch phrase-set changes the mtime
        # check misses (e.g., the user extras file was deleted). Legacy caches
        # written before the fingerprint existed could be silently stale, so
        # we force a one-time rebuild on encounter — after that, all caches
        # are stamped.
        stored_fingerprint = str(data["vocab_fingerprint"]) if "vocab_fingerprint" in data.files else None
    except (OSError, KeyError, ValueError) as err:
        logger.warning("Labels cache at %s unreadable (%s); will rebuild", cache_path, err)
        return None
    if stored_fingerprint is None:
        logger.info("Labels cache missing vocab fingerprint (pre-upgrade file); will rebuild")
        return None
    if stored_fingerprint != vocab_fingerprint():
        logger.info("Labels cache vocab fingerprint changed; will rebuild")
        return None

    out: dict[int, dict] = {}
    for i, cid in enumerate(cluster_ids):
        row = alternates_arr[i] if alternates_arr.ndim == 2 else []
        # Filter padding empty strings introduced during save.
        alts = [str(x) for x in row if str(x) != ""]
        entry: dict = {"label": labels[i], "alternates": alts, "score": scores[i]}
        # -1 sentinel marks "no medoid known" — drop it so the frontend can apply its fallback.
        if medoids[i] is not None and medoids[i] >= 0:
            entry["medoid_index"] = medoids[i]
        out[cid] = entry
    return out


def _save_labels(cache_path: Path, labels_dict: dict[int, dict]) -> None:
    """Write the labels dict to `cache_path` atomically via .tmp rename."""
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not labels_dict:
        ids_arr = np.array([], dtype=np.int32)
        labels_arr = np.array([], dtype="U1")
        alternates_arr = np.zeros((0, 0), dtype="U1")
        scores_arr = np.array([], dtype=np.float32)
        medoids_arr = np.array([], dtype=np.int32)
    else:
        cids = sorted(labels_dict.keys())
        ids_arr = np.array(cids, dtype=np.int32)
        labels_arr = np.array([labels_dict[c]["label"] for c in cids])
        max_alt = max(len(labels_dict[c]["alternates"]) for c in cids)
        alternates_arr = np.array(
            [
                labels_dict[c]["alternates"]
                + [""] * (max_alt - len(labels_dict[c]["alternates"]))
                for c in cids
            ]
        )
        scores_arr = np.array([labels_dict[c]["score"] for c in cids], dtype=np.float32)
        # medoid_index may be absent for back-compat reads; sentinel -1 marks "unknown".
        medoids_arr = np.array(
            [labels_dict[c].get("medoid_index", -1) for c in cids], dtype=np.int32
        )

    tmp_path = cache_path.with_name(cache_path.name + ".tmp")
    with tmp_path.open("wb") as fh:
        np.savez(
            fh,
            cluster_ids=ids_arr,
            labels=labels_arr,
            alternates=alternates_arr,
            scores=scores_arr,
            medoids=medoids_arr,
            vocab_fingerprint=np.array(vocab_fingerprint()),
        )
    tmp_path.replace(cache_path)


def get_or_build_cluster_labels(
    embeddings: Embeddings,
    *,
    cluster_eps: float,
    cluster_min_samples: int,
    top_k: int = 3,
) -> dict[int, dict]:
    """Cache-aware wrapper for `compute_cluster_labels`.

    Cache invalidates when the file is missing, or when its mtime is older
    than either `umap.npz` or the source `.npz` embeddings file. Cluster IDs
    are not stable across either kind of regeneration, so the labels must be
    recomputed.
    """
    cache_path = labels_cache_path(embeddings, cluster_eps, cluster_min_samples)
    umap_path = embeddings.embeddings_path.parent / "umap.npz"

    cached = _read_cached_labels(cache_path, umap_path, embeddings.embeddings_path)
    if cached is not None:
        return cached

    result = compute_cluster_labels(
        embeddings,
        cluster_eps=cluster_eps,
        cluster_min_samples=cluster_min_samples,
        top_k=top_k,
    )
    _save_labels(cache_path, result)
    return result


# ---------------------------------------------------------------------------
# Per-image labels (lazy, used by the metadata drawer)
# ---------------------------------------------------------------------------

# Bounded in-memory LRU. Per-image scoring is microseconds (one vector dot the
# vocab matrix, ~1M FLOPs), but we still cache because the frontend re-opens
# the drawer for the same image often during navigation. The cache key carries
# the embeddings .npz mtime AND the vocab mtime so that re-indexing the album
# (which can change which raw row corresponds to a given sorted_index) and
# vocab edits both invalidate stale entries — the previous version omitted the
# npz mtime and could serve stale labels until the vocab was touched.
_IMAGE_LABEL_CACHE: BoundedLRU[tuple, dict] = BoundedLRU(maxsize=1024)


def compute_image_label(
    embeddings: Embeddings,
    sorted_index: int,
    *,
    top_k: int = 3,
) -> dict:
    """Score a single image's embedding against the vocabulary.

    `sorted_index` is the frontend-facing index (mtime-sorted order, same as
    the one /umap_data and /retrieve_image use). Returns `{label, alternates,
    score}` or `{}` when no vocab is available or the index is out of bounds.
    Cached in-process by (embeddings_path, sorted_index, vocab_mtime).
    """
    cached = embeddings.open_cached_embeddings(embeddings.embeddings_path)
    sorted_filenames = cached["sorted_filenames"]
    if sorted_index < 0 or sorted_index >= len(sorted_filenames):
        return {}

    vocab_path = vocab_file_path()
    vocab_mtime = _vocab_sources_max_mtime(vocab_path) if vocab_path.exists() else 0.0
    try:
        npz_mtime = embeddings.embeddings_path.stat().st_mtime
    except OSError:
        npz_mtime = 0.0
    cache_key = (
        str(embeddings.embeddings_path),
        int(sorted_index),
        npz_mtime,
        vocab_mtime,
    )
    hit = _IMAGE_LABEL_CACHE.get(cache_key)
    if hit is not None:
        return hit

    phrases, vocab_emb = get_or_build_vocab_embeddings(
        embeddings.encoder_spec, cache_dir=embeddings._clip_root()
    )
    if not phrases:
        return {}

    # sorted_index → raw row index in the .npz. The embeddings array is in raw
    # order (the order images were ingested); sorted_filenames[N] gives the
    # filename of the Nth slide, and the matching raw index is its position in
    # the unsorted filenames array.
    filename = sorted_filenames[sorted_index]
    filenames = cached["filenames"]
    raw_matches = np.where(filenames == filename)[0]
    if raw_matches.size == 0:
        return {}
    raw_idx = int(raw_matches[0])

    vec = cached["embeddings"][raw_idx].astype(np.float32)
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec = vec / norm

    scores = vec @ vocab_emb.T  # (V,)
    k = min(top_k, len(phrases))
    top_idx = np.argsort(-scores)[:k]
    top_phrases = [phrases[int(j)] for j in top_idx]
    result = {
        "label": top_phrases[0],
        "alternates": top_phrases[1:],
        "score": float(scores[int(top_idx[0])]),
    }
    _IMAGE_LABEL_CACHE.put(cache_key, result)
    return result
