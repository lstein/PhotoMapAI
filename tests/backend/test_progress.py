"""Unit tests for the indexing progress tracker, focused on the model-download
phase added so first-install weight downloads are surfaced in the UI."""

from __future__ import annotations

from photomap.backend.progress import IndexStatus, ProgressTracker


def test_report_download_sets_downloading_phase():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=10, operation_type="indexing")

    tracker.report_download("alb", downloaded=512, total=2048)

    progress = tracker.get_progress("alb")
    assert progress is not None
    assert progress.status is IndexStatus.DOWNLOADING
    assert progress.images_processed == 512
    assert progress.total_images == 2048
    # Byte counts reuse the image fields, so the percentage machinery works as-is.
    assert progress.progress_percentage == 25.0


def test_report_download_unknown_total_is_zero():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=10, operation_type="indexing")

    tracker.report_download("alb", downloaded=100, total=None)

    progress = tracker.get_progress("alb")
    assert progress is not None
    assert progress.total_images == 0
    # Avoids divide-by-zero; an unknown total reads as 0% (UI shimmer still moves).
    assert progress.progress_percentage == 0.0


def test_report_download_resets_start_time_only_on_first_transition():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=10, operation_type="indexing")

    tracker.report_download("alb", downloaded=10, total=100)
    first_start = tracker.get_progress("alb").start_time

    tracker.report_download("alb", downloaded=50, total=100)
    # Still downloading -> start_time must not be reset again, so the byte-rate
    # ETA keeps accumulating over the whole download.
    assert tracker.get_progress("alb").start_time == first_start


def test_report_download_preserves_cancel_flag():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=10, operation_type="indexing")
    tracker.request_cancel("alb")

    tracker.report_download("alb", downloaded=10, total=100)

    assert tracker.is_cancel_requested("alb") is True


def test_report_download_noop_for_unknown_album():
    tracker = ProgressTracker()
    # Must not raise / create an entry for an album that isn't being tracked.
    tracker.report_download("ghost", downloaded=10, total=100)
    assert tracker.get_progress("ghost") is None


def test_begin_indexing_transitions_back_from_downloading():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=42, operation_type="indexing")
    tracker.report_download("alb", downloaded=2048, total=2048)

    tracker.begin_indexing("alb", total_images=42)

    progress = tracker.get_progress("alb")
    assert progress is not None
    assert progress.status is IndexStatus.INDEXING
    assert progress.images_processed == 0
    assert progress.total_images == 42


def test_begin_indexing_preserves_cancel_flag():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=42, operation_type="indexing")
    tracker.request_cancel("alb")

    tracker.begin_indexing("alb", total_images=42)

    assert tracker.is_cancel_requested("alb") is True


def test_is_running_includes_downloading():
    tracker = ProgressTracker()
    tracker.start_operation("alb", total_images=10, operation_type="indexing")
    tracker.report_download("alb", downloaded=1, total=100)

    # A download is an active operation, so a duplicate index must stay blocked.
    assert tracker.is_running("alb") is True
