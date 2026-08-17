"""Still-frame extraction and banner probing.

The fixtures under ``test_media/`` are deliberately tiny and purpose-built:

``clip.mp4``     2s @10fps, 64x64 — red for the first second, blue for the
                 second, so a test can prove the 1.0s seek landed past frame 0.
``short.mp4``    0.2s — shorter than the seek, so it exercises the fallback.
``clip.webm``    a second container.
``rotated.mp4``  encoded 64x32 with a 90-degree display matrix, so the decoded
                 frame is 32x64 and the banner's dimensions are wrong.
``broken.mp4``   a truncated ``clip.mp4``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fixtures import media_fixture_path
from PIL import Image

from photomap.backend import video as video_module
from photomap.backend.video import (
    MAX_FRAME_EDGE,
    VideoInfo,
    _has_decodable_video_stream,
    _parse_ffmpeg_banner,
    extract_video_frame,
    ffmpeg_exe,
)

# A representative banner, captured from the bundled ffmpeg. Parser tests run
# against this fixed string so they need no binary at all.
SAMPLE_BANNER = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf61.1.100
  Duration: 00:01:05.50, start: 0.000000, bitrate: 8 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x480 [SAR 1:1 DAR 4:3], 4 kb/s, 29.97 fps, 30 tbr, 10240 tbn (default)
      Metadata:
        handler_name    : VideoHandler
"""


requires_ffmpeg = pytest.mark.skipif(
    ffmpeg_exe() is None, reason="no bundled ffmpeg binary on this platform"
)


# --------------------------------------------------------------------------
# Banner parsing (no ffmpeg required)
# --------------------------------------------------------------------------


def test_parse_banner_extracts_duration_fps_codec_container():
    info = _parse_ffmpeg_banner(SAMPLE_BANNER)
    assert info["container"] == "mov,mp4,m4a,3gp,3g2,mj2"
    assert info["duration"] == pytest.approx(65.5)
    assert info["codec"] == "h264"
    assert info["fps"] == pytest.approx(29.97)


def test_parse_banner_never_reports_dimensions():
    """Dimensions must come from the decoded frame, never the banner.

    ffmpeg autorotates on decode, so a portrait phone video's banner reports
    the pre-rotation size. Asserting the parser has no opinion at all makes
    that structural rather than merely tested.
    """
    info = _parse_ffmpeg_banner(SAMPLE_BANNER)
    assert "width" not in info
    assert "height" not in info


def test_parse_banner_tolerates_missing_duration_line():
    banner = SAMPLE_BANNER.replace(
        "  Duration: 00:01:05.50, start: 0.000000, bitrate: 8 kb/s\n", ""
    )
    info = _parse_ffmpeg_banner(banner)
    assert "duration" not in info
    # The other fields still parse — one miss degrades one field.
    assert info["codec"] == "h264"
    assert info["container"] == "mov,mp4,m4a,3gp,3g2,mj2"


def test_parse_banner_of_garbage_returns_empty_dict():
    assert _parse_ffmpeg_banner("not a banner at all") == {}


def test_parse_banner_returns_plain_python_scalars():
    """``/get_metadata`` runs json.dumps over the metadata dict."""
    import json

    info = _parse_ffmpeg_banner(SAMPLE_BANNER)
    json.dumps(info)  # must not raise
    assert type(info["duration"]) is float
    assert type(info["fps"]) is float
    assert type(info["codec"]) is str


def test_parse_banner_ignores_audio_stream_numbers():
    """The fps must be read from the video stream line, not an audio one."""
    banner = SAMPLE_BANNER + (
        "  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s\n"
    )
    info = _parse_ffmpeg_banner(banner)
    assert info["fps"] == pytest.approx(29.97)


# --------------------------------------------------------------------------
# Frame extraction
# --------------------------------------------------------------------------


@requires_ffmpeg
def test_extract_returns_rgb_frame_and_populated_info():
    result = extract_video_frame(media_fixture_path("clip.mp4"))
    assert result is not None
    frame, info = result

    assert isinstance(frame, Image.Image)
    assert frame.mode == "RGB"
    assert frame.size == (64, 64)

    assert isinstance(info, VideoInfo)
    assert info.duration == pytest.approx(2.0, abs=0.2)
    assert info.fps == pytest.approx(10.0)
    assert info.codec == "h264"
    assert info.width == 64 and info.height == 64
    assert info.playable is True


@requires_ffmpeg
def test_extract_seeks_past_the_opening_frames():
    """The 1.0s seek must land in the blue half, not the red opening second.

    Frame 0 of consumer video is very often black or a fade-in, which is a
    poor CLIP subject; this asserts the seek actually happens.
    """
    frame, _info = extract_video_frame(media_fixture_path("clip.mp4"))
    r, g, b = frame.getpixel((32, 32))
    assert b > 200 and r < 60, f"expected blue, got {(r, g, b)}"


@requires_ffmpeg
def test_extract_falls_back_to_first_frame_for_sub_second_video():
    """short.mp4 is 0.2s, so seeking to 1.0s yields nothing on attempt 1."""
    result = extract_video_frame(media_fixture_path("short.mp4"))
    assert result is not None
    frame, info = result
    assert frame.size == (48, 32)
    r, g, b = frame.getpixel((24, 16))
    assert g > 100 and r < 100, f"expected green, got {(r, g, b)}"
    assert info.width == 48 and info.height == 32


@requires_ffmpeg
def test_extract_uses_decoded_size_not_banner_size():
    """rotated.mp4's banner says 64x32; ffmpeg autorotates to 32x64."""
    frame, info = extract_video_frame(media_fixture_path("rotated.mp4"))
    assert frame.size == (32, 64)
    assert (info.width, info.height) == (32, 64)


@requires_ffmpeg
def test_extract_handles_a_second_container():
    frame, info = extract_video_frame(media_fixture_path("clip.webm"))
    assert frame.size == (64, 64)
    assert info.container is not None and "webm" in info.container.lower()
    assert info.playable is True


@requires_ffmpeg
def test_extract_returns_none_for_truncated_file():
    assert extract_video_frame(media_fixture_path("broken.mp4")) is None


@requires_ffmpeg
def test_extract_returns_none_for_a_non_video(tmp_path):
    junk = tmp_path / "notes.mp4"
    junk.write_text("this is not a video")
    assert extract_video_frame(junk) is None


@requires_ffmpeg
def test_extract_returns_none_for_missing_file(tmp_path):
    assert extract_video_frame(tmp_path / "nope.mp4") is None


@requires_ffmpeg
def test_extract_downscales_oversized_frames(monkeypatch):
    """A 4K still would otherwise be megabytes on disk and over the wire."""
    monkeypatch.setattr(video_module, "MAX_FRAME_EDGE", 32)
    frame, _info = extract_video_frame(media_fixture_path("clip.mp4"))
    assert max(frame.size) <= 32


def test_reported_resolution_is_the_source_not_the_thumbnail(monkeypatch):
    """VideoInfo must describe the video, not the downscaled poster.

    thumbnail() resizes in place, so reading frame.width after it would label
    every 4K video 2048-wide — and the cap is applied to the very frames whose
    true resolution matters most.
    """
    monkeypatch.setattr(video_module, "MAX_FRAME_EDGE", 32)
    frame, info = extract_video_frame(media_fixture_path("clip.mp4"))

    assert max(frame.size) <= 32, "the stored frame is still capped"
    assert (info.width, info.height) == (64, 64), "but the source size is reported"


@requires_ffmpeg
def test_max_frame_edge_is_sane():
    assert MAX_FRAME_EDGE >= 512


@requires_ffmpeg
def test_extract_returns_none_on_timeout():
    """A wedged ffmpeg must be killed and skipped, not hang indexing."""
    result = extract_video_frame(media_fixture_path("clip.mp4"), timeout=0.001)
    assert result is None


def test_extract_returns_none_when_ffmpeg_unavailable(monkeypatch):
    """On musl/armv7/win_arm64 the sdist ships no binary.

    Videos must then be skipped cleanly — one warning, image indexing
    untouched — rather than raising once per file inside a worker thread.
    """
    monkeypatch.setattr(video_module, "ffmpeg_exe", lambda: None)
    assert extract_video_frame(media_fixture_path("clip.mp4")) is None


@requires_ffmpeg
def test_playable_flag_reflects_container(tmp_path):
    """Index-only containers are still extracted, just flagged unplayable."""
    avi = tmp_path / "clip.avi"
    avi.write_bytes(media_fixture_path("clip.mp4").read_bytes())
    # Content is really an mp4; ffmpeg sniffs content, not the extension, so
    # extraction succeeds and only the playability hint follows the suffix.
    result = extract_video_frame(avi)
    assert result is not None
    _frame, info = result
    assert info.playable is False


@requires_ffmpeg
def test_ffmpeg_exe_is_cached():
    """Resolved once per process rather than per video file."""
    assert ffmpeg_exe() == ffmpeg_exe()


@requires_ffmpeg
def test_ffmpeg_exe_resolves_to_an_executable_path():
    """A bare name from PATH is resolved, not handed back unusable.

    get_ffmpeg_exe() returns $IMAGEIO_FFMPEG_EXE unvalidated and can fall back
    to the literal string "ffmpeg", so a non-None answer is not on its own
    evidence anything can be run.
    """
    exe = ffmpeg_exe()
    assert os.path.isabs(exe)
    assert Path(exe).exists()


def test_a_transient_probe_failure_is_not_cached(monkeypatch):
    """A fork failure under memory pressure must not disable video forever."""
    video_module._reset_ffmpeg_exe_cache()
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise OSError("Cannot allocate memory")
        return "/usr/bin/ffmpeg"

    import imageio_ffmpeg

    monkeypatch.setattr(imageio_ffmpeg, "get_ffmpeg_exe", flaky)
    assert video_module.ffmpeg_exe() is None
    # The next call retries rather than returning the memoized failure.
    monkeypatch.setattr(Path, "exists", lambda self: True)
    assert video_module.ffmpeg_exe() == "/usr/bin/ffmpeg"
    video_module._reset_ffmpeg_exe_cache()


@requires_ffmpeg
def test_ffmpeg_exe_points_at_a_real_binary():
    assert Path(ffmpeg_exe()).exists()


# --------------------------------------------------------------------------
# Banner parsing against hostile input
# --------------------------------------------------------------------------

# A real banner shape: ffmpeg prints the file's OWN tags, in a Metadata block,
# BEFORE the Duration and Stream lines it generates itself.
HOSTILE_BANNER = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Metadata:
    major_brand     : isom
    comment         : Duration: 12:34:56.00
    description     : Stream #0:0: Video: fakecodec, 999 fps
  Duration: 00:00:02.00, start: 0.000000, bitrate: 8 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 64x64, 10 fps, 10 tbr (default)
      Metadata:
        handler_name    : VideoHandler
"""


def test_metadata_tags_cannot_hijack_the_duration():
    """Tags are file-controlled, so any downloaded video can carry these."""
    info = _parse_ffmpeg_banner(HOSTILE_BANNER)
    assert info["duration"] == pytest.approx(2.0)


def test_metadata_tags_cannot_hijack_the_codec_or_fps():
    info = _parse_ffmpeg_banner(HOSTILE_BANNER)
    assert info["codec"] == "h264"
    assert info["fps"] == pytest.approx(10.0)


def test_a_tag_holding_newlines_cannot_fake_a_report_line():
    """Blocks are found by indentation, so an embedded newline doesn't help."""
    banner = HOSTILE_BANNER.replace(
        "    comment         : Duration: 12:34:56.00",
        "    comment         : multi\n      Duration: 44:44:44.00",
    )
    assert _parse_ffmpeg_banner(banner)["duration"] == pytest.approx(2.0)


def test_a_path_containing_the_delimiter_does_not_leak_into_the_container():
    """Greedy matching spliced the user's absolute path into the container."""
    banner = (
        "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from "
        "'/photos/Trip, from Rome/clip.mp4':\n"
        "  Duration: 00:00:02.00, start: 0.000000, bitrate: 8 kb/s\n"
    )
    container = _parse_ffmpeg_banner(banner)["container"]
    assert container == "mov,mp4,m4a,3gp,3g2,mj2"
    assert "/photos" not in container


def test_an_absurd_duration_costs_only_that_field():
    """int(h)*3600 on a bignum raises OverflowError on the float conversion."""
    banner = "  Duration: " + "9" * 400 + ":00:00.00, start: 0.0\n"
    info = _parse_ffmpeg_banner(banner)
    assert "duration" not in info


def test_cover_art_is_not_treated_as_a_video_stream():
    """An .ogg is usually audio; its album art is offered as a video stream."""
    banner = (
        "Input #0, ogg, from 'song.ogg':\n"
        "  Duration: 00:03:12.00, start: 0.000000, bitrate: 128 kb/s\n"
        "  Stream #0:0: Audio: vorbis, 44100 Hz, stereo, fltp, 128 kb/s\n"
        "  Stream #0:1: Video: mjpeg (attached pic), yuvj420p, 600x600, 90k tbr\n"
    )
    assert _has_decodable_video_stream(banner) is False


def test_a_real_video_stream_is_recognized():
    assert _has_decodable_video_stream(HOSTILE_BANNER) is True
