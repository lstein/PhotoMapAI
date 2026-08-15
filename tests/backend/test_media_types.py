"""Media-type taxonomy invariants.

``embeddings.SUPPORTED_EXTENSIONS`` used to be one set doing two jobs — the
indexing walk filter *and* the arbitrary-file-read guard on the serving
endpoints.  These tests lock in the split so a future change that widens the
walk (to pick up videos) cannot silently widen the serving allowlist too.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from photomap.backend.embeddings import SUPPORTED_EXTENSIONS
from photomap.backend.media_types import (
    IMAGE_EXTENSIONS,
    INDEXABLE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    VIDEO_MEDIA_TYPES,
    WEB_PLAYABLE_EXTENSIONS,
    is_image,
    is_video,
    is_web_playable,
    media_type_for,
    video_media_type,
)


def test_image_and_video_sets_are_disjoint():
    """A suffix must classify as exactly one media type."""
    assert IMAGE_EXTENSIONS & VIDEO_EXTENSIONS == frozenset()


def test_supported_extensions_still_means_images_only():
    """The serving guard's allowlist must not have gained video suffixes.

    ``SUPPORTED_EXTENSIONS`` guards ``/images/`` and ``/image_by_name/``.
    Widening it is how the add_album → arbitrary-file-read chain reopens.
    """
    assert SUPPORTED_EXTENSIONS == IMAGE_EXTENSIONS
    assert not (SUPPORTED_EXTENSIONS & VIDEO_EXTENSIONS)


def test_indexable_extensions_is_the_union():
    assert INDEXABLE_EXTENSIONS == IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def test_web_playable_is_a_subset_of_video_extensions():
    assert WEB_PLAYABLE_EXTENSIONS <= VIDEO_EXTENSIONS


def test_every_extension_is_normalized_lowercase_with_dot():
    for ext in INDEXABLE_EXTENSIONS:
        assert ext.startswith("."), ext
        assert ext == ext.lower(), ext


def test_every_video_extension_has_an_explicit_media_type():
    """No video suffix may fall through to the octet-stream default.

    ``mimetypes.guess_type`` is deliberately not used (it maps ``.ogg`` to
    ``audio/ogg`` and can return ``None`` on Windows), so the explicit table
    has to stay complete.
    """
    assert set(VIDEO_MEDIA_TYPES) == set(VIDEO_EXTENSIONS)


def test_ogg_is_served_as_video_not_audio():
    """Regression: the stdlib mimetypes table calls ``.ogg`` ``audio/ogg``."""
    assert video_media_type(Path("clip.ogg")) == "video/ogg"
    assert video_media_type(Path("clip.mp4")) == "video/mp4"


@pytest.mark.parametrize(
    "name, expected",
    [
        ("clip.mp4", "video"),
        ("CLIP.MP4", "video"),
        ("clip.MoV", "video"),
        ("photo.jpg", "image"),
        ("PHOTO.JPEG", "image"),
        ("notes.txt", "image"),  # unknown suffixes keep the pre-video behavior
        ("no_suffix", "image"),
    ],
)
def test_media_type_for_is_case_insensitive(name, expected):
    assert media_type_for(Path(name)) == expected


def test_classifiers_accept_str_and_path():
    assert is_video("a/b/clip.MP4") is True
    assert is_video(Path("a/b/clip.MP4")) is True
    assert is_image("a/b/photo.PNG") is True
    assert is_image(Path("a/b/clip.mp4")) is False


def test_web_playable_flags_index_only_containers():
    assert is_web_playable(Path("clip.mp4")) is True
    assert is_web_playable(Path("clip.avi")) is False
    assert is_web_playable(Path("clip.mkv")) is False
    # ...but they are still indexable.
    assert is_video(Path("clip.avi")) is True
    assert Path("clip.mkv").suffix in INDEXABLE_EXTENSIONS


def test_bundled_ffmpeg_binary_is_available():
    """Smoke test: the platform wheel actually ships a usable ffmpeg.

    ``imageio-ffmpeg``'s sdist contains no binary, so on platforms without a
    wheel (musl, linux armv7, win_arm64) ``get_ffmpeg_exe()`` raises at
    runtime.  A skip here is the honest answer for such a platform; a failure
    on a CI leg that *should* have a wheel is a real signal.
    """
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    try:
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover - platform dependent
        pytest.skip(f"no bundled ffmpeg binary on this platform: {e}")
    assert Path(exe).exists()
