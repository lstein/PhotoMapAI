"""Cluster auto-labeling — vocabulary loading and embedding cache.

Loads `cluster_vocab.txt` (bundled in `photomap.backend.data`) and embeds each
phrase through the project's pluggable text encoder, with prompt-template
ensembling for label quality. Embeddings are cached per encoder under the
user cache dir so multiple albums sharing an encoder reuse the same vectors.

Cluster-label computation itself (centroids, DBSCAN re-clustering, scoring)
lives in this module too — see the second half once the next checkpoint lands.
"""

import importlib.resources
import logging
from pathlib import Path

import numpy as np
from platformdirs import user_cache_dir

from .encoders import get_cached_encoder

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
