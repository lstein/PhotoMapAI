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
    INDEXING = "indexing"
    UMAPPING = "mapping"
    CURATING = "curating"
    COMPLETED = "completed"
    ERROR = "error"


@dataclass
class ProgressInfo:
    album_key: str
    status: IndexStatus
    current_step: str
    images_processed: int
    total_images: int
    start_time: float
    error_message: str | None = None

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

    def set_error(self, album_key: str, error_message: str):
        """Set error status for an album."""
        with self._lock:
            if album_key in self._progress:
                progress = self._progress[album_key]
                progress.status = IndexStatus.ERROR
                progress.error_message = error_message

    def get_progress(self, album_key: str) -> ProgressInfo | None:
        """Get progress info for an album."""
        with self._lock:
            return self._progress.get(album_key)

    def remove_progress(self, album_key: str):
        """Remove progress tracking for an album."""
        with self._lock:
            self._progress.pop(album_key, None)

    def is_running(self, album_key: str) -> bool:
        """Check if an operation is currently running for an album."""
        with self._lock:
            progress = self._progress.get(album_key)
            return progress is not None and progress.status in [
                IndexStatus.SCANNING,
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


# Global instance
progress_tracker = ProgressTracker()
