"""On-disk cache of extracted video stills."""

from __future__ import annotations

import os
import threading

import pytest
from fixtures import media_fixture_path
from PIL import Image

from photomap.backend import video_cache as cache_module
from photomap.backend.embeddings import EXCLUDED_SCAN_DIRS
from photomap.backend.video import ffmpeg_exe
from photomap.backend.video_cache import FRAME_CACHE_DIRNAME, VideoFrameCache

requires_ffmpeg = pytest.mark.skipif(
    ffmpeg_exe() is None, reason="no bundled ffmpeg binary on this platform"
)


@pytest.fixture
def cache(tmp_path):
    """A cache rooted in tmp_path so tests never touch the real user cache."""
    return VideoFrameCache("album1", root=tmp_path / "frames")


@pytest.fixture
def video(tmp_path):
    """A copy of the mp4 fixture, so tests may freely change its mtime."""
    dest = tmp_path / "clip.mp4"
    dest.write_bytes(media_fixture_path("clip.mp4").read_bytes())
    return dest


def _frame(color=(10, 20, 30), size=(64, 64)) -> Image.Image:
    return Image.new("RGB", size, color)


# --------------------------------------------------------------------------
# Keying and layout
# --------------------------------------------------------------------------


def test_cache_dir_name_is_excluded_from_indexing_scans():
    """Belt-and-braces: a cache inside an album tree must never be walked.

    Stills are full-resolution, so they pass both the byte and pixel gates —
    they would be indexed as photos, and each would then get a still of its
    own.
    """
    assert FRAME_CACHE_DIRNAME in EXCLUDED_SCAN_DIRS


def test_cache_lives_outside_the_album_tree(video):
    """The default root is the per-user cache dir, not next to the video."""
    default_cache = VideoFrameCache("album1")
    assert FRAME_CACHE_DIRNAME in default_cache.directory.parts
    assert video.parent not in default_cache.directory.parents


def test_key_changes_when_mtime_changes(cache, video):
    before = cache.key_for(video)
    os.utime(video, (0, 12345.0))
    after = cache.key_for(video)
    assert before != after, "an edited video must map to a fresh cache entry"


def test_key_is_stable_for_the_same_path_and_mtime(cache, video):
    assert cache.key_for(video) == cache.key_for(video)


def test_key_distinguishes_different_paths(cache, tmp_path, video):
    other = tmp_path / "other.mp4"
    other.write_bytes(video.read_bytes())
    os.utime(other, (0, video.stat().st_mtime))
    assert cache.key_for(video) != cache.key_for(other)


def test_key_of_missing_file_does_not_raise(cache, tmp_path):
    assert cache.key_for(tmp_path / "gone.mp4")


def test_albums_do_not_share_a_directory(tmp_path, video):
    a = VideoFrameCache("album1", root=tmp_path / "frames")
    b = VideoFrameCache("album2", root=tmp_path / "frames")
    assert a.path_for(video) != b.path_for(video)


@pytest.mark.parametrize("bad_key", ["", "..", "a/b", "a\\b", "a\x00b"])
def test_album_key_cannot_escape_the_cache_root(bad_key, tmp_path):
    """Album keys are user input and land in a filesystem path."""
    with pytest.raises(ValueError):
        VideoFrameCache(bad_key, root=tmp_path)


# --------------------------------------------------------------------------
# store / get / discard
# --------------------------------------------------------------------------


def test_store_then_get_round_trips(cache, video):
    assert cache.get(video) is None
    stored = cache.store(video, _frame())
    assert stored is not None and stored.exists()
    assert cache.get(video) == stored
    assert Image.open(stored).size == (64, 64)


def test_store_creates_the_directory(cache, video):
    assert not cache.directory.exists()
    cache.store(video, _frame())
    assert cache.directory.is_dir()


def test_store_leaves_no_temporary_files(cache, video):
    """A reader must never observe a half-written JPEG."""
    cache.store(video, _frame())
    assert [p.name for p in cache.directory.iterdir() if p.suffix != ".jpg"] == []


def test_store_converts_non_rgb_frames(cache, video):
    stored = cache.store(video, Image.new("RGBA", (32, 32), (1, 2, 3, 4)))
    assert stored is not None
    assert Image.open(stored).mode == "RGB"


def test_discard_removes_the_entry(cache, video):
    cache.store(video, _frame())
    cache.discard(video)
    assert cache.get(video) is None


def test_discard_is_idempotent(cache, video):
    cache.discard(video)
    cache.discard(video)  # must not raise


def test_get_misses_after_the_video_is_edited(cache, video):
    cache.store(video, _frame())
    assert cache.get(video) is not None
    os.utime(video, (0, 999.0))
    assert cache.get(video) is None, "mtime is part of the key"


# --------------------------------------------------------------------------
# ensure
# --------------------------------------------------------------------------


@requires_ffmpeg
def test_ensure_extracts_on_a_cold_cache(cache, video):
    path = cache.ensure(video)
    assert path is not None and path.exists()
    assert Image.open(path).size == (64, 64)


@requires_ffmpeg
def test_ensure_self_heals_after_the_cache_is_wiped(cache, video):
    first = cache.ensure(video)
    first.unlink()
    second = cache.ensure(video)
    assert second is not None and second.exists()
    assert second == first


def test_ensure_reuses_a_cached_frame_without_calling_ffmpeg(
    cache, video, monkeypatch
):
    cache.store(video, _frame())

    def explode(*_a, **_kw):  # pragma: no cover - must not be reached
        raise AssertionError("ffmpeg must not run on a cache hit")

    monkeypatch.setattr(cache_module, "extract_video_frame", explode)
    assert cache.ensure(video) is not None


def test_ensure_returns_none_when_extraction_fails(cache, video, monkeypatch):
    monkeypatch.setattr(cache_module, "extract_video_frame", lambda *_a, **_k: None)
    assert cache.ensure(video) is None


def test_concurrent_ensure_extracts_only_once(cache, video, monkeypatch):
    """A grid painting many tiles must not spawn a herd of ffmpeg processes."""
    calls = []
    barrier = threading.Barrier(4)

    def slow_extract(path, **_kw):
        calls.append(path)
        return _frame(), None

    monkeypatch.setattr(cache_module, "extract_video_frame", slow_extract)

    results = []

    def worker():
        barrier.wait()
        results.append(cache.ensure(video))

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(calls) == 1, f"extracted {len(calls)} times, expected 1"
    assert all(r is not None for r in results)


# --------------------------------------------------------------------------
# prune / clear
# --------------------------------------------------------------------------


def test_prune_keeps_known_keys_and_drops_the_rest(cache, video, tmp_path):
    keep = tmp_path / "keep.mp4"
    keep.write_bytes(video.read_bytes())
    cache.store(video, _frame())
    cache.store(keep, _frame())

    removed = cache.prune({cache.key_for(keep)})

    assert removed == 1
    assert cache.get(keep) is not None
    assert cache.get(video) is None


def test_prune_collects_stale_entries_from_an_edited_video(cache, video):
    """The mtime-keyed orphan left behind by an edit is reclaimed here."""
    cache.store(video, _frame())
    os.utime(video, (0, 4242.0))
    cache.store(video, _frame())
    assert len(list(cache.directory.iterdir())) == 2

    assert cache.prune({cache.key_for(video)}) == 1
    assert cache.get(video) is not None


def test_prune_ignores_foreign_files(cache, video):
    cache.store(video, _frame())
    stray = cache.directory / "README.txt"
    stray.write_text("not ours")
    cache.prune(set())
    assert stray.exists()


def test_prune_on_a_missing_directory_is_a_no_op(cache):
    assert cache.prune({"anything"}) == 0


def test_clear_removes_the_album_directory(cache, video):
    cache.store(video, _frame())
    cache.clear()
    assert not cache.directory.exists()


def test_clear_on_a_missing_directory_is_a_no_op(cache):
    cache.clear()  # must not raise
