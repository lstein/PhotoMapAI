"""
embeddings.py

Implement image indexing and searching using a pluggable image/text encoder.
The encoder is selected via an ``encoder_spec`` string and built through
:func:`photomap.backend.encoders.build_encoder`. Defaults preserve the legacy
OpenAI CLIP ``ViT-B/32`` behavior.
"""

import asyncio
import functools
import gc
import logging
import os
import sys
import warnings
from collections import deque
from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, NamedTuple

import networkx as nx
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from pydantic import BaseModel
from sklearn.cluster import MiniBatchKMeans
from sklearn.neighbors import NearestNeighbors
from tqdm import tqdm
from umap import UMAP

from .encoders import (
    LEGACY_ENCODER_SPEC,
    EmbeddingCacheMismatch,
    ImageTextEncoder,
    build_encoder,
    get_cached_encoder,
)
from .metadata_extraction import MetadataExtractor
from .metadata_formatting import format_metadata
from .metadata_modules import SlideSummary
from .progress import IndexingCancelled, progress_tracker
from .util import atomic_savez

logger = logging.getLogger(__name__)

# Production indexing pipeline defaults. Tuned via benchmark_encoders.py:
# batch_size=8 saturates GPU on all three bundled encoders, num_workers=4
# keeps it fed without hitting the GIL-contention regression seen at 8.
DEFAULT_BATCH_SIZE = 8
DEFAULT_NUM_WORKERS = 4

# Process-wide gate around the GPU-using portion of indexing. Two concurrent
# albums each spinning up a CLIP/SigLIP encoder will OOM a typical 8-12 GiB
# card; this serializes them so the second album waits its turn. Created
# lazily on first use because asyncio.Semaphore wants a running event loop
# (the module imports cleanly into CLI tools that never start one).
_indexing_semaphore: asyncio.Semaphore | None = None


def _get_indexing_semaphore() -> asyncio.Semaphore:
    global _indexing_semaphore
    if _indexing_semaphore is None:
        _indexing_semaphore = asyncio.Semaphore(1)
    return _indexing_semaphore


def _l2_normalize(x: np.ndarray, axis: int = -1, eps: float = 1e-12) -> np.ndarray:
    """L2-normalize ``x`` along ``axis`` with an epsilon guard against zero vectors.

    Several call sites previously open-coded ``x / (norm + 1e-10)`` (or worse,
    no epsilon at all in ``find_duplicate_clusters``, which would NaN on any
    all-zero embedding). Funneling through one helper makes the epsilon
    consistent and the intent obvious.
    """
    norms = np.linalg.norm(x, axis=axis, keepdims=True)
    return x / (norms + eps)


def _normalized_filtered_embeddings(
    embeddings_path: Path,
    ignore_indices: list[int] | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Open the .npz, drop ``ignore_indices``, and L2-normalize the survivors.

    Returns ``(normalized_vectors, valid_global_indices, filenames)``. When
    every row is masked out, ``normalized_vectors`` is empty (shape ``(0,)``)
    and the caller is expected to return early.
    """
    data = _open_npz_file(embeddings_path)
    embeddings = data["embeddings"]
    filenames = data["filenames"]

    valid_mask = np.ones(len(embeddings), dtype=bool)
    if ignore_indices:
        valid_mask[ignore_indices] = False
    valid_global_indices = np.where(valid_mask)[0]
    filtered = embeddings[valid_global_indices]

    if len(filtered) == 0:
        return filtered, valid_global_indices, filenames

    return _l2_normalize(filtered, axis=1), valid_global_indices, filenames


register_heif_opener()  # Register HEIF opener for PIL
SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".gif",
    ".webp",
    ".tiff",
    ".heif",
    ".heic",
}


# =========================================================================
# FPS with Exclusion Support
# =========================================================================
def get_fps_indices_global(
    embeddings_path: Path,
    n_target: int,
    seed: int = 42,
    ignore_indices: list[int] = None,
) -> list[str]:
    """
    Select indices using Farthest Point Sampling to maximize diversity.

    Args:
        embeddings_path: Path to the .npz embeddings file.
        n_target: Number of images to select.
        seed: Random seed for reproducibility.
        ignore_indices: List of global indices to ignore/exclude.

    Returns:
        List of selected filenames.
    """
    vectors, valid_global_indices, filenames = _normalized_filtered_embeddings(
        embeddings_path, ignore_indices
    )
    n_samples = len(vectors)
    if n_samples == 0:
        return []
    if n_target >= n_samples:
        return filenames[valid_global_indices].tolist()

    # Standard FPS Logic on the FILTERED set
    rng = np.random.RandomState(seed)
    # Pick random index relative to the FILTERED set
    start_idx = rng.randint(0, n_samples)
    selected_local_indices = [start_idx]

    first_vector = vectors[start_idx].reshape(1, -1)
    min_dists = 1.0 - np.dot(vectors, first_vector.T).flatten()

    for _ in range(n_target - 1):
        next_idx = np.argmax(min_dists)
        selected_local_indices.append(next_idx)

        new_vector = vectors[next_idx].reshape(1, -1)
        dists_to_new = 1.0 - np.dot(vectors, new_vector.T).flatten()
        min_dists = np.minimum(min_dists, dists_to_new)

    # Map LOCAL filtered indices back to GLOBAL indices
    final_global_indices = valid_global_indices[selected_local_indices]

    return [filenames[i] for i in final_global_indices]


# =========================================================================
# K-Means with Exclusion Support
# =========================================================================
def get_kmeans_indices_global(
    embeddings_path: Path,
    n_target: int,
    seed: int = 42,
    ignore_indices: list[int] = None,
) -> list[str]:
    """
    Select indices using K-Means clustering to find representative images.

    Args:
        embeddings_path: Path to the .npz embeddings file.
        n_target: Number of images to select.
        seed: Random seed for reproducibility.
        ignore_indices: List of global indices to ignore/exclude.

    Returns:
        List of selected filenames.
    """
    vectors, valid_global_indices, filenames = _normalized_filtered_embeddings(
        embeddings_path, ignore_indices
    )
    n_samples = len(vectors)
    if n_samples == 0:
        return []
    if n_target >= n_samples:
        return filenames[valid_global_indices].tolist()

    # MiniBatchKMeans + n_init=1 are ~300x faster than the previous
    # KMeans(n_init=10) on CLIP-dim embeddings with n_target in the hundreds
    # (measured: 682s -> 2s for n_target=200, n_samples=85k, dim=768) and
    # land within ~0.5% of the same inertia. The Monte Carlo outer loop in
    # ``_compute_curation`` already aggregates per-run variance via voting,
    # so the single init costs us nothing in result quality. sklearn's
    # default batch_size (1024) and max_iter (100) are well-tuned here —
    # the custom batch_size we tried first was measurably slower.
    kmeans = MiniBatchKMeans(
        n_clusters=n_target,
        random_state=seed,
        n_init=1,
    )
    labels = kmeans.fit_predict(vectors)

    # One vectorized distance pass beats a per-cluster ``np.linalg.norm`` —
    # same total work, no Python-level loop over centroids for the heavy bit.
    dist_to_assigned = np.linalg.norm(vectors - kmeans.cluster_centers_[labels], axis=1)

    selected_local_indices = []
    for i in range(n_target):
        cluster_indices = np.where(labels == i)[0]
        if len(cluster_indices) == 0:
            continue
        best_local_idx = cluster_indices[np.argmin(dist_to_assigned[cluster_indices])]
        selected_local_indices.append(best_local_idx)

    # Map back to global
    final_global_indices = valid_global_indices[selected_local_indices]
    return [filenames[i] for i in final_global_indices]


def peek_encoder_spec(embeddings_path: Path) -> str:
    """Return the encoder model_id stored in an .npz, without loading heavy arrays.

    Falls back to ``LEGACY_ENCODER_SPEC`` for caches that predate the encoder
    swap layer (the original CLIP was the only option then). Not cached: the
    underlying file may be rewritten after a re-index, and a stale read could
    mask an encoder swap.
    """
    embeddings_path = Path(embeddings_path)
    with np.load(embeddings_path, allow_pickle=True) as data:
        if "model_id" in data.files:
            return str(data["model_id"])
    return LEGACY_ENCODER_SPEC


@functools.lru_cache(maxsize=3)
def _open_npz_file(embeddings_path: Path) -> dict[str, Any]:
    """
    Global helper to open .npz files with caching.
    Uses context manager to ensure file handles are released.
    """
    embeddings_path = Path(embeddings_path).resolve()

    if not embeddings_path.exists():
        raise FileNotFoundError(f"Embeddings file {embeddings_path} does not exist.")

    # Use 'with' to ensure the file handle is closed
    with np.load(embeddings_path, allow_pickle=True) as data:
        filenames = data["filenames"].copy()
        raw_metadata = data["metadata"].copy()
        embeddings = data["embeddings"].copy()
        modification_times = data["modification_times"].copy()
        # Older caches predate the encoder swap layer; treat them as the legacy default.
        model_id = (
            str(data["model_id"])
            if "model_id" in data.files
            else LEGACY_ENCODER_SPEC
        )
        embedding_dim = (
            int(data["embedding_dim"])
            if "embedding_dim" in data.files
            else (int(embeddings.shape[1]) if embeddings.ndim == 2 and embeddings.size else 512)
        )

    # Pre-compute sorted order. ``np.lexsort`` is stable and uses ``filenames``
    # as a deterministic tiebreaker when modtimes collide (common: EXIF dates
    # are 1-second resolution, so bursts and batch copies tie). Plain
    # ``argsort`` defaults to quicksort, which is unstable — same data sorted
    # twice could yield different orders, silently invalidating any global
    # index a caller (bookmarks, back-stack, deletion) has held onto.
    sorted_indices = np.lexsort((filenames, modification_times))
    sorted_filenames = filenames[sorted_indices]
    filename_map = {fname: idx for idx, fname in enumerate(sorted_filenames)}

    return {
        "filenames": filenames,
        "metadata": raw_metadata,
        "embeddings": embeddings,
        "modification_times": modification_times,
        "sorted_modification_times": modification_times[sorted_indices],
        "sorted_filenames": sorted_filenames,
        "sorted_metadata": raw_metadata[sorted_indices],
        "filename_map": filename_map,
        "model_id": model_id,
        "embedding_dim": embedding_dim,
    }


class IndexResult(BaseModel):
    """
    Result of an indexing operation.
    Contains the embeddings, filenames, modification times, metadata, and any bad files encountered.
    """

    model_config = {"arbitrary_types_allowed": True}

    embeddings: np.ndarray
    umap_embeddings: np.ndarray | None = None  # UMAP embeddings, if created
    filenames: np.ndarray
    modification_times: np.ndarray
    metadata: np.ndarray
    bad_files: list[Path] = []
    # Default to the legacy spec because IndexResult.model_id is also the
    # value stamped into .npz files, and an unspecified value here typically
    # means we're constructing one from a legacy cache that has no model_id.
    model_id: str = LEGACY_ENCODER_SPEC
    embedding_dim: int = 512


class _ExistingIndex(NamedTuple):
    """Snapshot of the arrays loaded from a saved ``.npz`` index.

    Used by both ``update_index`` and ``update_index_async`` so the load +
    encoder-spec mismatch check lives in one place.
    """

    embeddings: np.ndarray
    filenames: np.ndarray
    modification_times: np.ndarray
    metadata: np.ndarray
    model_id: str
    embedding_dim: int


class Embeddings(BaseModel):
    """
    A class to handle image embeddings using CLIP.
    This class provides methods to index images, update embeddings, and search for similar images.
    """

    embeddings_path: Path = Path("clip_image_embeddings.npz")
    # Embeddings is normally constructed by the router with an explicit
    # encoder_spec from the album config. The default only applies when
    # callers (tests, scripts) instantiate it bare; in that case they're
    # almost certainly trying to read existing data, which on this codebase
    # means a legacy-CLIP cache.
    encoder_spec: str = LEGACY_ENCODER_SPEC
    # Minimum width AND height (in pixels) for an image to be indexed; smaller
    # images are treated as thumbnails and skipped during the scan. 256 is the
    # smallest patch grid the bundled CLIP/SigLIP variants encode without
    # heavy upscaling. Default mirrors the Album field default in config.py.
    min_image_dimension: int = 256

    def __init__(self, **data):
        """Ensure embeddings_path is always resolved to prevent cache key mismatches."""
        if "embeddings_path" in data:
            data["embeddings_path"] = Path(data["embeddings_path"]).resolve()
        super().__init__(**data)

    def _build_encoder(self) -> ImageTextEncoder:
        """Construct the encoder for this album from its spec."""
        return build_encoder(self.encoder_spec, cache_dir=self._clip_root())

    def _check_cache_compatibility(
        self, data: dict[str, Any], encoder: ImageTextEncoder
    ) -> None:
        """Raise EmbeddingCacheMismatch if the .npz was built with a different encoder."""
        stored = str(data.get("model_id", LEGACY_ENCODER_SPEC))
        if stored != encoder.model_id:
            raise EmbeddingCacheMismatch(
                stored, encoder.model_id, str(self.embeddings_path)
            )

    @staticmethod
    def _cleanup_cuda_memory(device: str) -> None:
        """
        Clean up CUDA memory by clearing cache and forcing garbage collection.

        This completely frees GPU VRAM to ensure it returns to zero (or minimal baseline)
        after operations. The model will need to be reloaded on subsequent operations,
        but this ensures GPU memory is available for other processes.

        Note: A baseline CUDA context (~188 MiB) may remain after first GPU use.
        This is a PyTorch/CUDA limitation and cannot be freed without ending the process.

        Args:
            device: The device string ("cuda" or "cpu")
        """
        if device == "cuda":
            try:
                # Synchronize to ensure all CUDA operations are complete
                torch.cuda.synchronize()
                # Empty the CUDA cache
                torch.cuda.empty_cache()
                # Force garbage collection to clean up Python references
                gc.collect()
                # Empty cache again after GC to catch any newly freed memory
                torch.cuda.empty_cache()
            except RuntimeError as e:
                # Log but don't crash if CUDA operations fail
                logger.warning(f"CUDA cleanup failed: {e}")

    def _passes_dimension_gate(self, path: Path) -> bool:
        """Return True if ``path``'s pixel dimensions are >= ``min_image_dimension``.

        Reads only the image header via ``Image.open(...).size`` — PIL does
        not decode pixels until they're accessed, so this is a few-KB read
        per file. Unreadable / corrupt files return False and are logged at
        debug level (they'd fail at encoding time anyway and would land in
        ``bad_files`` there; here we just keep the scan log quiet).
        """
        min_dim = self.min_image_dimension
        if min_dim <= 1:
            return True
        try:
            with Image.open(path) as im:
                width, height = im.size
        except Exception as e:
            logger.debug(f"Skipping unreadable image during scan: {path}: {e}")
            return False
        return width >= min_dim and height >= min_dim

    def get_image_files_from_directory(
        self,
        directory: Path,
        exts: set[str] = SUPPORTED_EXTENSIONS,
        progress_callback: Callable | None = None,
        update_interval: int = 100,
    ) -> list[Path]:
        """
        Recursively collect all image files from a directory.

        Each candidate file's header is opened to read pixel dimensions;
        images with either dimension below ``self.min_image_dimension`` are
        skipped. The header read is a few KB per file, so a scan of 10k
        files typically adds 10-30s on SSD — small next to encoding time.

        Args:
            directory: Directory to scan
            exts: File extensions to include
            progress_callback: Optional callback function(count, message) for progress updates
            update_interval: How often to call progress_callback (every N files found)
        """
        logger.info(f"Scanning directory {directory} for image files...")
        image_files = []
        files_checked = 0
        skipped_too_small = 0

        for root, dirs, files in os.walk(directory):
            # Remove 'photomap_index' from dirs so os.walk skips it and its subdirs
            dirs[:] = [d for d in dirs if d != "photomap_index"]
            for file in [Path(x) for x in files]:
                files_checked += 1

                if file.suffix.lower() not in exts:
                    continue
                full = Path(root, file)
                if self._passes_dimension_gate(full):
                    image_files.append(full.resolve())
                else:
                    skipped_too_small += 1

                # Provide progress updates at regular intervals
                if progress_callback and files_checked % update_interval == 0:
                    progress_callback(
                        len(image_files),
                        f"Traversing image files... {len(image_files)} found",
                    )

        if skipped_too_small:
            logger.info(
                f"Skipped {skipped_too_small} image(s) under "
                f"{self.min_image_dimension}px in either dimension."
            )

        # Final update with total count
        if progress_callback:
            progress_callback(
                len(image_files),
                f"File traversal complete - {len(image_files)} images found",
            )

        return image_files

    def get_image_files(
        self,
        image_paths_or_dir: list[Path] | Path,
        exts: set[str] = SUPPORTED_EXTENSIONS,
        progress_callback: Callable | None = None,
    ) -> list[Path]:
        """
        Get a list of image file paths from a directory or a list of image paths.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            progress_callback: Optional callback function for progress updates

        Returns:
            list of Path: List of image file paths.
        """
        logger.info("get_image_files called with progress_callback")
        if isinstance(image_paths_or_dir, Path):
            # If it's a single Path object, treat it as a directory
            images = self.get_image_files_from_directory(
                image_paths_or_dir, exts, progress_callback
            )
        elif isinstance(image_paths_or_dir, list):
            images = []
            for p in image_paths_or_dir:
                if p.is_dir():
                    images.extend(
                        self.get_image_files_from_directory(p, exts, progress_callback)
                    )
                elif p.suffix.lower() in exts and self._passes_dimension_gate(p):
                    images.append(p)
        else:
            raise ValueError("Input must be a Path object or a list of Paths.")
        return images

    def _get_modification_time(self, metadata: dict) -> float | None:
        """
        Extract the modification time from image metadata.
        If no valid EXIF date is found, use the file's last modified time.
        """
        # Check for common EXIF date fields
        date_fields = ["DateTimeOriginal", "DateTimeDigitized", "DateTime"]
        for field in date_fields:
            if field in metadata:
                date_str = metadata[field]
                try:
                    # EXIF date format is "YYYY:MM:DD HH:MM:SS"
                    dt = datetime.strptime(date_str, "%Y:%m:%d %H:%M:%S")
                    return dt.timestamp()
                except ValueError:
                    logger.warning(f"Invalid {field} format: {date_str}")
                    continue

        # No usable EXIF date found, so return None
        return None

    def _process_single_image(
        self, image_path: Path, encoder: ImageTextEncoder
    ) -> tuple[np.ndarray | None, float | None, dict | None]:
        """
        Process a single image and return its embedding, modification time, and metadata.

        Returns:
            tuple: (embedding, modification_time, metadata) or (None, None, None) if failed
        """
        try:
            pil_image = Image.open(image_path)
            pil_image = ImageOps.exif_transpose(pil_image)
            pil_image = pil_image.convert("RGB")

            # Get file metadata
            metadata = self.extract_image_metadata(pil_image)

            # Try to get the image creation/modification time from EXIF data
            modification_time = self._get_modification_time(metadata)
            if modification_time is None:
                modification_time = image_path.stat().st_mtime

            embedding = encoder.encode_images([pil_image])[0]

            return embedding, modification_time, metadata
        except Exception as e:
            logger.error(f"Error processing {image_path}: {e}")
            return None, None, None

    def _clip_root(self) -> str | None:
        """
        Determine the root directory for CLIP model caching.
        This is important for PyInstaller compatibility.
        """
        if getattr(sys, "frozen", False):
            # If running in a PyInstaller bundle, use the bundled cache directory
            bundle_dir = sys._MEIPASS
            return os.path.join(bundle_dir, "clip_models")
        else:
            # Otherwise, use the default cache directory
            return None

    def _load_image(
        self, image_path: Path
    ) -> tuple[Image.Image, float, dict] | None:
        """Open an image and extract modtime + metadata. Returns None on failure.

        Thread-safe: PIL decoders release the GIL during native I/O and the
        helpers used here don't share mutable state.
        """
        try:
            pil = Image.open(image_path)
            pil = ImageOps.exif_transpose(pil)
            pil = pil.convert("RGB")
            metadata = self.extract_image_metadata(pil)
            modification_time = self._get_modification_time(metadata)
            if modification_time is None:
                modification_time = image_path.stat().st_mtime
            return pil, modification_time, metadata
        except Exception as e:
            logger.error(f"Error processing {image_path}: {e}")
            return None

    def _process_images_batch(
        self,
        image_paths: list[Path],
        progress_callback: Callable | None = None,
        batch_size: int = 1,
        num_workers: int = 1,
    ) -> IndexResult:
        """
        Process a batch of images and return IndexResult.

        Args:
            image_paths: List of image paths to process
            progress_callback: Optional callback function(index, total, message) for progress updates
            batch_size: Number of images encoded per forward pass. Default 1 preserves
                the per-image behavior; larger values amortize per-call overhead but
                use more GPU memory.
            num_workers: Number of CPU threads loading and pre-extracting metadata in
                parallel. Default 1 keeps the legacy serial path. >1 enables a
                bounded producer/consumer pipeline so the GPU stays fed while images
                decode concurrently.
        """
        if batch_size < 1:
            raise ValueError(f"batch_size must be >= 1 (got {batch_size})")
        if num_workers < 1:
            raise ValueError(f"num_workers must be >= 1 (got {num_workers})")

        encoder = self._build_encoder()
        embedding_dim = encoder.embedding_dim

        embeddings: list[np.ndarray] = []
        filenames: list[str] = []
        modification_times: list[float] = []
        metadatas: list[dict] = []
        bad_files: list[Path] = []

        total_images = len(image_paths)

        buf_paths: list[Path] = []
        buf_images: list[Image.Image] = []
        buf_modtimes: list[float] = []
        buf_metadatas: list[dict] = []

        def flush() -> None:
            if not buf_images:
                return
            try:
                batch_emb = encoder.encode_images(buf_images)
            except Exception as e:
                logger.error(f"Error encoding batch of {len(buf_images)} images: {e}")
                bad_files.extend(buf_paths)
            else:
                for j, path in enumerate(buf_paths):
                    embeddings.append(batch_emb[j])
                    filenames.append(path.resolve().as_posix())
                    modification_times.append(buf_modtimes[j])
                    metadatas.append(buf_metadatas[j])
            buf_paths.clear()
            buf_images.clear()
            buf_modtimes.clear()
            buf_metadatas.clear()

        def consume(i: int, image_path: Path, loaded: tuple | None) -> None:
            if progress_callback:
                progress_callback(i, total_images, f"Processing {image_path.name}")
            if loaded is None:
                bad_files.append(image_path)
                return
            pil, modtime, metadata = loaded
            buf_paths.append(image_path)
            buf_images.append(pil)
            buf_modtimes.append(modtime)
            buf_metadatas.append(metadata)
            if len(buf_images) >= batch_size:
                flush()

        try:
            if num_workers == 1:
                # Serial path — preserves legacy behavior exactly.
                for i, image_path in enumerate(image_paths):
                    consume(i, image_path, self._load_image(image_path))
            else:
                # Parallel CPU loaders feeding the (single) GPU consumer in order.
                # Bounded sliding window keeps memory in check on huge collections.
                queue_capacity = num_workers * 2 + batch_size
                it = enumerate(image_paths)
                window: deque[tuple[int, Path, Any]] = deque()
                with ThreadPoolExecutor(
                    max_workers=num_workers, thread_name_prefix="img-loader"
                ) as pool:
                    for _ in range(queue_capacity):
                        try:
                            i, path = next(it)
                        except StopIteration:
                            break
                        window.append((i, path, pool.submit(self._load_image, path)))

                    while window:
                        i, path, fut = window.popleft()
                        consume(i, path, fut.result())
                        try:
                            ni, npath = next(it)
                        except StopIteration:
                            continue
                        window.append((ni, npath, pool.submit(self._load_image, npath)))
            flush()
        finally:
            device = encoder.device
            encoder.close()
            self._cleanup_cuda_memory(device)

        umap_embeddings = self.create_umap_index(
            np.array(embeddings) if embeddings else np.empty((0, embedding_dim))
        )

        return IndexResult(
            embeddings=np.array(embeddings) if embeddings else np.empty((0, embedding_dim)),
            filenames=np.array(filenames),
            modification_times=np.array(modification_times),
            metadata=np.array(metadatas, dtype=object),
            umap_embeddings=umap_embeddings,
            bad_files=bad_files,
            model_id=encoder.model_id,
            embedding_dim=embedding_dim,
        )

    async def _process_images_batch_async(
        self,
        image_paths: list[Path],
        album_key: str,
        batch_size: int = DEFAULT_BATCH_SIZE,
        num_workers: int = DEFAULT_NUM_WORKERS,
    ) -> IndexResult:
        """Run the batched/parallel pipeline off the event loop.

        The sync :meth:`_process_images_batch` already overlaps CPU loading
        across threads, so delegating to it via ``asyncio.to_thread`` keeps
        the FastAPI event loop fully responsive while indexing runs.

        Serialized by :data:`_indexing_semaphore` so two concurrent album
        indexes don't both hold an encoder in VRAM at the same time.

        The progress callback also enforces cooperative cancellation: when
        ``progress_tracker.is_cancel_requested(album_key)`` becomes True the
        callback raises :class:`IndexingCancelled`, which the
        ``_process_images_batch`` worker propagates back out so the rest of
        the dataset isn't encoded and no partial index is written. The
        per-image callback boundary is fine-grained enough to keep
        cancel-to-stop latency well below a second on a typical GPU.
        """

        def progress_cb(i: int, total: int, message: str) -> None:
            if progress_tracker.is_cancel_requested(album_key):
                raise IndexingCancelled("Indexing cancelled by user")
            progress_tracker.update_progress(album_key, i, message)

        async with _get_indexing_semaphore():
            return await asyncio.to_thread(
                self._process_images_batch,
                image_paths,
                progress_cb,
                batch_size,
                num_workers,
            )

    def _save_embeddings(self, index_result: IndexResult) -> None:
        """Save embeddings to disk and clear cache."""
        logger.info(f"Saving embeddings to {self.embeddings_path}")
        atomic_savez(
            self.embeddings_path,
            embeddings=index_result.embeddings,
            filenames=index_result.filenames,
            modification_times=index_result.modification_times,
            metadata=index_result.metadata,
            model_id=np.array(index_result.model_id),
            embedding_dim=np.array(index_result.embedding_dim),
        )

        # Clear cache after saving
        _open_npz_file.cache_clear()

    @staticmethod
    def _path_compare_key(p: Path) -> str:
        """Canonical key for the new-vs-missing diff in
        :meth:`_get_new_and_missing_images`.

        Returns the casefolded posix-form of the path. Casefolding is what
        lets the diff stay correct on **case-insensitive filesystems**
        (Windows NTFS by default, macOS HFS+ and case-insensitive APFS):
        when an image is stored in the cache as ``Photo.JPG`` and later
        scanned from disk as ``photo.jpg``, plain Path equality treats
        them as different entries — both as new (re-encoded) and as
        missing (orphaned in the cache).

        Trade-off on case-sensitive Linux: two files in the same
        directory whose names differ only in case (``IMG.jpg`` and
        ``img.jpg``) collapse to a single index entry. That collision is
        rare and harmless — the same image will simply be indexed once
        instead of twice — and is far less destructive than the silent
        double-encoding the previous Path-equality diff produced on the
        majority of user platforms.
        """
        return p.as_posix().casefold()

    def _get_new_and_missing_images(
        self,
        image_paths_or_dir: list[Path] | Path,
        existing_filenames: np.ndarray,
        progress_callback: Callable | None = None,
    ) -> tuple[set[Path], set[Path]]:
        """Determine which images are new and which are missing."""
        live_paths = self.get_image_files(
            image_paths_or_dir, progress_callback=progress_callback
        )
        # Build map from casefolded posix key to the *original-case* Path.
        # The casefolded keys drive the set diff; the original Paths flow
        # back out so downstream filesystem operations see what the disk
        # actually holds.
        live_by_key: dict[str, Path] = {
            self._path_compare_key(p): p for p in live_paths
        }
        existing_by_key: dict[str, Path] = {
            self._path_compare_key(Path(p)): Path(p) for p in existing_filenames
        }

        new_keys = set(live_by_key) - set(existing_by_key)
        missing_keys = set(existing_by_key) - set(live_by_key)

        new_image_paths = {live_by_key[k] for k in new_keys}
        missing_image_paths = {existing_by_key[k] for k in missing_keys}

        return new_image_paths, missing_image_paths

    def _filter_missing_images(
        self,
        missing_image_paths: set[Path],
        existing_embeddings: np.ndarray,
        existing_filenames: np.ndarray,
        existing_modtimes: np.ndarray,
        existing_metadatas: np.ndarray,
        model_id: str = LEGACY_ENCODER_SPEC,
        embedding_dim: int | None = None,
    ) -> IndexResult:
        """Remove missing images from existing arrays."""
        resolved_dim = embedding_dim or (
            int(existing_embeddings.shape[1])
            if existing_embeddings.ndim == 2 and existing_embeddings.size
            else 512
        )
        if not missing_image_paths:
            return IndexResult(
                embeddings=existing_embeddings,
                filenames=existing_filenames,
                modification_times=existing_modtimes,
                metadata=existing_metadatas,
                bad_files=[],
                model_id=model_id,
                embedding_dim=resolved_dim,
            )

        logger.warning(
            f"Removing {len(missing_image_paths)} missing images from existing embeddings."
        )

        # Convert missing paths to strings for comparison
        missing_image_strings = {path.as_posix() for path in missing_image_paths}

        # Create mask for images that still exist (NOT in missing set)
        mask = np.array(
            [fname not in missing_image_strings for fname in existing_filenames]
        )

        # Debug output
        removed_count = len(existing_filenames) - np.sum(mask)
        logger.info(f"Filtered {removed_count} missing images from index")

        return IndexResult(
            embeddings=existing_embeddings[mask],
            filenames=existing_filenames[mask],
            modification_times=existing_modtimes[mask],
            metadata=existing_metadatas[mask],
            bad_files=[],
            model_id=model_id,
            embedding_dim=resolved_dim,
        )

    def _combine_index_results(
        self, existing_result: IndexResult, new_result: IndexResult
    ) -> IndexResult:
        """Combine existing and new IndexResults."""
        # Handle empty existing embeddings
        if existing_result.embeddings.size == 0:
            existing_embeddings = np.empty(
                (0, new_result.embeddings.shape[1]), dtype=new_result.embeddings.dtype
            )
        else:
            existing_embeddings = existing_result.embeddings

        return IndexResult(
            embeddings=np.vstack((existing_embeddings, new_result.embeddings)),
            filenames=np.concatenate((existing_result.filenames, new_result.filenames)),
            modification_times=np.concatenate(
                (existing_result.modification_times, new_result.modification_times)
            ),
            metadata=np.concatenate((existing_result.metadata, new_result.metadata)),
            bad_files=existing_result.bad_files + new_result.bad_files,
            model_id=new_result.model_id,
            embedding_dim=new_result.embedding_dim,
        )

    def create_index(
        self,
        image_paths_or_dir: list[Path] | Path,
        create_index: bool = True,
        batch_size: int = DEFAULT_BATCH_SIZE,
        num_workers: int = DEFAULT_NUM_WORKERS,
    ) -> IndexResult:
        """Index images using CLIP and save their embeddings."""
        image_paths = self.get_image_files(image_paths_or_dir)
        total_images = len(image_paths)
        progress_callback = tqdm_progress_callback(total_images)

        logger.info(f"Creating index {self.embeddings_path}...")
        self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
        result = self._process_images_batch(
            image_paths,
            progress_callback=progress_callback,
            batch_size=batch_size,
            num_workers=num_workers,
        )

        if create_index:
            self._save_embeddings(result)
            logger.info(
                f"Indexed {len(result.embeddings)} images and saved to {self.embeddings_path}"
            )
            result.umap_embeddings = self.create_umap_index(result.embeddings)
            logger.info(
                f"Created UMAP index with shape: {result.umap_embeddings.shape}"
            )

        return result

    async def create_index_async(
        self,
        image_paths_or_dir: list[Path] | Path,
        album_key: str,
        create_index: bool = True,
        batch_size: int = DEFAULT_BATCH_SIZE,
        num_workers: int = DEFAULT_NUM_WORKERS,
    ) -> IndexResult | None:
        """Asynchronously index images using CLIP with progress tracking."""
        logger.info("Starting asynchronous indexing operation")
        progress_tracker.start_operation(album_key, 0, "scanning")

        def traversal_callback(count, message):
            progress_tracker.update_total_images(album_key, max(count, 0))
            progress_tracker.update_progress(album_key, count, message)

        # Offload the blocking traversal to a thread
        image_paths = await asyncio.to_thread(
            self.get_image_files,
            image_paths_or_dir,
            progress_callback=traversal_callback,
        )
        total_images = len(image_paths)
        logger.info(f"Found {total_images} image files in {image_paths_or_dir}")
        if total_images == 0:
            progress_tracker.set_error(
                album_key, "No image files found in album directory(ies)"
            )
            return

        progress_tracker.start_operation(album_key, total_images, "indexing")

        try:
            self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
            result = await self._process_images_batch_async(
                image_paths, album_key, batch_size=batch_size, num_workers=num_workers
            )
            progress_tracker.update_progress(
                album_key, total_images, "Saving index file"
            )
            if create_index:
                self._save_embeddings(result)
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

        progress_tracker.start_operation(album_key, total_images, "mapping")
        try:
            umap_embeddings = await asyncio.to_thread(
                self.create_umap_index, result.embeddings
            )
            result.umap_embeddings = umap_embeddings
            progress_tracker.complete_operation(
                album_key, "Indexing completed successfully"
            )
            return result
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def _load_existing_index_arrays(self) -> _ExistingIndex:
        """Read the saved ``.npz`` arrays and verify the stored encoder spec.

        Raises :class:`EmbeddingCacheMismatch` when the on-disk encoder model
        differs from this instance's ``encoder_spec`` — mixing them silently
        would produce nonsense similarity scores.
        """
        data = np.load(self.embeddings_path, allow_pickle=True)
        existing_embeddings = data["embeddings"]
        existing_filenames = data["filenames"]
        existing_modtimes = data["modification_times"]
        existing_metadatas = data["metadata"]
        existing_model_id = (
            str(data["model_id"]) if "model_id" in data.files else LEGACY_ENCODER_SPEC
        )
        existing_dim = (
            int(data["embedding_dim"])
            if "embedding_dim" in data.files
            else (int(existing_embeddings.shape[1]) if existing_embeddings.size else 512)
        )
        if existing_model_id != self.encoder_spec:
            raise EmbeddingCacheMismatch(
                existing_model_id, self.encoder_spec, str(self.embeddings_path)
            )
        return _ExistingIndex(
            embeddings=existing_embeddings,
            filenames=existing_filenames,
            modification_times=existing_modtimes,
            metadata=existing_metadatas,
            model_id=existing_model_id,
            embedding_dim=existing_dim,
        )

    def _finalize_index_update(
        self,
        filtered_existing: IndexResult,
        new_result: IndexResult,
        missing_image_count: int,
        *,
        on_save_start: Callable[[], None] | None = None,
    ) -> tuple[IndexResult, bool]:
        """Decide between save-the-combined-batch and noop, return the result.

        When there are no new files and no removed files this is a true noop:
        ``_save_embeddings`` is *not* called and the caller is expected to
        keep using the existing on-disk index. The second tuple element
        (``did_rebuild``) lets the caller know whether the UMAP should be
        treated as freshly invalidated.

        ``on_save_start`` (when supplied) fires immediately before the
        combine+save runs, so the async caller can flip its progress tracker
        to "Saving updated index" only when there's actually going to be a
        save — without the hook the noop path would briefly show a stale
        "Saving" message.

        ``umap_embeddings`` on the returned ``IndexResult`` is left ``None``
        because attaching UMAP differs by call path (sync vs async-thread).
        """
        new_files_indexed = new_result.embeddings.shape[0]
        old_files_removed = missing_image_count

        if new_files_indexed == 0 and old_files_removed == 0:
            return (
                IndexResult(
                    embeddings=filtered_existing.embeddings,
                    filenames=filtered_existing.filenames,
                    modification_times=filtered_existing.modification_times,
                    metadata=filtered_existing.metadata,
                    bad_files=new_result.bad_files,
                    model_id=filtered_existing.model_id,
                    embedding_dim=filtered_existing.embedding_dim,
                ),
                False,
            )

        if on_save_start is not None:
            on_save_start()
        combined = self._combine_index_results(filtered_existing, new_result)
        self._save_embeddings(combined)
        return combined, True

    def update_index(
        self,
        image_paths_or_dir: list[Path] | Path,
        batch_size: int = DEFAULT_BATCH_SIZE,
        num_workers: int = DEFAULT_NUM_WORKERS,
    ) -> IndexResult | None:
        """Update existing embeddings with new images."""
        if not self.embeddings_path.exists():
            raise FileNotFoundError(
                f"Embeddings file {self.embeddings_path} does not exist. "
                "Please create an index first."
            )

        try:
            existing = self._load_existing_index_arrays()

            logger.info(f"Scanning for new images in {image_paths_or_dir}...")
            new_image_paths, missing_image_paths = self._get_new_and_missing_images(
                image_paths_or_dir,
                existing.filenames,
            )
            filtered_existing = self._filter_missing_images(
                missing_image_paths,
                existing.embeddings,
                existing.filenames,
                existing.modification_times,
                existing.metadata,
                model_id=existing.model_id,
                embedding_dim=existing.embedding_dim,
            )

            if len(filtered_existing.filenames) == 0 and len(new_image_paths) == 0:
                logger.warning(
                    "No images found in album directory(ies). Exiting update."
                )
                return None

            total_new_images = len(new_image_paths)
            logger.info(
                f"Found {total_new_images} new images to index, "
                f"{len(missing_image_paths)} missing. Beginning indexing..."
            )

            new_result = self._process_images_batch(
                list(new_image_paths), batch_size=batch_size, num_workers=num_workers
            )

            logger.info(
                f"New files indexed: {new_result.embeddings.shape[0]}, "
                f"Old files removed: {len(missing_image_paths)}"
            )

            result, did_rebuild = self._finalize_index_update(
                filtered_existing, new_result, len(missing_image_paths)
            )
            if not did_rebuild:
                logger.info(
                    "No new images needed to be indexed. Will not regenerate umap"
                )
            else:
                logger.info("Indexing completed successfully. Saving updated index...")

            # Attach UMAP: when ``did_rebuild`` is True the saved npz invalidates
            # the umap.npz cache and the property rebuilds; otherwise the property
            # just loads the existing UMAP from disk.
            result.umap_embeddings = self.umap_embeddings
            if did_rebuild and result.umap_embeddings is not None:
                logger.info(
                    f"UMAP index created with shape: {result.umap_embeddings.shape}"
                )

            return result

        except Exception as e:
            logger.error(f"Failed to update index: {e}")
            raise

    async def update_index_async(
        self,
        image_paths_or_dir: list[Path] | Path,
        album_key: str,
        batch_size: int = DEFAULT_BATCH_SIZE,
        num_workers: int = DEFAULT_NUM_WORKERS,
    ) -> IndexResult | None:
        """Asynchronously update existing embeddings with new images."""
        if not self.embeddings_path.exists():
            raise FileNotFoundError(
                f"Embeddings file {self.embeddings_path} does not exist. "
                "Please create an index first."
            )

        try:
            existing = self._load_existing_index_arrays()

            progress_tracker.start_operation(album_key, 0, "scanning")

            def traversal_callback(count, message):
                # Update the total as we discover more files.
                progress_tracker.update_total_images(album_key, max(count, 0))
                progress_tracker.update_progress(album_key, count, message)

            new_image_paths, missing_image_paths = await asyncio.to_thread(
                self._get_new_and_missing_images,
                image_paths_or_dir,
                existing.filenames,
                progress_callback=traversal_callback,
            )

            filtered_existing = self._filter_missing_images(
                missing_image_paths,
                existing.embeddings,
                existing.filenames,
                existing.modification_times,
                existing.metadata,
                model_id=existing.model_id,
                embedding_dim=existing.embedding_dim,
            )

            if len(filtered_existing.filenames) == 0 and len(new_image_paths) == 0:
                progress_tracker.set_error(
                    album_key, "No images found in album directory(ies)"
                )
                return None

            total_new_images = len(new_image_paths)
            progress_tracker.start_operation(album_key, total_new_images, "indexing")

            new_result = await self._process_images_batch_async(
                list(new_image_paths),
                album_key,
                batch_size=batch_size,
                num_workers=num_workers,
            )

            logger.info(
                f"New files indexed: {new_result.embeddings.shape[0]}, "
                f"Old files removed: {len(missing_image_paths)}"
            )

            # The save (when needed) is still a blocking np.savez, so push the
            # combine/save through ``to_thread`` to keep the event loop free.
            # The "Saving updated index" progress message only fires if a save
            # is actually going to happen — see ``on_save_start`` below.
            def _on_save_start() -> None:
                progress_tracker.update_progress(
                    album_key, total_new_images, "Saving updated index"
                )

            result, did_rebuild = await asyncio.to_thread(
                self._finalize_index_update,
                filtered_existing,
                new_result,
                len(missing_image_paths),
                on_save_start=_on_save_start,
            )
            if not did_rebuild:
                logger.info(
                    "No new images needed to be indexed. Will not regenerate umap"
                )
                progress_tracker.complete_operation(
                    album_key, "No new images needed to be indexed"
                )
            else:
                progress_tracker.start_operation(album_key, total_new_images, "mapping")

            # UMAP rebuild (when needed) is the slow step; keep it off-thread.
            result.umap_embeddings = await asyncio.to_thread(lambda: self.umap_embeddings)

            if did_rebuild:
                progress_tracker.complete_operation(
                    album_key,
                    f"Successfully indexed {len(result.embeddings)} new images",
                )

            return result

        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def create_umap_index(self, embeddings: np.ndarray) -> np.ndarray:
        """
        Create a UMAP index for the embeddings.

        Args:
            embeddings (np.ndarray): The image embeddings to create UMAP index for.
        Returns:
            np.ndarray: The UMAP embeddings.
        """
        if embeddings.size == 0:
            logger.info("No embeddings provided for UMAP index creation.")
            return np.empty((0, 2))

        # hide warnings from UMAP about TBB version
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore")
            # TO DO: Allow these constants to be configurable.
            n_neighbors = min(15, len(embeddings) - 1) if len(embeddings) > 1 else 1
            umap_model = UMAP(
                n_neighbors=n_neighbors, n_components=2, min_dist=0.05, metric="cosine"
            )
            try:
                umap_embeddings = umap_model.fit_transform(embeddings)
            except Exception as e:
                logger.error(f"UMAP fitting failed: {e}")
                return np.empty((0, 2))

        cache_file = self.embeddings_path.parent / "umap.npz"
        umap_embeddings = np.asarray(umap_embeddings)
        atomic_savez(cache_file, umap=umap_embeddings)
        logger.info(f"UMAP embeddings shape: {umap_embeddings.shape}")
        return umap_embeddings

    @property
    def umap_embeddings(self) -> np.ndarray:
        """
        Load UMAP embeddings from disk.

        Returns:
            np.ndarray: The UMAP embeddings.
        """
        cache_file = self.embeddings_path.parent / "umap.npz"
        if (
            not cache_file.exists()
            or cache_file.stat().st_mtime < self.embeddings_path.stat().st_mtime
        ):  # If UMAP index does not exist or is outdated, create it
            embeddings = self.open_cached_embeddings(self.embeddings_path)["embeddings"]
            logger.info(f"Creating UMAP index for {embeddings.shape[0]} embeddings")
            return self.create_umap_index(embeddings)
        data = np.load(cache_file, allow_pickle=True)
        return data["umap"]

    @property
    def indexes(self) -> dict[str, np.ndarray]:
        """
        Load all indexes from the embeddings file.

        Returns:
            Dict[str, np.ndarray]: Dictionary containing all indexes.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        return data

    # Main search entry point.
    def search_images_by_text_and_image(
        self,
        query_image_data: Image.Image | None = None,
        positive_query: str | None = "",
        negative_query: str | None = None,
        image_weight: float = 0.5,
        positive_weight: float = 0.5,
        negative_weight: float = 0.5,
        top_k: int = 5,
        minimum_score: float = 0.2,
        use_query_optimization: bool | None = None,
    ) -> tuple[list[int], list[float]]:
        """
        Search for images similar to a query image and a positive/negative text prompt, with separate weights.
        Any of the queries can be None; if so, their corresponding weight is set to zero and they are not used.
        Args:
            query_image_data (Image or None): PIL Image data for the query image.
            positive_query (str or None): Positive text prompt.
            negative_query (str or None): Negative text prompt.
            image_weight (float): Weight for image embedding.
            positive_weight (float): Weight for positive text embedding.
            negative_weight (float): Weight for negative text embedding (should be positive; will be subtracted).
            top_k (int): Number of top results.
            minimum_score (float): Minimum similarity score.
            use_query_optimization (bool or None): Per-album SigLIP toggle. When
                set, controls prompt-template ensembling for SigLIP encoders.
                Ignored by other backends. ``None`` keeps the encoder's current
                setting (the module-level default, typically).
        Returns:
            tuple: (indexes, similarities)
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        embeddings = data["embeddings"]
        filenames = data["filenames"]
        filename_map = data["filename_map"]

        # Search uses a cached encoder so repeated queries don't reload the
        # model — especially important for SigLIP, which otherwise re-issues
        # HF Hub HEAD checks for every search.
        encoder = get_cached_encoder(self.encoder_spec, cache_dir=self._clip_root())
        device = encoder.device

        # Per-album SigLIP toggle for prompt ensembling. Other encoders ignore
        # the attribute entirely.
        if use_query_optimization is not None and hasattr(encoder, "use_ensembling"):
            encoder.use_ensembling = use_query_optimization

        # Pre-declare every GPU tensor and downstream numpy buffer the finally
        # block needs to release. The previous ``del locals()[name]`` loop was
        # a no-op — locals() returns a dict copy in functions, so the actual
        # local bindings (and the VRAM they pinned) lived on until the frame
        # itself was destroyed. Binding here lets the finally use plain ``del``
        # to drop the references *before* ``_cleanup_cuda_memory`` runs
        # ``torch.cuda.empty_cache()``, so the allocator can actually reclaim
        # the freed memory instead of leaving it pinned.
        image_embedding = None
        pos_emb = None
        neg_emb = None
        embeddings_tensor = None
        norm_embeddings = None
        cos_img = None
        cos_pos = None
        cos_neg = None
        positive_score_sum = None
        similarities = None

        try:
            self._check_cache_compatibility(data, encoder)

            # Drop weights for queries that aren't actually present.
            if query_image_data is None:
                image_weight = 0.0
            if not positive_query:
                positive_weight = 0.0
            if not negative_query:
                negative_weight = 0.0
            if image_weight == 0.0 and positive_weight == 0.0 and negative_weight == 0.0:
                return [], []

            # Encode only the inputs that will actually contribute.
            if image_weight > 0.0:
                pil_image = ImageOps.exif_transpose(query_image_data).convert("RGB")
                image_embedding = torch.from_numpy(
                    encoder.encode_images([pil_image])[0]
                ).to(device)
            if positive_weight > 0.0:
                pos_emb = torch.from_numpy(
                    encoder.encode_text([positive_query])[0]
                ).to(device)
            if negative_weight > 0.0:
                neg_emb = torch.from_numpy(
                    encoder.encode_text([negative_query])[0]
                ).to(device)

            # Stored embeddings produced by encoders.py are already unit-norm,
            # but legacy caches may not be, so we normalize defensively.
            embeddings_tensor = torch.tensor(embeddings, dtype=torch.float32, device=device)
            norm_embeddings = F.normalize(embeddings_tensor, dim=-1)

            # Score-space combine: compute per-modality cosines, calibrate the
            # text ones (no-op for CLIP/OpenCLIP, sigmoid for SigLIP), and
            # take a weighted average over the active positive contributions.
            # The negative contribution is subtracted from that average so the
            # negative weight acts as a penalty rather than diluting the
            # positive direction. This makes the slider semantics honest:
            # combining in embedding space (the previous approach) lets
            # image-image cosines silently dominate image-text ones because
            # the two live on different scales.
            n = norm_embeddings.shape[0]
            positive_score_sum = np.zeros(n, dtype=np.float32)
            positive_weight_sum = 0.0

            if image_embedding is not None:
                cos_img = (norm_embeddings @ image_embedding).cpu().numpy()
                positive_score_sum += image_weight * cos_img
                positive_weight_sum += image_weight

            if pos_emb is not None:
                cos_pos = encoder.calibrate_similarity(
                    (norm_embeddings @ pos_emb).cpu().numpy()
                )
                positive_score_sum += positive_weight * cos_pos
                positive_weight_sum += positive_weight

            if positive_weight_sum > 0.0:
                similarities = positive_score_sum / positive_weight_sum
            else:
                similarities = positive_score_sum

            if neg_emb is not None:
                cos_neg = encoder.calibrate_similarity(
                    (norm_embeddings @ neg_emb).cpu().numpy()
                )
                similarities = similarities - negative_weight * cos_neg

            top_indices = similarities.argsort()[-top_k:][::-1]
            top_indices = [i for i in top_indices if similarities[i] >= minimum_score]

            if not top_indices:
                return [], []

            # Translate from filename array indices to sorted filename top_indices
            result_indices = [int(filename_map[filenames[i]]) for i in top_indices]
            result_similarities = similarities[top_indices].tolist()

            return result_indices, result_similarities
        finally:
            # Drop any local tensors / arrays so VRAM doesn't accumulate
            # across queries. All ten names are unconditionally bound above
            # (initially to None), so plain ``del`` is safe — no NameError
            # paths to guard against. The encoder itself is cached and
            # intentionally NOT closed here.
            del image_embedding, pos_emb, neg_emb
            del embeddings_tensor, norm_embeddings
            del cos_img, cos_pos, cos_neg
            del positive_score_sum, similarities
            self._cleanup_cuda_memory(device)

    def find_duplicate_clusters(self, similarity_threshold=0.995):
        """
        Find clusters of similar images based on cosine similarity.
        Args:
            similarity_threshold (float): Threshold for considering images as similar.
        """
        data = np.load(self.embeddings_path, allow_pickle=True)
        embeddings = data["embeddings"]
        filenames = data["filenames"]

        # Normalize embeddings. ``_l2_normalize`` carries an epsilon guard so
        # an all-zero row can't produce NaN here.
        norm_embeddings = _l2_normalize(embeddings, axis=-1)
        if not isinstance(norm_embeddings, np.ndarray):
            raise TypeError(
                f"_l2_normalize returned {type(norm_embeddings).__name__}, "
                "expected np.ndarray"
            )

        # Use NearestNeighbors with cosine metric
        nn = NearestNeighbors(metric="cosine", algorithm="brute")
        nn.fit(norm_embeddings)
        radius = 1 - similarity_threshold
        distances, indices = nn.radius_neighbors(norm_embeddings, radius=radius)

        # Build the graph
        G = nx.Graph()
        for i, nbrs in enumerate(indices):
            for j in nbrs:
                if i < j:  # avoid self and duplicate edges
                    G.add_edge(filenames[i], filenames[j])

        # Find clusters (connected components)
        clusters = list(nx.connected_components(G))
        for idx, cluster in enumerate(clusters, 1):
            print(f"Cluster {idx}:")
            for fname in sorted(cluster):
                print(fname)
            print()

    def get_image_path(self, index: int) -> Path:
        """
        Get the image path for a given index in the embeddings file.
        Args:
            index (int): Index of the image to retrieve.
        Returns: Path to the image file.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        sorted_filenames = data["sorted_filenames"]
        if index < 0 or index >= len(sorted_filenames):
            raise IndexError(f"Index {index} out of bounds for embeddings file.")
        return Path(sorted_filenames[index])

    def retrieve_image(
        self,
        index: int = 0,
    ) -> SlideSummary:
        """
        Retrieve the next image in the sequence or a random image if requested.
        Args:
            index (int): Index of the image to retrieve.
            Returns:
                SlideSummary: Path and description of the requested image.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        sorted_filenames = data["sorted_filenames"]
        sorted_metadata = data["sorted_metadata"]
        if index < 0 or index >= len(sorted_filenames):
            raise IndexError(f"Index {index} out of bounds for embeddings file.")

        return format_metadata(
            Path(sorted_filenames[index]),
            sorted_metadata[index],
            index,
            len(sorted_filenames),
        )

    def remove_image_from_embeddings(self, index: int) -> None:
        """
        Remove an image from the embeddings file.
        """
        try:
            # 1. Load data explicitly without using the cache wrapper
            # This ensures we get a fresh copy to work on
            with np.load(self.embeddings_path, allow_pickle=True) as data:
                filenames = data["filenames"].copy()
                embeddings = data["embeddings"].copy()
                modtimes = data["modification_times"].copy()
                metadata = data["metadata"].copy()
                # Reconstruct sorting locally to find correct index. Must match
                # the (modtime, filename) lexsort used in ``_open_npz_file`` or
                # we'd find the wrong file to delete.
                sorted_indices = np.lexsort((filenames, modtimes))
                sorted_filenames = filenames[sorted_indices]

            current_filename = sorted_filenames[index]

            # 2. Find index in the arrays
            original_idx = np.where(filenames == current_filename)[0][0]

            # 3. Remove from all arrays
            filenames = np.delete(filenames, original_idx)
            embeddings = np.delete(embeddings, original_idx, axis=0)
            modtimes = np.delete(modtimes, original_idx)
            metadata = np.delete(metadata, original_idx)

            # 4. Clear Cache immediately (Before touching disk)
            _open_npz_file.cache_clear()

            # 5. Atomically replace the on-disk index. The previous version
            # unlinked first and then wrote, which lost the entire index if
            # the subsequent write failed; ``atomic_savez`` writes to a
            # ``.tmp`` and renames into place instead.
            atomic_savez(
                self.embeddings_path,
                embeddings=embeddings,
                filenames=filenames,
                modification_times=modtimes,
                metadata=metadata,
            )

            # 6. Re-prime the cache immediately to verify the write
            _open_npz_file(self.embeddings_path)

        except Exception as e:
            logger.error(f"Error removing image: {e}")
            raise

    def update_image_path(self, index: int, new_path: Path) -> None:
        """
        Update the path of an image in the embeddings file after it has been moved.

        Args:
            index: The sorted index of the image in the embeddings
            new_path: The new path to the image file
        """
        try:
            # Load fresh copies of the raw arrays. We must NOT operate on the
            # `_open_npz_file` cache here — concurrent readers share that dict,
            # and mutating ``filenames`` in place would expose a half-edited
            # array to anyone reading mid-update.
            with np.load(self.embeddings_path, allow_pickle=True) as data:
                filenames = data["filenames"].copy()
                embeddings = data["embeddings"].copy()
                modtimes = data["modification_times"].copy()
                metadata = data["metadata"].copy()
                # Match the (modtime, filename) lexsort used elsewhere — see
                # ``_open_npz_file`` for the rationale.
                sorted_indices = np.lexsort((filenames, modtimes))
                sorted_filenames = filenames[sorted_indices]

            current_filename = sorted_filenames[index]

            # Find the index in the original (unsorted) arrays
            original_idx = np.where(filenames == current_filename)[0][0]

            # Convert new_path to string
            new_path_str = str(new_path)

            # Check if the new path is longer than the current dtype allows
            current_dtype = filenames.dtype
            if hasattr(current_dtype, "itemsize"):
                # For string dtypes, check if we need to resize
                max_len = current_dtype.itemsize // 4  # Unicode chars are 4 bytes each
                if len(new_path_str) > max_len:
                    # Need to create a new array with larger dtype
                    new_max_len = max(len(new_path_str), max_len) + 50  # Add buffer
                    filenames = filenames.astype(f"<U{new_max_len}")

            # Update the filename in the now-private copy
            filenames[original_idx] = new_path_str

            # Invalidate the shared cache BEFORE the write so any concurrent
            # reader gets the on-disk version (old or new) rather than a stale
            # cached object whose backing arrays we just rewrote.
            _open_npz_file.cache_clear()

            # Save updated data atomically so a partial write never leaves
            # the index unloadable.
            atomic_savez(
                self.embeddings_path,
                embeddings=embeddings,
                filenames=filenames,
                modification_times=modtimes,
                metadata=metadata,
            )

            logger.info(f"Updated path in embeddings: {current_filename} -> {new_path}")
        except Exception as e:
            logger.error(f"Failed to update image path in embeddings: {e}")
            raise

        # Re-clear after the write so any reader that primed the cache mid-flight
        # is also invalidated.
        _open_npz_file.cache_clear()

    # This is not used in the current implementation, but can be useful for testing.
    def iterate_images(
        self, random: bool = False
    ) -> Generator[SlideSummary, None, None]:
        """
        Iterate over images in the embeddings file.
        Yields:
            SlideSummary: Summary for each image.
        """
        # Use cached version instead of direct np.load
        data = self.open_cached_embeddings(self.embeddings_path)
        filenames = data["filenames"]
        metadata = data["metadata"]

        if random:
            indices = np.random.permutation(len(filenames))
        else:
            indices = np.arange(len(filenames))
        for idx in indices:
            image_path = Path(filenames[idx])
            yield format_metadata(image_path, metadata[idx], int(idx), len(filenames))

    @staticmethod
    def open_cached_embeddings(embeddings_path: Path) -> dict[str, Any]:
        """
        Static wrapper calling the global function.
        Works for both Embeddings.open_cached_embeddings() and self.open_cached_embeddings().
        """
        return _open_npz_file(embeddings_path)

    @staticmethod
    def extract_image_metadata(pil_image: Image.Image) -> dict:
        """Extract metadata from an image using the dedicated extractor."""
        return MetadataExtractor.extract_image_metadata(pil_image)


def tqdm_progress_callback(total_images):
    """Returns a callback function for tqdm progress reporting."""
    pbar = tqdm(total=total_images, desc="Indexing images", unit="img")

    def callback(count, total_images, message):
        pbar.n = count
        pbar.set_description(message)
        pbar.refresh()
        if count >= total_images:
            pbar.close()

    return callback


def print_cuda_message():
    """Print a message about CUDA availability."""
    if os.environ.get("PHOTOMAP_CUDA_GRIPE"):
        return
    if torch.cuda.is_available():
        logger.info("CUDA detected. Using GPU acceleration for indexing.")
    else:
        logger.info("CUDA not detected. Using CPU for indexing.")
    os.environ["PHOTOMAP_CUDA_GRIPE"] = "true"


print_cuda_message()
