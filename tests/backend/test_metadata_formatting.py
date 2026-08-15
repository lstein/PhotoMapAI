"""Tests for the top-level metadata-formatting dispatcher.

The interesting cases here aren't the renderers themselves (those are covered
in ``test_invoke_metadata.py``) but the orchestration: deciding which renderer
to call and conditionally appending the standalone "Use as Ref Image" button
to the non-Invoke paths whenever an InvokeAI backend is configured.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from photomap.backend.config import get_config_manager
from photomap.backend.metadata_formatting import format_metadata
from photomap.backend.metadata_modules import format_duration, format_fps
from photomap.backend.video import VIDEO_METADATA_KEY


@pytest.fixture
def clear_invokeai_config():
    manager = get_config_manager()
    manager.set_invokeai_settings(url=None, username=None, password=None)
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


@pytest.fixture
def with_invokeai_url(clear_invokeai_config):
    manager = get_config_manager()
    manager.set_invokeai_settings(url="http://localhost:9090")
    yield "http://localhost:9090"
    manager.set_invokeai_settings(url=None, username=None, password=None)


def _filepath() -> Path:
    return Path("/tmp/example.png")


class TestNoMetadata:
    def test_renders_placeholder_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), {}, 0, 1)
        assert "No metadata available" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_appends_use_ref_button_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), {}, 0, 1)
        assert "No metadata available" in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        # No Recall/Remix without parameters to recall.
        assert 'data-recall-mode="recall"' not in result.description
        assert 'data-recall-mode="remix"' not in result.description


class TestExifMetadata:
    EXIF = {"Make": "Canon", "Model": "EOS R5", "FNumber": 2.8}

    def test_no_button_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), self.EXIF, 0, 1)
        assert "Canon" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_use_ref_button_added_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), self.EXIF, 0, 1)
        assert "Canon" in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        assert 'data-recall-mode="recall"' not in result.description
        assert 'data-recall-mode="remix"' not in result.description


class TestExifFieldRendering:
    """Verify individual EXIF fields render with expected labels and formatting."""

    def test_datetime_original_rendered_with_date_taken_label(self, clear_invokeai_config):
        metadata = {"DateTimeOriginal": "2021:08:28 13:40:19"}
        result = format_metadata(_filepath(), metadata, 0, 1)
        assert "Date Taken" in result.description
        assert "2021:08:28 13:40:19" in result.description

    def test_orientation_rendered_as_human_readable(self, clear_invokeai_config):
        result = format_metadata(_filepath(), {"Orientation": 1}, 0, 1)
        assert "Orientation" in result.description
        assert "Normal" in result.description

        result = format_metadata(_filepath(), {"Orientation": 6}, 0, 1)
        assert "Rotated 90° CW" in result.description

    def test_exif_image_dimensions_rendered_with_pixel_suffix(self, clear_invokeai_config):
        metadata = {"ExifImageWidth": 2048, "ExifImageHeight": 1536}
        result = format_metadata(_filepath(), metadata, 0, 1)
        assert "2048 pixels" in result.description
        assert "1536 pixels" in result.description

    def test_image_and_exif_image_dimensions_dedupe(self, clear_invokeai_config):
        # When both ImageWidth and ExifImageWidth are present, only one
        # "Width" row should render (ImageWidth wins because it comes first).
        metadata = {"ImageWidth": 4000, "ExifImageWidth": 2048}
        result = format_metadata(_filepath(), metadata, 0, 1)
        assert result.description.count("<th>Width</th>") == 1
        assert "4000 pixels" in result.description
        assert "2048 pixels" not in result.description


class TestInvokeMetadata:
    INVOKE = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "anything",
        "seed": 1,
        "model": {"model_name": "m"},
    }

    def test_no_buttons_without_invokeai(self, clear_invokeai_config):
        result = format_metadata(_filepath(), self.INVOKE, 0, 1)
        assert "anything" in result.description
        assert "invoke-recall-controls" not in result.description

    def test_full_recall_group_when_invokeai_configured(self, with_invokeai_url):
        result = format_metadata(_filepath(), self.INVOKE, 0, 1)
        assert 'data-recall-mode="recall"' in result.description
        assert 'data-recall-mode="remix"' in result.description
        assert 'data-recall-mode="use_ref"' in result.description
        # The use_ref button should be inside the same control group as the
        # recall buttons (one container, three buttons), not a duplicate
        # standalone container appended afterwards.
        assert result.description.count('class="invoke-recall-controls"') == 1


class TestVideoMetadata:
    """Videos get a Video panel, keep any EXIF, and never get the ref button."""

    VIDEO_INFO = {
        "duration": 125.0,
        "fps": 29.97,
        "width": 1920,
        "height": 1080,
        "codec": "h264",
        "container": "mov,mp4,m4a,3gp,3g2,mj2",
        "playable": True,
    }

    def _metadata(self, **extra):
        return {VIDEO_METADATA_KEY: dict(self.VIDEO_INFO), **extra}

    def _video_path(self) -> Path:
        return Path("/tmp/example.mp4")

    def test_marks_the_slide_as_video(self, clear_invokeai_config):
        result = format_metadata(self._video_path(), self._metadata(), 0, 1)
        assert result.media_type == "video"
        assert result.video_info["codec"] == "h264"

    def test_renders_the_video_panel(self, clear_invokeai_config):
        result = format_metadata(self._video_path(), self._metadata(), 0, 1)
        assert "🎬 Video" in result.description
        assert "<th>Duration</th>" in result.description
        assert "2:05" in result.description  # 125s
        assert "29.97 fps" in result.description
        assert "1920 × 1080" in result.description
        assert "h264" in result.description

    def test_keeps_the_exif_panel_alongside(self, clear_invokeai_config):
        """Phone videos carry a creation date and GPS worth showing."""
        result = format_metadata(
            self._video_path(),
            self._metadata(Make="Pixel", DateTimeOriginal="2021:08:28 13:40:19"),
            0,
            1,
        )
        assert "🎬 Video" in result.description
        assert "Pixel" in result.description
        assert "Date Taken" in result.description

    def test_never_offers_the_use_ref_button(self, with_invokeai_url):
        """That button uploads the file to InvokeAI as a reference image.

        Handing it an .mkv is a live bug, so videos must not get it even when
        an InvokeAI backend is configured.
        """
        result = format_metadata(self._video_path(), self._metadata(), 0, 1)
        assert "invoke-recall-controls" not in result.description
        assert 'data-recall-mode="use_ref"' not in result.description

    def test_renders_without_any_probe_details(self, clear_invokeai_config):
        """A video whose banner could not be parsed still renders sensibly."""
        result = format_metadata(self._video_path(), {VIDEO_METADATA_KEY: {}}, 0, 1)
        assert result.media_type == "video"
        assert "No video details available" in result.description

    def test_renders_when_metadata_is_entirely_absent(self, clear_invokeai_config):
        result = format_metadata(self._video_path(), {}, 0, 1)
        assert result.media_type == "video"
        assert "🎬 Video" in result.description

    def test_escapes_hostile_probe_values(self, clear_invokeai_config):
        hostile = {VIDEO_METADATA_KEY: {"codec": "<script>alert(1)</script>"}}
        result = format_metadata(self._video_path(), hostile, 0, 1)
        assert "<script>" not in result.description
        assert "&lt;script&gt;" in result.description

    def test_flags_containers_browsers_cannot_play(self, clear_invokeai_config):
        info = dict(self.VIDEO_INFO, playable=False)
        result = format_metadata(
            Path("/tmp/example.avi"), {VIDEO_METADATA_KEY: info}, 0, 1
        )
        assert "Not supported by browsers" in result.description


class TestVideoDurationAndFpsFormatting:
    @pytest.mark.parametrize(
        "seconds, expected",
        [
            (0, "0:00"),
            (7.4, "0:07"),
            (65, "1:05"),
            (125.0, "2:05"),
            (3725, "1:02:05"),
            (None, "Unknown"),
            (-5, "Unknown"),
            ("nonsense", "Unknown"),
        ],
    )
    def test_format_duration(self, seconds, expected):
        assert format_duration(seconds) == expected

    @pytest.mark.parametrize(
        "fps, expected",
        [
            (30, "30 fps"),
            (30.0, "30 fps"),
            (29.97, "29.97 fps"),
            (None, "Unknown"),
            (0, "Unknown"),
            ("nonsense", "Unknown"),
        ],
    )
    def test_format_fps(self, fps, expected):
        assert format_fps(fps) == expected
