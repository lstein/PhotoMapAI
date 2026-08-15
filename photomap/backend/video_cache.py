"""On-disk cache of the still frames extracted from videos.

A video's still is extracted once at index time and reused thereafter for the
grid tile, the slideshow poster, UMAP hover thumbnails and the landmark
overlay — so it has to outlive the indexing run.

**Location: the per-user cache directory, never beside the video.**  Two
reasons, and the second is the sharp one:

1. The user asked that nothing be written into their photo folders (they may
   be read-only, or cloud-synced).
2. An album's ``embeddings.npz`` frequently lives *inside* the album's own
   image directory.  A sibling ``video_frames/`` would therefore sit inside
   the tree that ``os.walk`` scans, and full-resolution stills sail through
   the dimension gate — so every still would be re-indexed as a photo, and
   each of those would be given a still of its own.  ``EXCLUDED_SCAN_DIRS``
   carries the directory name as belt-and-braces, but keeping the cache out
   of the album tree entirely is the real fix.  (Do not rely on the pixel
   gate to catch this: ``min_image_dimension`` is user-editable down to 1.)

Keying on ``(resolved path, mtime)`` makes invalidation free — an edited
video simply maps to a new filename — at the cost of orphaning the old entry,
which the sweeper reclaims.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
from collections import defaultdict
from pathlib import Path

from PIL import Image
from platformdirs import user_cache_dir

from .video import extract_video_frame

logger = logging.getLogger(__name__)

# Directory name, also registered in embeddings.EXCLUDED_SCAN_DIRS so that a
# cache placed inside an album tree by a future refactor still can't be
# indexed.
FRAME_CACHE_DIRNAME = "video_frames"

# Display-only artifact: the CLIP embedding is computed from the in-memory
# frame, so JPEG artifacts never reach the index.
FRAME_JPEG_QUALITY = 92

# Guards against a frame being extracted twice concurrently for the same
# video (e.g. a grid painting many tiles at once). Keyed by cache key, so
# different videos still extract in parallel.
_key_locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
_key_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _key_locks_guard:
        return _key_locks[key]


def frame_cache_root() -> Path:
    """Root of the per-user video-frame cache."""
    return Path(user_cache_dir("photomap", "photomap")) / FRAME_CACHE_DIRNAME


class VideoFrameCache:
    """Still frames for one album, addressed by source video path."""

    def __init__(self, album_key: str, root: Path | None = None) -> None:
        # The album key lands in a filesystem path and keys are user input;
        # mirror the guard in config.default_board_index_path.
        if (
            not album_key
            or "/" in album_key
            or "\\" in album_key
            or "\x00" in album_key
            or ".." in album_key
        ):
            raise ValueError(f"Album key not usable as a directory name: {album_key!r}")
        self.album_key = album_key
        self._root = root if root is not None else frame_cache_root()

    @property
    def directory(self) -> Path:
        return self._root / self.album_key

    @staticmethod
    def key_for(video_path: Path, mtime: float | None = None) -> str:
        """Cache key for ``video_path`` at ``mtime`` (defaults to its current mtime).

        The resolved absolute path is used rather than an album-relative one
        so that albums built from an explicit file list (InvokeAI boards) key
        identically to directory albums.
        """
        if mtime is None:
            try:
                mtime = video_path.stat().st_mtime
            except OSError:
                mtime = 0.0
        payload = f"{Path(video_path).resolve().as_posix()}\x00{mtime:.6f}"
        return hashlib.blake2b(payload.encode("utf-8"), digest_size=16).hexdigest()

    def path_for(self, video_path: Path, mtime: float | None = None) -> Path:
        return self.directory / f"{self.key_for(video_path, mtime)}.jpg"

    def get(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """Cached still for ``video_path``, or ``None`` if not cached."""
        path = self.path_for(video_path, mtime)
        return path if path.exists() else None

    def store(
        self, video_path: Path, frame: Image.Image, mtime: float | None = None
    ) -> Path | None:
        """Write ``frame`` as this video's still. ``None`` if the write failed.

        Writes to a temporary name and ``os.replace``s it into place, so a
        reader never observes a half-written JPEG (mirroring
        ``util.atomic_savez``).
        """
        target = self.path_for(video_path, mtime)
        tmp = target.with_suffix(f".{os.getpid()}.tmp")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            frame.convert("RGB").save(tmp, format="JPEG", quality=FRAME_JPEG_QUALITY)
            os.replace(tmp, target)
            return target
        except OSError as e:
            logger.warning(f"Could not cache video frame for {video_path}: {e}")
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return None

    def ensure(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """Return the cached still, extracting it first if necessary.

        Lets a wiped or partially-pruned cache self-heal instead of leaving
        broken images in the UI.  Under the per-key lock, so a burst of
        concurrent requests for one video spawns ffmpeg once.
        """
        if (cached := self.get(video_path, mtime)) is not None:
            return cached

        with _lock_for(self.key_for(video_path, mtime)):
            # Re-check: another thread may have stored it while we waited.
            if (cached := self.get(video_path, mtime)) is not None:
                return cached
            extracted = extract_video_frame(video_path)
            if extracted is None:
                return None
            frame, _info = extracted
            return self.store(video_path, frame, mtime)

    def discard(self, video_path: Path, mtime: float | None = None) -> None:
        """Drop this video's cached still, if present."""
        try:
            self.path_for(video_path, mtime).unlink(missing_ok=True)
        except OSError as e:
            logger.debug(f"Could not remove cached frame for {video_path}: {e}")

    def prune(self, keep_keys: set[str]) -> int:
        """Delete every cached still whose key is not in ``keep_keys``.

        One sweeper covers what would otherwise be seven separate cleanups:
        mtime changes, moves, copies, single and batch deletes, and files
        removed outside the app.  Called when the index has just been written
        and is therefore authoritative.  Returns the number removed.
        """
        directory = self.directory
        if not directory.is_dir():
            return 0
        removed = 0
        try:
            entries = list(directory.iterdir())
        except OSError as e:
            logger.warning(f"Could not sweep video-frame cache {directory}: {e}")
            return 0
        for entry in entries:
            if entry.suffix != ".jpg" or entry.stem in keep_keys:
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError as e:
                logger.debug(f"Could not remove stale cached frame {entry}: {e}")
        return removed

    def clear(self) -> None:
        """Remove this album's entire frame cache (album deletion)."""
        directory = self.directory
        if not directory.is_dir():
            return
        try:
            for entry in directory.iterdir():
                if entry.is_file():
                    entry.unlink()
            directory.rmdir()
        except OSError as e:
            logger.warning(f"Could not clear video-frame cache {directory}: {e}")
