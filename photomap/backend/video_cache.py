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
   each of those would be given a still of its own.  (Do not rely on the
   pixel gate to catch this: ``min_image_dimension`` is user-editable down
   to 1.)

   Deliberately *not* also listed in ``EXCLUDED_SCAN_DIRS``. That looked like
   free insurance but is not: the walk prunes on a bare name match, so it
   would silently skip a user's own folder called ``video_frames`` — and on
   the next update those already-indexed photos are dropped from the .npz
   with no log line. Keeping the cache out of the album tree is the whole
   defense, and it is sufficient.

Keying on ``(resolved path, mtime)`` makes invalidation free — an edited
video simply maps to a new filename — at the cost of orphaning the old entry,
which the sweeper reclaims.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

from PIL import Image
from platformdirs import user_cache_dir

from .util import BoundedLRU
from .video import extract_video_frame

logger = logging.getLogger(__name__)

# Name of the cache directory under the per-user cache root.
FRAME_CACHE_DIRNAME = "video_frames"

# Display-only artifact: the CLIP embedding is computed from the in-memory
# frame, so JPEG artifacts never reach the index.
FRAME_JPEG_QUALITY = 92

# Guards against a frame being extracted twice concurrently for the same
# video (e.g. a grid painting many tiles at once). Keyed by album+cache key,
# so different videos still extract in parallel.
#
# Bounded: an unbounded dict never evicts, and a long-running server indexing
# a large library would accumulate one lock object per video forever. The cap
# is generous relative to how many extractions can be in flight at once, and
# evicting a lock that is merely idle is harmless — the worst case is two
# threads extracting the same frame, which is what the code already tolerates
# on a cold cache.
_MAX_TRACKED_KEYS = 4096

_key_locks: BoundedLRU[str, threading.Lock] = BoundedLRU(_MAX_TRACKED_KEYS)
_key_locks_guard = threading.Lock()

# Album-qualified keys whose extraction failed, and when. Without this a
# permanently unextractable video re-runs ffmpeg on every single request.
#
# Entries expire: extraction also fails for transient reasons, and a permanent
# record would mean one unlucky moment blanks a video's tile for the life of
# the process. The window is long enough to stop a grid repaint stampeding and
# short enough that a user who fixes the cause (frees memory, installs ffmpeg)
# sees it recover without a restart.
_FAILURE_TTL_SECONDS = 300.0

_failed_keys: BoundedLRU[str, float] = BoundedLRU(_MAX_TRACKED_KEYS)


def _recently_failed(scoped_key: str) -> bool:
    stamp = _failed_keys.get(scoped_key)
    return stamp is not None and (time.monotonic() - stamp) < _FAILURE_TTL_SECONDS


def forget_extraction_failures() -> None:
    """Drop every remembered failure. Exposed for tests and for a rebuild."""
    _failed_keys.clear()


def _lock_for(key: str) -> threading.Lock:
    with _key_locks_guard:
        existing = _key_locks.get(key)
        if existing is None:
            existing = threading.Lock()
            _key_locks.put(key, existing)
        return existing


def frame_cache_root() -> Path:
    """Root of the per-user video-frame cache."""
    return Path(user_cache_dir("photomap", "photomap")) / FRAME_CACHE_DIRNAME


# Characters kept verbatim in the readable half of a cache directory name.
_SAFE_DIRNAME_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def _path_digest(video_path: Path) -> str:
    """Stable digest of a video's identity, independent of its mtime.

    Uses the resolved absolute path so albums built from an explicit file list
    (InvokeAI boards) key identically to directory albums, and casefolds it to
    match ``embeddings._path_compare_key`` — without that, a case-insensitive
    filesystem (Windows NTFS, macOS APFS) can present the same file under two
    spellings and cause endless extract/prune thrash.

    Never raises. Both steps have non-``OSError`` failure modes that would
    otherwise escape every caller — none of which catch anything but
    ``OSError`` — and take down a request or an indexing worker:

    * ``resolve()`` raises ``RuntimeError`` on a symlink loop on Python
      3.10-3.12 (it only switched to ``os.path.realpath`` in 3.13), and this
      project supports 3.10.
    * a filename holding non-UTF-8 bytes — routine on Linux ext4, e.g. a
      latin-1 name from an old camera — surrogate-escapes into the ``str`` and
      ``encode("utf-8")`` raises ``UnicodeEncodeError``.
    """
    try:
        resolved = Path(video_path).resolve().as_posix()
    except (OSError, RuntimeError, ValueError):
        resolved = Path(video_path).as_posix()
    payload = resolved.casefold()
    return hashlib.blake2b(
        payload.encode("utf-8", errors="surrogatepass"), digest_size=16
    ).hexdigest()


def _album_dirname(album_key: str) -> str:
    """A guaranteed-safe single path component for ``album_key``.

    Album keys are user input and end up as a directory name that ``clear()``
    deletes the contents of, so a key that escapes its parent is destructive.
    Rather than blocklist the dangerous forms — an approach that kept missing
    cases, since ``"."`` aims at the shared root, ``".."`` climbs out of it,
    and on Windows ``"C:evil"`` is drive-relative — the name is *constructed*:
    an unsafe-character-stripped prefix for human recognition, plus a hash of
    the original key for uniqueness.

    The hash is what makes this correct. It keeps distinct keys distinct even
    when their sanitized prefixes collide (``a/b`` and ``a_b``), and it cannot
    contain a separator, a dot component or a drive letter.
    """
    digest = hashlib.blake2b(
        album_key.encode("utf-8", errors="surrogatepass"), digest_size=6
    ).hexdigest()
    prefix = _SAFE_DIRNAME_CHARS.sub("_", album_key).strip("._")[:48]
    return f"{prefix}-{digest}" if prefix else digest


class VideoFrameCache:
    """Still frames for one album, addressed by source video path."""

    def __init__(self, album_key: str, root: Path | None = None) -> None:
        if not album_key:
            raise ValueError("Album key must not be empty")
        self.album_key = album_key
        self._root = root if root is not None else frame_cache_root()

    @property
    def directory(self) -> Path:
        return self._root / _album_dirname(self.album_key)

    @staticmethod
    def key_for(video_path: Path, mtime: float | None = None) -> str:
        """Cache key for ``video_path`` at ``mtime`` (its current mtime by default).

        Shaped as ``<path digest>-<mtime digest>`` rather than one hash over
        both. That structure is what lets :meth:`discard` find every
        generation of a path by globbing the prefix — necessary because the
        usual reason to discard is that the file has just been deleted, so its
        mtime can no longer be read.
        """
        if mtime is None:
            try:
                mtime = video_path.stat().st_mtime
            except OSError:
                mtime = 0.0
        stamp = hashlib.blake2b(f"{mtime:.6f}".encode(), digest_size=8).hexdigest()
        return f"{_path_digest(video_path)}-{stamp}"

    def path_for(self, video_path: Path, mtime: float | None = None) -> Path:
        return self.directory / f"{self.key_for(video_path, mtime)}.jpg"

    def get(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """Cached still for ``video_path``, or ``None`` if not cached."""
        return self._get_by_key(self.key_for(video_path, mtime))

    def _get_by_key(self, key: str) -> Path | None:
        path = self.directory / f"{key}.jpg"
        try:
            # Size, not mere existence. A zero-length file is what a crashed
            # or out-of-space write leaves behind, and treating it as a hit
            # would make it a *permanent* one — ensure() short-circuits on a
            # hit, so the broken tile could never self-heal.
            return path if path.stat().st_size > 0 else None
        except OSError:
            return None

    def store(
        self, video_path: Path, frame: Image.Image, mtime: float | None = None
    ) -> Path | None:
        """Write ``frame`` as this video's still. ``None`` if the write failed."""
        return self._store_by_key(self.key_for(video_path, mtime), frame, video_path)

    def _store_by_key(
        self, key: str, frame: Image.Image, video_path: Path | None = None
    ) -> Path | None:
        """Atomically publish ``frame`` under ``key``.

        The temporary name comes from ``mkstemp`` rather than being derived
        from the pid: the indexing ThreadPoolExecutor and a request thread can
        both be storing the same key in the same process, and a pid-derived
        name is identical across threads — two writers would interleave into
        one file and ``os.replace`` would publish the mixture.

        Catches ``Exception``, not just ``OSError``, mirroring what
        ``util.atomic_savez`` does and for the same reason: PIL raises
        ``ValueError`` for a degenerate frame, which would otherwise escape
        past ``ensure()`` (which has no handler of its own) and 500 a request
        that documents a ``None`` fallback — while leaving the temp behind,
        since the cleanup lived in the ``OSError`` branch.
        """
        target = self.directory / f"{key}.jpg"
        tmp_path: Path | None = None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(
                dir=target.parent, prefix=f"{key}.", suffix=".tmp"
            )
            tmp_path = Path(tmp_name)
            with os.fdopen(fd, "wb") as handle:
                frame.convert("RGB").save(
                    handle, format="JPEG", quality=FRAME_JPEG_QUALITY
                )
            os.replace(tmp_path, target)
            return target
        except Exception as e:
            logger.warning(f"Could not cache video frame for {video_path or key}: {e}")
            if tmp_path is not None:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            return None

    def ensure(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """Return the cached still, extracting it first if necessary.

        Lets a wiped or partially-pruned cache self-heal instead of leaving
        broken images in the UI. Under a per-key lock, so a burst of
        concurrent requests for one video spawns ffmpeg once.

        The key is computed **once** and threaded through. Recomputing it at
        each step re-``stat``s the file, so a video whose mtime changes
        mid-call — a still-uploading file, a cloud-sync rewrite — would be
        locked under one key and stored under another, defeating the lock and
        writing an entry nothing would ever look up. It is also one round trip
        instead of four on an SMB/NFS album.
        """
        key = self.key_for(video_path, mtime)
        if (cached := self._get_by_key(key)) is not None:
            return cached

        # Lock on the album-qualified key: the storage path includes the album
        # but the key alone does not, so without this two albums holding the
        # same video would serialize against each other and then both extract
        # anyway — the opposite of what the lock is for. The failure record
        # below is qualified the same way, so one album's bad luck cannot
        # blank another album's tiles.
        scoped = f"{self.album_key}\x00{key}"
        with _lock_for(scoped):
            # Re-check: another thread may have stored it while we waited.
            if (cached := self._get_by_key(key)) is not None:
                return cached
            if _recently_failed(scoped):
                # Negative result. Without it a permanently unextractable
                # video re-spawns ffmpeg on every request — up to two attempts
                # at FRAME_EXTRACT_TIMEOUT_SECONDS each — and since ensure()
                # is blocking, a handful of such files can saturate the
                # threadpool it is offloaded to.
                #
                # Deliberately time-limited rather than permanent. Extraction
                # fails for transient reasons too — a fork failure under
                # memory pressure, an AV scanner holding the binary, a network
                # mount blipping past the timeout — and a permanent record
                # would blank that video's tile and poster until the process
                # restarted or the file's mtime changed. Nothing else clears
                # it: discard() and clear() remove files, not memory.
                return None
            extracted = extract_video_frame(video_path)
            if extracted is None:
                _failed_keys.put(scoped, time.monotonic())
                return None
            frame, _info = extracted
            return self._store_by_key(key, frame, video_path)

    def discard(self, video_path: Path, mtime: float | None = None) -> None:
        """Drop this video's cached still, if present.

        With ``mtime`` omitted the key cannot be recomputed, because the usual
        reason to discard is that the source video has just been deleted — the
        ``stat`` then fails, ``key_for`` falls back to ``mtime=0.0``, and the
        derived name never matches the one written while the file existed. So
        this sweeps the directory for *any* entry belonging to this path
        instead of unlinking a single computed name.
        """
        # Every generation of this path, whatever mtime it was cached at.
        # The key's leading component identifies the path alone, which is what
        # makes this a glob rather than a guess.
        prefix = _path_digest(video_path)
        directory = self.directory
        if not directory.is_dir():
            return
        try:
            stale = list(directory.glob(f"{prefix}-*"))
        except OSError as e:
            logger.debug(f"Could not scan cache for {video_path}: {e}")
            return
        for entry in stale:
            try:
                entry.unlink(missing_ok=True)
            except OSError as e:
                logger.debug(f"Could not remove cached frame for {video_path}: {e}")

    def prune(self, keep_keys: set[str]) -> int:
        """Delete every cached still whose key is not in ``keep_keys``.

        One sweeper covers what would otherwise be seven separate cleanups:
        mtime changes, moves, copies, single and batch deletes, and files
        removed outside the app.  Called when the index has just been written
        and is therefore authoritative.  Returns the number removed.

        Stale ``.tmp`` files are collected too: a crashed or killed writer
        leaves one behind, and they were previously skipped by the suffix
        check and so accumulated forever.
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
            if entry.suffix == ".jpg" and entry.stem in keep_keys:
                continue
            if entry.suffix not in (".jpg", ".tmp"):
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError as e:
                logger.debug(f"Could not remove stale cached frame {entry}: {e}")
        return removed

    def clear(self) -> None:
        """Remove this album's entire frame cache (album deletion).

        ``ignore_errors`` so one undeletable file does not abort the sweep of
        every remaining one and skip the directory removal, which is what the
        previous hand-rolled loop did.
        """
        shutil.rmtree(self.directory, ignore_errors=True)
