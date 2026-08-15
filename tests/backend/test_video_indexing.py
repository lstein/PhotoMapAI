"""End-to-end: the directory walk now collects videos.

This is the PR that turns the feature on, so these are the tests that prove a
video actually makes it from disk into the index, gets a still, and behaves
like a photo everywhere downstream.
"""

from __future__ import annotations

import shutil

import numpy as np
import pytest
from fixtures import (
    build_index,
    count_test_images,
    count_test_media,
    media_fixture_path,
    poll_during_indexing,
)

from photomap.backend.embeddings import Embeddings, _open_npz_file
from photomap.backend.video import VIDEO_METADATA_KEY, ffmpeg_exe
from photomap.backend.video_cache import VideoFrameCache

TEST_IMAGE_COUNT = count_test_images()
TEST_MEDIA_COUNT = count_test_media()

# broken.mp4 is deliberately truncated, so it is skipped rather than indexed.
EXPECTED_VIDEO_COUNT = TEST_MEDIA_COUNT - 1
EXPECTED_TOTAL = TEST_IMAGE_COUNT + EXPECTED_VIDEO_COUNT

pytestmark = pytest.mark.skipif(
    ffmpeg_exe() is None, reason="no bundled ffmpeg binary on this platform"
)


@pytest.fixture(autouse=True)
def _clear_frame_cache():
    yield
    VideoFrameCache("test_media_album").clear()


def _index_filenames(album) -> list[str]:
    data = Embeddings.open_cached_embeddings(album["index"])
    return [str(f) for f in data["filenames"]]


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------


def test_directory_scan_indexes_videos_alongside_images(client, new_media_album):
    build_index(client, new_media_album)

    names = {f.rsplit("/", 1)[-1] for f in _index_filenames(new_media_album)}

    assert "clip.mp4" in names
    assert "clip.webm" in names
    assert "building1.jpeg" in names
    assert len(names) == EXPECTED_TOTAL


def test_unreadable_video_is_skipped_without_aborting(client, new_media_album):
    """A truncated file must not take the rest of the album down with it."""
    build_index(client, new_media_album)

    names = {f.rsplit("/", 1)[-1] for f in _index_filenames(new_media_album)}

    assert "broken.mp4" not in names
    # ...and everything else still indexed.
    assert len(names) == EXPECTED_TOTAL


def test_skipped_files_are_reported_to_the_user(client, new_media_album):
    """bad_files used to be collected and surfaced nowhere."""
    build_index(client, new_media_album)

    progress = client.get(f"/index_progress/{new_media_album['key']}").json()

    assert progress["warning_message"]
    assert "could not be read" in progress["warning_message"]


def test_video_metadata_records_duration_fps_and_resolution(client, new_media_album):
    build_index(client, new_media_album)

    data = Embeddings.open_cached_embeddings(new_media_album["index"])
    by_name = {
        str(f).rsplit("/", 1)[-1]: m
        for f, m in zip(data["filenames"], data["metadata"], strict=True)
    }

    info = by_name["clip.mp4"][VIDEO_METADATA_KEY]
    assert info["duration"] == pytest.approx(2.0, abs=0.2)
    assert info["fps"] == pytest.approx(10.0)
    assert (info["width"], info["height"]) == (64, 64)
    assert info["codec"] == "h264"
    assert info["playable"] is True


def test_images_carry_no_video_metadata(client, new_media_album):
    build_index(client, new_media_album)

    data = Embeddings.open_cached_embeddings(new_media_album["index"])
    by_name = {
        str(f).rsplit("/", 1)[-1]: m
        for f, m in zip(data["filenames"], data["metadata"], strict=True)
    }

    assert VIDEO_METADATA_KEY not in by_name["building1.jpeg"]


# --------------------------------------------------------------------------
# The frame cache
# --------------------------------------------------------------------------


def test_still_frames_are_cached_at_index_time(client, new_media_album):
    """Extraction must happen here, never in a request handler."""
    build_index(client, new_media_album)

    cache = VideoFrameCache(new_media_album["key"])
    video = new_media_album["media_dir"] / "clip.mp4"
    assert cache.get(video) is not None


def test_cached_frames_are_not_reindexed_as_photos(client, new_media_album):
    """The single sharpest trap in the feature.

    Stills are full-resolution, so they sail through both gates. If the cache
    ever lands inside a scanned tree, every still becomes a photo — and each
    of those gets a still of its own, forever. Running the update twice and
    asserting a stable count is what catches that.
    """
    build_index(client, new_media_album)
    first = len(_index_filenames(new_media_album))

    response = client.post(
        "/update_index_async", json={"album_key": new_media_album["key"]}
    )
    assert response.status_code == 202
    poll_during_indexing(client, new_media_album["key"])
    _open_npz_file.cache_clear()

    assert len(_index_filenames(new_media_album)) == first


def test_deleting_a_video_removes_its_cached_frame(client, new_media_album):
    build_index(client, new_media_album)

    video = new_media_album["media_dir"] / "clip.mp4"
    cache = VideoFrameCache(new_media_album["key"])
    assert cache.get(video) is not None

    # API indices are into the sorted order, not the stored order.
    sorted_names = Embeddings.open_cached_embeddings(new_media_album["index"])[
        "sorted_filenames"
    ]
    api_index = list(sorted_names).index(video.resolve().as_posix())

    response = client.delete(
        f"/delete_image/{new_media_album['key']}/{api_index}?move_to_trash=false"
    )
    assert response.status_code == 200
    assert cache.get(video) is None


def test_index_update_prunes_orphaned_frames(client, new_media_album):
    """The one sweep that stands in for seven separate cleanups."""
    build_index(client, new_media_album)

    cache = VideoFrameCache(new_media_album["key"])
    orphan = cache.directory / ("0" * 32 + ".jpg")
    orphan.write_bytes(b"stale")
    assert orphan.exists()

    # Touch a file so the update has something to do and reaches a save.
    shutil.copy(
        media_fixture_path("clip.mp4"), new_media_album["media_dir"] / "extra.mp4"
    )
    response = client.post(
        "/update_index_async", json={"album_key": new_media_album["key"]}
    )
    assert response.status_code == 202
    poll_during_indexing(client, new_media_album["key"])

    assert not orphan.exists()
    # The real frames survived.
    assert cache.get(new_media_album["media_dir"] / "clip.mp4") is not None


# --------------------------------------------------------------------------
# The dimension gate
# --------------------------------------------------------------------------


def test_videos_bypass_the_dimension_gate(client, tmp_path):
    """A gate tuned to exclude thumbnails must not exclude clips.

    The gate opens files with PIL, which raises on a video — and the caller
    memoizes that rejection against (size, mtime), so a video rejected once
    would stay invisible until the file itself changed.
    """
    media = tmp_path / "gated"
    media.mkdir()
    shutil.copy(media_fixture_path("clip.mp4"), media / "clip.mp4")
    shutil.copy(
        media_fixture_path("../test_images/building1.jpeg").resolve(),
        media / "building1.jpeg",
    )

    embeddings = Embeddings(
        embeddings_path=media / "index" / "embeddings.npz",
        # Far above anything the fixtures could satisfy.
        min_image_dimension=100_000,
        min_image_bytes=0,
    )
    found = embeddings.get_image_files(media)
    names = {p.name for p in found}

    assert "clip.mp4" in names, "the video must survive an aggressive pixel gate"
    assert "building1.jpeg" not in names, "the gate must still reject small images"


def test_videos_never_enter_the_scan_reject_cache(client, tmp_path):
    media = tmp_path / "rejects"
    media.mkdir()
    shutil.copy(media_fixture_path("clip.mp4"), media / "clip.mp4")

    embeddings = Embeddings(
        embeddings_path=media / "index" / "embeddings.npz",
        min_image_dimension=100_000,
        min_image_bytes=0,
    )
    sink: dict = {}
    embeddings.get_image_files_from_directory(media, reject_sink=sink)

    assert sink == {}


def test_a_stale_scan_reject_cache_is_discarded_once(tmp_path):
    """Users who ran an intermediate build must not stay poisoned.

    A cache written while videos still went through the pixel gate can hold
    permanent rejections for good files, and (size, mtime) only changes if the
    file does.
    """
    from photomap.backend.util import atomic_savez

    index_dir = tmp_path / "index"
    index_dir.mkdir()
    embeddings = Embeddings(embeddings_path=index_dir / "embeddings.npz")

    atomic_savez(
        index_dir / "scan_rejects.npz",
        keys=np.array(["/some/clip.mp4"], dtype=str),
        sizes=np.array([123], dtype=np.int64),
        mtimes=np.array([1.0], dtype=np.float64),
        min_dim=np.int64(embeddings.min_image_dimension),
        min_bytes=np.int64(embeddings.min_image_bytes),
        # No cache_version: written by a build that predates the bump.
    )

    assert embeddings._load_scan_rejects() == {}


def test_a_current_scan_reject_cache_is_kept(tmp_path):
    index_dir = tmp_path / "index2"
    index_dir.mkdir()
    embeddings = Embeddings(embeddings_path=index_dir / "embeddings.npz")

    embeddings._save_scan_rejects({"/some/tiny.jpg": (10, 1.0)})

    assert embeddings._load_scan_rejects() == {"/some/tiny.jpg": (10, 1.0)}


# --------------------------------------------------------------------------
# Downstream behaviour
# --------------------------------------------------------------------------


def test_retrieve_image_serves_videos_as_videos(client, new_media_album):
    build_index(client, new_media_album)

    sorted_names = list(
        Embeddings.open_cached_embeddings(new_media_album["index"])["sorted_filenames"]
    )
    video_index = next(
        i for i, name in enumerate(sorted_names) if str(name).endswith("clip.mp4")
    )

    payload = client.get(
        f"/retrieve_image/{new_media_album['key']}/{video_index}"
    ).json()

    assert payload["media_type"] == "video"
    assert payload["image_url"].startswith("video_frame/")
    assert payload["video_url"].endswith("clip.mp4")
    assert payload["video_info"]["codec"] == "h264"


def test_thumbnails_render_for_indexed_videos(client, new_media_album):
    build_index(client, new_media_album)

    sorted_names = list(
        Embeddings.open_cached_embeddings(new_media_album["index"])["sorted_filenames"]
    )
    video_index = next(
        i for i, name in enumerate(sorted_names) if str(name).endswith("clip.mp4")
    )

    response = client.get(
        f"/thumbnails/{new_media_album['key']}/{video_index}?size=64"
    )
    assert response.status_code == 200


def test_umap_includes_videos(client, new_media_album):
    build_index(client, new_media_album)

    points = client.get(f"umap_data/{new_media_album['key']}").json()

    assert len(points) == EXPECTED_TOTAL


def test_index_metadata_counts_the_videos(client, new_media_album):
    build_index(client, new_media_album)

    payload = client.get(f"/index_metadata/{new_media_album['key']}").json()

    assert payload["filename_count"] == EXPECTED_TOTAL
    assert payload["video_count"] == EXPECTED_VIDEO_COUNT
    assert payload["image_count"] == TEST_IMAGE_COUNT


def test_image_search_matches_a_video_against_itself(client, new_media_album):
    """Deterministic: a video's own frame is its own top match.

    Asserts the embedding is real and reachable without claiming anything
    semantic about CLIP's view of a test pattern.
    """
    import base64

    build_index(client, new_media_album)

    frame_path = VideoFrameCache(new_media_album["key"]).get(
        new_media_album["media_dir"] / "clip.mp4"
    )
    payload = base64.b64encode(frame_path.read_bytes()).decode()

    response = client.post(
        f"/search_with_text_and_image/{new_media_album['key']}",
        json={
            "image_data": f"data:image/jpeg;base64,{payload}",
            "positive_query": "",
            "negative_query": "",
            "image_weight": 1.0,
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results, "the video's own frame should match something"

    top = results[0]
    sorted_names = list(
        Embeddings.open_cached_embeddings(new_media_album["index"])["sorted_filenames"]
    )
    assert str(sorted_names[top["index"]]).endswith("clip.mp4")
    assert top["score"] > 0.9


def test_a_legacy_image_only_index_still_reports_images(client, new_album):
    """Indexes predating video support need no migration."""
    build_index(client, new_album)

    payload = client.get(f"/retrieve_image/{new_album['key']}/0").json()

    assert payload["media_type"] == "image"
    assert payload["video_url"] == ""
