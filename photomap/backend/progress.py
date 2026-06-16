"""
Progress tracking module for indexing operations in Clipslide.
This module provides a global progress tracker for indexing operations,
allowing for tracking the status, progress, and estimated time remaining
for each album being processed."""

import logging
import threading
import time
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class IndexStatus(Enum):
    IDLE = "idle"
    SCANNING = "scanning"
    DOWNLOADING = "downloading"
    INDEXING = "indexing"
    UMAPPING = "mapping"
    CURATING = "curating"
    COMPLETED = "completed"
    ERROR = "error"


class IndexingCancelled(Exception):
    """Raised by ``_process_images_batch`` when a cancel was requested via
    :meth:`ProgressTracker.request_cancel`. The async indexing wrappers
    catch it and finish cleanly instead of writing a partial index."""


@dataclass
class ProgressInfo:
    album_key: str
    status: IndexStatus
    current_step: str
    images_processed: int
    total_images: int
    start_time: float
    error_message: str | None = None
    # Non-fatal notice shown alongside a COMPLETED status (e.g. "2 images
    # listed by InvokeAI were not found on disk and were skipped"). Distinct
    # from ``error_message``, which marks the run as failed.
    warning_message: str | None = None

    @property
    def progress_percentage(self) -> float:
        if self.total_images == 0:
            return 0.0
        return (self.images_processed / self.total_images) * 100

    @property
    def elapsed_time(self) -> float:
        return time.time() - self.start_time

    @property
    def estimated_time_remaining(self) -> float | None:
        if self.images_processed == 0:
            return None
        rate = self.images_processed / self.elapsed_time
        remaining_images = self.total_images - self.images_processed
        return remaining_images / rate if rate > 0 else None


class ProgressTracker:
    """Global progress tracker for indexing operations.

    Mutators run on FastAPI background threads (one per active index/curation)
    while readers come from the request thread, so every method that touches
    ``self._progress`` takes ``self._lock`` to avoid torn reads of
    ``ProgressInfo`` fields and lost writes when two batches update the same
    album concurrently.
    """

    def __init__(self):
        self._progress: dict[str, ProgressInfo] = {}
        # Album keys with an outstanding cancellation request. The indexing
        # loop polls this each batch via ``is_cancel_requested`` and raises
        # ``IndexingCancelled`` so the work stops before the next forward
        # pass, instead of running to completion only to have the status
        # flipped to ERROR after.
        self._cancel_requested: set[str] = set()
        # Pending non-fatal notices, set before/while a run is in flight and
        # folded into the ProgressInfo when the run completes (see
        # ``complete_operation``). Kept separate from ``_progress`` because the
        # per-phase ``start_operation`` calls recreate ProgressInfo and would
        # otherwise wipe a warning recorded earlier in the same run.
        self._completion_warnings: dict[str, str] = {}
        self._lock = threading.Lock()

    def start_operation(self, album_key: str, total_images: int, operation_type: str):
        """Start tracking progress for an album."""
        with self._lock:
            self._progress[album_key] = ProgressInfo(
                album_key=album_key,
                status=IndexStatus(operation_type),
                current_step=f"Starting {operation_type}",
                images_processed=0,
                total_images=total_images,
                start_time=time.time(),
            )
            # A new run clears any stale cancel flag from a previous job
            # that finished or errored before the user pressed cancel.
            self._cancel_requested.discard(album_key)

    def update_total_images(self, album_key: str, total_images: int):
        """Update the total number of images for an operation."""
        with self._lock:
            if album_key in self._progress:
                self._progress[album_key].total_images = total_images

    def update_progress(
        self, album_key: str, images_processed: int, current_step: str = ""
    ):
        """Update progress for an album."""
        with self._lock:
            if album_key in self._progress:
                progress = self._progress[album_key]
                progress.images_processed = images_processed
                progress.current_step = current_step
                if (
                    images_processed >= progress.total_images
                    and progress.status != IndexStatus.SCANNING
                ):
                    progress.status = IndexStatus.COMPLETED

    def report_download(
        self,
        album_key: str,
        downloaded: int,
        total: int | None,
        message: str = "Downloading encoder model…",
    ) -> None:
        """Surface encoder-weight download progress as a DOWNLOADING phase.

        ``downloaded``/``total`` are *byte* counts (``total`` may be ``None`` when
        the server omits ``Content-Length``); they reuse the
        ``images_processed``/``total_images`` fields so the existing percentage
        and ETA machinery drives the UI bar without special-casing. On the first
        transition into DOWNLOADING the start time is reset so the byte-rate ETA
        reflects the download rather than the preceding scan. The cancel flag is
        deliberately left untouched.
        """
        with self._lock:
            progress = self._progress.get(album_key)
            if progress is None:
                return
            if progress.status != IndexStatus.DOWNLOADING:
                progress.start_time = time.time()
            progress.status = IndexStatus.DOWNLOADING
            progress.images_processed = max(downloaded, 0)
            progress.total_images = total if total and total > 0 else 0
            progress.current_step = message

    def begin_indexing(self, album_key: str, total_images: int) -> None:
        """Transition an album into the INDEXING phase.

        Used to flip back from DOWNLOADING once the encoder is ready and image
        encoding starts. Resets the processed count and start time (so the ETA
        excludes any preceding download) but leaves the cancel flag intact.
        """
        with self._lock:
            progress = self._progress.get(album_key)
            if progress is None:
                return
            progress.status = IndexStatus.INDEXING
            progress.images_processed = 0
            progress.total_images = total_images
            progress.current_step = "Starting indexing"
            progress.start_time = time.time()

    def set_error(self, album_key: str, error_message: str):
        """Set error status for an album."""
        with self._lock:
            if album_key in self._progress:
                progress = self._progress[album_key]
                progress.status = IndexStatus.ERROR
                progress.error_message = error_message

    def set_completion_warning(self, album_key: str, message: str | None) -> None:
        """Record (or clear) a non-fatal notice to attach when the run completes.

        Called before indexing starts — e.g. once a board album's missing-on-disk
        count is known — so it survives the per-phase ``start_operation`` resets
        and is folded in atomically by ``complete_operation``. A falsy
        ``message`` clears any pending notice so a clean re-run doesn't inherit
        a stale one.
        """
        with self._lock:
            if message:
                self._completion_warnings[album_key] = message
            else:
                self._completion_warnings.pop(album_key, None)

    def get_progress(self, album_key: str) -> ProgressInfo | None:
        """Get progress info for an album."""
        with self._lock:
            return self._progress.get(album_key)

    def remove_progress(self, album_key: str):
        """Remove progress tracking for an album."""
        with self._lock:
            self._progress.pop(album_key, None)
            self._cancel_requested.discard(album_key)
            self._completion_warnings.pop(album_key, None)

    def request_cancel(self, album_key: str) -> None:
        """Signal the indexing loop to stop on its next batch boundary.

        The actual cancellation is cooperative — see ``IndexingCancelled``.
        Set even if no operation is currently running (e.g. cancel hits just
        as indexing finishes); ``start_operation`` clears the flag the next
        time the album is indexed.
        """
        with self._lock:
            self._cancel_requested.add(album_key)

    def is_cancel_requested(self, album_key: str) -> bool:
        """Return True if a cancel was requested for ``album_key``."""
        with self._lock:
            return album_key in self._cancel_requested

    def is_running(self, album_key: str) -> bool:
        """Check if an operation is currently running for an album."""
        with self._lock:
            progress = self._progress.get(album_key)
            return progress is not None and progress.status in [
                IndexStatus.SCANNING,
                IndexStatus.DOWNLOADING,
                IndexStatus.INDEXING,
                IndexStatus.UMAPPING,
                IndexStatus.CURATING,
            ]

    def complete_operation(
        self, album_key: str, message: str = "Operation completed"
    ) -> None:
        """Mark an operation as completed."""
        with self._lock:
            if album_key in self._progress:
                progress = self._progress[album_key]
                progress.status = IndexStatus.COMPLETED
                progress.current_step = message
                progress.images_processed = progress.total_images
                # Fold in (and consume) any pending non-fatal notice so it
                # lands atomically with the COMPLETED status the poller reads.
                progress.warning_message = self._completion_warnings.pop(
                    album_key, None
                )


# Global instance
progress_tracker = ProgressTracker()
