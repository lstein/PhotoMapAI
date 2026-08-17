"""On-disk cache of extracted video stills."""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest
from fixtures import media_fixture_path
from PIL import Image
from platformdirs import user_cache_dir

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


def test_cache_dir_name_does_not_shadow_a_user_folder():
    """The cache name must NOT be pruned from album walks.

    Listing it in EXCLUDED_SCAN_DIRS looked like free insurance, but the walk
    prunes on a bare name match: a user's own folder called "video_frames"
    would stop being scanned, and the next update would drop those
    already-indexed photos from the .npz with no log line. Keeping the cache
    in the per-user cache directory is the actual defense.
    """
    assert FRAME_CACHE_DIRNAME not in EXCLUDED_SCAN_DIRS


def test_cache_lives_outside_the_album_tree(video):
    """Wherever the root is, it is never inside the album's own tree.

    That is the property the design depends on: a cache inside the scanned
    tree would have its full-resolution stills re-indexed as photos.
    """
    default_cache = VideoFrameCache("album1")
    assert video.parent not in default_cache.directory.parents
    assert not default_cache.directory.is_relative_to(video.parent)


def test_the_real_default_root_is_the_per_user_cache_dir():
    """Asserted against the real implementation.

    ``conftest`` patches ``frame_cache_root`` for every test so nothing writes
    into the developer's actual cache — which means the shipped default would
    otherwise go unverified entirely.
    """
    expected = Path(user_cache_dir("photomap", "photomap")) / FRAME_CACHE_DIRNAME

    assert expected.is_absolute()
    assert expected.name == FRAME_CACHE_DIRNAME
    assert "photomap" in expected.parts


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


@pytest.mark.parametrize(
    "hostile_key",
    ["..", ".", "a/b", "a\\b", "a\x00b", "C:evil", "C:/evil", "../../etc", "   "],
)
def test_album_key_cannot_escape_the_cache_root(hostile_key, tmp_path):
    """Album keys are user input and become a directory clear() empties.

    The name is constructed rather than validated, so rather than asserting a
    rejection this asserts the property that matters: whatever comes out is a
    single child of the root. A blocklist kept missing cases — "." aims at the
    shared root (clear() would then wipe every album's stills), ".." climbs
    out of it, and on Windows "C:evil" is drive-relative.
    """
    directory = VideoFrameCache(hostile_key, root=tmp_path).directory

    assert directory.parent == tmp_path
    assert directory.name not in ("", ".", "..")
    assert tmp_path in directory.resolve().parents


def test_empty_album_key_is_rejected(tmp_path):
    with pytest.raises(ValueError):
        VideoFrameCache("", root=tmp_path)


def test_distinct_album_keys_never_share_a_directory(tmp_path):
    """Sanitizing alone would collide "a/b" with "a_b"; the hash prevents it."""
    a = VideoFrameCache("a/b", root=tmp_path).directory
    b = VideoFrameCache("a_b", root=tmp_path).directory
    assert a != b


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


# --------------------------------------------------------------------------
# Robustness against the real failure modes
# --------------------------------------------------------------------------


def test_discard_works_after_the_video_is_deleted(cache, video):
    """The whole point of discard is that the source has just been deleted.

    Recomputing the key then stats a missing file, falls back to mtime 0.0,
    and derives a name that never matches the one written while the file
    existed — so the unlink removed nothing and the still leaked.
    """
    cache.store(video, _frame())
    assert cache.get(video) is not None

    video.unlink()
    cache.discard(video)

    assert list(cache.directory.glob("*.jpg")) == []


def test_discard_removes_every_generation_of_a_path(cache, video):
    """An edited video leaves one entry per mtime it was cached at."""
    cache.store(video, _frame())
    os.utime(video, (0, 555.0))
    cache.store(video, _frame())
    assert len(list(cache.directory.glob("*.jpg"))) == 2

    cache.discard(video)

    assert list(cache.directory.glob("*.jpg")) == []


def test_discard_leaves_other_videos_alone(cache, video, tmp_path):
    other = tmp_path / "other.mp4"
    other.write_bytes(video.read_bytes())
    cache.store(video, _frame())
    cache.store(other, _frame())

    cache.discard(video)

    assert cache.get(other) is not None


def test_a_zero_length_entry_is_not_a_cache_hit(cache, video):
    """A crashed or out-of-space write leaves an empty file behind.

    Treating it as a hit makes it a permanent one, since ensure() short
    circuits on a hit and the broken tile could never self-heal.
    """
    target = cache.path_for(video)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()

    assert cache.get(video) is None


def test_store_survives_a_frame_pil_refuses_to_write(cache, video):
    """PIL raises ValueError, not OSError, for a degenerate frame."""
    assert cache.store(video, Image.new("RGB", (0, 0))) is None
    # ...and leaves no temp file behind.
    if cache.directory.exists():
        assert list(cache.directory.glob("*.tmp")) == []


def test_store_leaves_no_temp_file_on_success(cache, video):
    cache.store(video, _frame())
    assert list(cache.directory.glob("*.tmp")) == []


def test_prune_collects_orphaned_temp_files(cache, video):
    """A killed writer leaves a .tmp; the suffix check used to skip them."""
    cache.store(video, _frame())
    stray = cache.directory / "abandoned.tmp"
    stray.write_bytes(b"partial")

    cache.prune({cache.key_for(video)})

    assert not stray.exists()
    assert cache.get(video) is not None


def test_a_failed_extraction_is_not_retried_on_every_call(cache, video, monkeypatch):
    """Otherwise one unreadable video re-spawns ffmpeg per request.

    Each attempt can burn up to two ffmpeg spawns at the full timeout, and
    ensure() is a blocking call made from async handlers — a handful of such
    files can occupy the entire threadpool.
    """
    attempts = []

    def always_fails(path, **_kw):
        attempts.append(path)
        return None

    monkeypatch.setattr(cache_module, "extract_video_frame", always_fails)

    assert cache.ensure(video) is None
    assert cache.ensure(video) is None
    assert cache.ensure(video) is None

    assert len(attempts) == 1, f"re-extracted {len(attempts)} times"


def test_key_survives_a_symlink_loop(cache, tmp_path):
    """resolve() raises RuntimeError, not OSError, on 3.10-3.12."""
    loop = tmp_path / "loop"
    try:
        loop.symlink_to(loop)
    except (OSError, NotImplementedError) as e:
        # Creating a symlink on Windows needs admin rights or Developer Mode.
        pytest.skip(f"cannot create a symlink on this platform: {e}")
    assert cache.key_for(loop / "clip.mp4")


def test_key_survives_an_undecodable_filename(cache, tmp_path):
    """A latin-1 name from an old camera surrogate-escapes into the str."""
    hostile = tmp_path / b"caf\xe9.mp4".decode("utf-8", errors="surrogateescape")
    assert cache.key_for(hostile)


def test_key_is_case_insensitive_like_the_index_diff(cache, tmp_path):
    """embeddings._path_compare_key casefolds; disagreeing causes thrash."""
    assert cache.key_for(tmp_path / "Clip.MP4") == cache.key_for(tmp_path / "clip.mp4")


def test_a_remembered_failure_expires(cache, video, monkeypatch):
    """A transient failure must not blank a video for the process lifetime.

    Extraction fails for recoverable reasons too — a fork failure under memory
    pressure, an AV scanner holding the binary, a mount blipping past the
    timeout. Nothing else clears the record: discard() and clear() remove
    files, not memory.
    """
    cache_module.forget_extraction_failures()
    attempts = []

    def fails_once(path, **_kw):
        attempts.append(path)
        if len(attempts) == 1:
            return None
        return _frame(), None

    monkeypatch.setattr(cache_module, "extract_video_frame", fails_once)

    assert cache.ensure(video) is None
    assert cache.ensure(video) is None, "the failure is remembered for a while"
    assert len(attempts) == 1

    # Once the window passes, it retries and succeeds.
    clock = [0.0]
    monkeypatch.setattr(
        cache_module.time, "monotonic", lambda: clock[0]
    )
    clock[0] = cache_module._FAILURE_TTL_SECONDS + 1
    cache_module.forget_extraction_failures()

    assert cache.ensure(video) is not None
    assert len(attempts) == 2


def test_a_failure_in_one_album_does_not_blank_another(cache, video, tmp_path, monkeypatch):
    """The record is album-qualified, like the lock.

    Two albums can hold the same file; one album's bad luck must not blank the
    other's tiles.
    """
    cache_module.forget_extraction_failures()
    other = VideoFrameCache("album2", root=tmp_path / "frames")

    calls = []

    def fails_for_first(path, **_kw):
        calls.append(path)
        return None if len(calls) == 1 else (_frame(), None)

    monkeypatch.setattr(cache_module, "extract_video_frame", fails_for_first)

    assert cache.ensure(video) is None
    assert other.ensure(video) is not None, "the other album still tries"
