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

import importlib.resources
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from platformdirs import user_cache_dir
from sklearn.cluster import DBSCAN

from .encoders import get_cached_encoder

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

# Phrases per encoder batch — each call encodes phrases * len(PROMPT_TEMPLATES)
# strings. 128 * 7 ≈ 900 texts per batch, which fits comfortably on a single GPU.
VOCAB_BATCH_PHRASES = 128


def vocab_file_path() -> Path:
    """Filesystem path to the bundled `cluster_vocab.txt`."""
    resource = importlib.resources.files(VOCAB_PACKAGE) / VOCAB_FILENAME
    return Path(str(resource))


def load_vocab_phrases(path: Path | None = None) -> list[str]:
    """Read `cluster_vocab.txt`, return deduped non-empty non-comment phrases."""
    target = path or vocab_file_path()
    seen: set[str] = set()
    out: list[str] = []
    for raw in target.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        norm = line.lower()
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
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


def _encode_phrases_ensembled(encoder, phrases: list[str]) -> np.ndarray:
    """Encode each phrase as the L2-normalized mean of its template variants."""
    if not phrases:
        return np.zeros((0, encoder.embedding_dim), dtype=np.float32)

    n_templates = len(PROMPT_TEMPLATES)
    out = np.zeros((len(phrases), encoder.embedding_dim), dtype=np.float32)
    for start in range(0, len(phrases), VOCAB_BATCH_PHRASES):
        chunk = phrases[start : start + VOCAB_BATCH_PHRASES]
        expanded = [tpl.format(p) for p in chunk for tpl in PROMPT_TEMPLATES]
        # encode_text returns (len(expanded), D), already L2-normalized per row.
        feats = encoder.encode_text(expanded)
        pooled = feats.reshape(len(chunk), n_templates, -1).mean(axis=1)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        norms = np.where(norms > 0, norms, 1.0)  # avoid div-by-zero on a zero row
        out[start : start + len(chunk)] = (pooled / norms).astype(np.float32)
    return out


def _read_cached_vocab(
    cache_path: Path,
    vocab_path: Path,
    encoder_spec: str,
) -> tuple[list[str], np.ndarray] | None:
    """Return cached (phrases, embeddings) if valid, else None to signal rebuild."""
    if not cache_path.exists():
        return None
    if cache_path.stat().st_mtime < vocab_path.stat().st_mtime:
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
    - the bundled `cluster_vocab.txt` has been edited since the cache was written,
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
        "Vocab embeddings cached: %d phrases, dim=%d", len(phrases), embeddings.shape[1] if len(phrases) else 0
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


def _cluster_centroids(
    high_dim: np.ndarray, labels: np.ndarray, cluster_ids: list[int]
) -> np.ndarray:
    """Mean of each cluster's high-dim embeddings, L2-normalized. Shape: (C, D)."""
    centroids = np.zeros((len(cluster_ids), high_dim.shape[1]), dtype=np.float32)
    for i, cid in enumerate(cluster_ids):
        members = high_dim[labels == cid]
        mean = members.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm > 0:
            mean = mean / norm
        centroids[i] = mean.astype(np.float32)
    return centroids


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
    centroids = _cluster_centroids(high_dim, labels, cluster_ids)

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
        }
    return out


def _read_cached_labels(
    cache_path: Path, umap_path: Path, embeddings_path: Path
) -> dict[int, dict] | None:
    """Return cached labels if newer than both UMAP and source embeddings, else None."""
    if not cache_path.exists():
        return None
    cache_mtime = cache_path.stat().st_mtime
    if umap_path.exists() and cache_mtime < umap_path.stat().st_mtime:
        return None
    if cache_mtime < embeddings_path.stat().st_mtime:
        return None
    try:
        data = np.load(cache_path, allow_pickle=False)
        cluster_ids = [int(c) for c in data["cluster_ids"]]
        labels = [str(x) for x in data["labels"]]
        alternates_arr = data["alternates"]
        scores = [float(s) for s in data["scores"]]
    except (OSError, KeyError, ValueError) as err:
        logger.warning("Labels cache at %s unreadable (%s); will rebuild", cache_path, err)
        return None

    out: dict[int, dict] = {}
    for i, cid in enumerate(cluster_ids):
        row = alternates_arr[i] if alternates_arr.ndim == 2 else []
        # Filter padding empty strings introduced during save.
        alts = [str(x) for x in row if str(x) != ""]
        out[cid] = {"label": labels[i], "alternates": alts, "score": scores[i]}
    return out


def _save_labels(cache_path: Path, labels_dict: dict[int, dict]) -> None:
    """Write the labels dict to `cache_path` atomically via .tmp rename."""
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not labels_dict:
        ids_arr = np.array([], dtype=np.int32)
        labels_arr = np.array([], dtype="U1")
        alternates_arr = np.zeros((0, 0), dtype="U1")
        scores_arr = np.array([], dtype=np.float32)
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

    tmp_path = cache_path.with_name(cache_path.name + ".tmp")
    with tmp_path.open("wb") as fh:
        np.savez(
            fh,
            cluster_ids=ids_arr,
            labels=labels_arr,
            alternates=alternates_arr,
            scores=scores_arr,
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
