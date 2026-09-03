"""
Fixtures for pytest
"""

import shutil
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from photomap.backend.embeddings import _open_npz_file
from photomap.backend.util import atomic_savez
from photomap.backend.video import VIDEO_METADATA_KEY, ffmpeg_exe
from photomap.backend.video_cache import VideoFrameCache


@pytest.fixture
def client() -> TestClient:
    """Fixture to create a test client for the PhotoMap application."""
    from photomap.backend.photomap_server import app

    return TestClient(app)

@pytest.fixture
def new_album(client, tmp_path) -> dict:
    """Create a temp album from images in a temporary directory; return the album info"""
    # Path to your source test images
    src_images = Path(__file__).parent / "test_images"
    # Path to the temp directory for this test
    temp_img_dir = tmp_path / "images"
    temp_img_dir.mkdir(parents=True, exist_ok=True)

    # Copy all test images to the temp directory
    for img in src_images.iterdir():
        if img.is_file():
            shutil.copy(img, temp_img_dir / img.name)

    album_data = {
        "key": "test_album",
        "name": "Test Album",
        "image_paths": [temp_img_dir.as_posix()],
        "index": (temp_img_dir / "embeddings.npz").as_posix(),
        "umap_eps": 0.1,
        "description": "A test album",
        # Pin the test fixture to legacy CLIP so search-threshold and
        # cosine-distribution assertions stay stable even when the codebase's
        # DEFAULT_ENCODER_SPEC for new albums changes.
        "encoder_spec": "openai-clip:ViT-B/32",
    }
    response = client.post("/add_album/", json=album_data)
    assert response.status_code == 201

    # Return the album data (or fetch from API if you want the server's version)
    yield album_data
    # teardown
    client.delete(f"/delete_album/{album_data['key']}")


@pytest.fixture
def new_media_album(client, tmp_path) -> dict:
    """A temp album holding both the test images and the test videos.

    Kept separate from ``new_album`` so existing suites see zero churn: they
    keep their exact image counts, and only video tests pay the ffmpeg cost.
    """
    src_images = Path(__file__).parent / "test_images"
    temp_dir = tmp_path / "media"
    temp_dir.mkdir(parents=True, exist_ok=True)

    for f in src_images.iterdir():
        if f.is_file():
            shutil.copy(f, temp_dir / f.name)
    for f in TEST_MEDIA_DIR.iterdir():
        if f.is_file():
            shutil.copy(f, temp_dir / f.name)

    album_data = {
        "key": "test_media_album",
        "name": "Test Media Album",
        "image_paths": [temp_dir.as_posix()],
        # The index deliberately lives inside the media directory, mirroring
        # ``new_album`` — that is the layout that would let a frame cache
        # placed next to the index get re-indexed as photos.
        "index": (temp_dir / "embeddings.npz").as_posix(),
        "umap_eps": 0.1,
        "description": "A test album with videos",
        "encoder_spec": "openai-clip:ViT-B/32",
    }
    response = client.post("/add_album/", json=album_data)
    assert response.status_code == 201

    yield {**album_data, "media_dir": temp_dir}

    client.delete(f"/delete_album/{album_data['key']}")


def poll_during_indexing(client, album_key, timeout=60):
    """Poll the index progress until it completes or times out."""
    start_time = time.time()
    while True:
        response = client.get(f"/index_progress/{album_key}")
        assert response.status_code == 200
        progress = response.json()
        if progress["status"] == "completed":
            break
        if progress["status"] == "error":
            raise Exception(
                f"Indexing failed: {progress.get('error_message', 'Unknown error')}"
            )
        if time.time() - start_time > timeout:
            raise TimeoutError("Indexing did not complete within the timeout period.")
        time.sleep(1)  # Wait before polling again


def build_index(client, new_album):
    """Helper function to build the index for the album.

    Bundled test images are all 384x512 / 512x384, well above the default
    256px ``min_image_dimension`` gate, so no per-test threshold tweaking
    is needed.
    """
    response = client.post("/update_index_async", json={"album_key": new_album["key"]})
    assert response.status_code == 202
    task_id = response.json().get("task_id")
    assert task_id is not None
    try:
        poll_during_indexing(client, new_album["key"])
    except TimeoutError as e:
        pytest.fail(f"Indexing did not complete: {str(e)}")


def fetch_filename(client, album_key, index) -> str:
    """Helper function to fetch the filename from the album."""
    response = client.get(f"/retrieve_image/{album_key}/{index}")
    assert response.status_code == 200
    return response.json().get("filename", "")


def count_test_images():
    """Count the number of test images in the fixtures directory."""
    src_images = Path(__file__).parent / "test_images"
    return len([img for img in src_images.iterdir() if img.is_file()])


# Video fixtures live in their own directory, deliberately NOT in
# ``test_images``. ``new_album`` copies every file out of ``test_images``, and
# a video there would break the exact-count assertions in test_umap /
# test_invokeai_board_index, fail test_index's "bad_files == []" ordering
# test, and make every existing index test depend on ffmpeg.
TEST_MEDIA_DIR = Path(__file__).parent / "test_media"


def media_fixture_path(name: str) -> Path:
    """Absolute path to a committed video fixture.

    Not named ``test_*``: pytest would try to collect it as a test case.
    """
    return TEST_MEDIA_DIR / name


def count_test_media():
    """Count the number of test videos in the fixtures directory."""
    return len([f for f in TEST_MEDIA_DIR.iterdir() if f.is_file()])


# --------------------------------------------------------------------------
# Mixed image/video album
#
# Shared rather than owned by test_video_serving because several suites need
# the same album: serving bytes, serving stills, and converting an unplayable
# file all want one album holding one photo and one video. Importing a fixture
# from another *test* module works but makes ruff read every use of it as a
# redefinition (F811); fixtures.py is where conftest already picks fixtures up
# from, so nothing has to import it at all.
# --------------------------------------------------------------------------

ENCODER_SPEC = "openai-clip:ViT-B/32"
EMBEDDING_DIM = 8

requires_ffmpeg = pytest.mark.skipif(
    ffmpeg_exe() is None, reason="no bundled ffmpeg binary on this platform"
)


def _write_synthetic_index(index_path, files, metadatas):
    """Write an .npz with the given files, bypassing the real encoder."""
    rng = np.random.default_rng(0)
    embeddings = rng.random((len(files), EMBEDDING_DIM)).astype(np.float32)
    embeddings /= np.linalg.norm(embeddings, axis=1, keepdims=True)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_savez(
        index_path,
        embeddings=embeddings,
        filenames=np.array([f.resolve().as_posix() for f in files]),
        modification_times=np.array(
            [float(i + 1) for i in range(len(files))], dtype=float
        ),
        metadata=np.array(metadatas, dtype=object),
        model_id=np.array(ENCODER_SPEC),
        embedding_dim=np.array(EMBEDDING_DIM),
    )
    _open_npz_file.cache_clear()


VIDEO_INFO = {
    "duration": 2.0,
    "fps": 10.0,
    "width": 64,
    "height": 64,
    "codec": "h264",
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "playable": True,
}


@pytest.fixture
def mixed_album(client, tmp_path):
    """An album holding one photo and one video, with a synthetic index.

    Files are ordered so the video sorts to index 0 and the photo to index 1
    (modification_times drive the lexsort).
    """
    media_dir = tmp_path / "mixed"
    media_dir.mkdir()

    video = media_dir / "clip.mp4"
    shutil.copy(media_fixture_path("clip.mp4"), video)
    photo = media_dir / "building1.jpeg"
    shutil.copy(
        media_fixture_path("../test_images/building1.jpeg").resolve(), photo
    )

    index_path = media_dir / "photomap_index" / "embeddings.npz"
    _write_synthetic_index(
        index_path,
        [video, photo],
        [{VIDEO_METADATA_KEY: dict(VIDEO_INFO)}, {"Make": "TestCam"}],
    )

    album = {
        "key": "mixed_album",
        "name": "Mixed Album",
        "image_paths": [media_dir.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    try:
        # Inside the try: a failure here would otherwise leak the album past
        # teardown and poison every later test using this fixture.
        assert client.post("/add_album/", json=album).status_code == 201
        yield {**album, "video": video, "photo": photo, "media_dir": media_dir}
    finally:
        VideoFrameCache(album["key"]).clear()
        client.delete(f"/delete_album/{album['key']}")
