"""Guards for the paths that assume an album entry is a still image.

Each of these is somewhere a video would otherwise misbehave once indexing
picks them up: duplicate detection would report unrelated clips as identical,
the InvokeAI actions would upload an .mp4 as a reference image, a video blob
posted to search would 500, and the in-memory ZIP would happily try to hold
several gigabytes.
"""

from __future__ import annotations

import base64
import shutil
import zipfile
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from fixtures import media_fixture_path
from PIL import Image

from photomap.backend.embeddings import Embeddings, _open_npz_file
from photomap.backend.progress import ProgressTracker
from photomap.backend.util import atomic_savez

ENCODER_SPEC = "openai-clip:ViT-B/32"
EMBEDDING_DIM = 8


def _write_index(index_path: Path, files: list[Path], embeddings: np.ndarray) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_savez(
        index_path,
        embeddings=embeddings.astype(np.float32),
        filenames=np.array([f.resolve().as_posix() for f in files]),
        modification_times=np.array(
            [float(i + 1) for i in range(len(files))], dtype=float
        ),
        metadata=np.array([{} for _ in files], dtype=object),
        model_id=np.array(ENCODER_SPEC),
        embedding_dim=np.array(EMBEDDING_DIM),
    )
    _open_npz_file.cache_clear()


# --------------------------------------------------------------------------
# Duplicate detection
# --------------------------------------------------------------------------


def test_duplicate_detection_ignores_videos(tmp_path, capsys):
    """Two clips whose opening frames match must not be called duplicates.

    Opening frames are so often a black slate or a title card that unrelated
    videos land at ~1.0 cosine — and users act on a duplicate report by
    deleting.
    """
    media = tmp_path / "media"
    media.mkdir()
    files = [media / "a.mp4", media / "b.mp4", media / "x.jpg", media / "y.jpg"]
    for f in files:
        f.write_bytes(b"stub")

    # Both pairs are internally identical.
    identical = np.array([[1.0, 0.0] + [0.0] * 6])
    embeddings = np.vstack([identical, identical, identical, identical])

    index_path = media / "index" / "embeddings.npz"
    _write_index(index_path, files, embeddings)

    Embeddings(embeddings_path=index_path, encoder_spec=ENCODER_SPEC).find_duplicate_clusters()

    printed = capsys.readouterr().out
    assert "x.jpg" in printed and "y.jpg" in printed
    assert "a.mp4" not in printed and "b.mp4" not in printed


def test_duplicate_detection_on_an_all_video_index_is_a_noop(tmp_path, capsys):
    media = tmp_path / "media"
    media.mkdir()
    files = [media / "a.mp4", media / "b.mp4"]
    for f in files:
        f.write_bytes(b"stub")
    embeddings = np.vstack([np.array([[1.0] + [0.0] * 7])] * 2)

    index_path = media / "index" / "embeddings.npz"
    _write_index(index_path, files, embeddings)

    Embeddings(embeddings_path=index_path, encoder_spec=ENCODER_SPEC).find_duplicate_clusters()

    assert capsys.readouterr().out.strip() == ""


# --------------------------------------------------------------------------
# Search by image
# --------------------------------------------------------------------------


def test_search_rejects_a_non_image_query_blob(client, new_album):
    """A video dropped on the search panel gets a 400, not an opaque 500."""
    payload = base64.b64encode(media_fixture_path("clip.mp4").read_bytes()).decode()

    response = client.post(
        f"/search_with_text_and_image/{new_album['key']}",
        json={
            "image_data": f"data:video/mp4;base64,{payload}",
            "positive_query": "",
            "negative_query": "",
        },
    )

    assert response.status_code == 400
    assert "still image" in response.json()["detail"].lower()


def test_search_still_accepts_an_image_query(client, new_album):
    """The guard must not cost us search-by-image.

    This has to build the index and assert a 200: without one the endpoint
    500s on the missing .npz, and an ``!= 400`` assertion passes on that 500 —
    so the test would hold even if the guard rejected every valid image.
    """
    from fixtures import build_index

    build_index(client, new_album)

    buffer = BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(buffer, format="JPEG")
    payload = base64.b64encode(buffer.getvalue()).decode()

    response = client.post(
        f"/search_with_text_and_image/{new_album['key']}",
        json={
            "image_data": f"data:image/jpeg;base64,{payload}",
            "positive_query": "",
            "negative_query": "",
        },
    )

    assert response.status_code == 200, response.text
    assert len(response.json()) > 0


# --------------------------------------------------------------------------
# InvokeAI actions
# --------------------------------------------------------------------------


@pytest.fixture
def video_album(client, tmp_path):
    media = tmp_path / "invoke_media"
    media.mkdir()
    video = media / "clip.mp4"
    shutil.copy(media_fixture_path("clip.mp4"), video)

    index_path = media / "index" / "embeddings.npz"
    _write_index(index_path, [video], np.array([[1.0] + [0.0] * 7]))

    album = {
        "key": "invoke_video_album",
        "name": "Invoke Video Album",
        "image_paths": [media.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    assert client.post("/add_album/", json=album).status_code == 201
    try:
        yield album
    finally:
        client.delete(f"/delete_album/{album['key']}")


@pytest.fixture
def invokeai_configured():
    """Point the config at an InvokeAI URL that is never actually reached.

    The endpoints refuse early without a configured URL, which would mask the
    guard under test.
    """
    from photomap.backend.config import get_config_manager

    manager = get_config_manager()
    manager.set_invokeai_settings(url="http://localhost:9090")
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


def test_use_ref_image_refuses_videos(client, video_album, invokeai_configured):
    """``_load_image_path`` is the choke point for the InvokeAI upload path.

    This endpoint POSTs the file to InvokeAI's /images/upload, which takes
    images — an .mp4 would surface as an opaque 502 carrying raw upstream
    text. The guard has to fire before any network call is attempted, which
    is what makes this test safe to run with an unreachable URL configured.
    """
    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": video_album["key"], "index": 0},
    )
    assert response.status_code == 400
    assert "video" in response.json()["detail"].lower()


def test_recall_also_refuses_videos(client, video_album, invokeai_configured):
    """Recall reaches videos through the metadata path rather than the file.

    It therefore already refused them — a video carries no InvokeAI
    generation parameters — but the behaviour is worth pinning so a future
    refactor that routes recall through the file path stays correct.
    """
    response = client.post(
        "/invokeai/recall",
        json={"album_key": video_album["key"], "index": 0},
    )
    assert response.status_code == 400


# --------------------------------------------------------------------------
# ZIP download
# --------------------------------------------------------------------------


def test_zip_download_refuses_an_oversized_selection(
    client, new_album, monkeypatch
):
    """The archive is built in memory, so the ceiling has to be enforced."""
    from photomap.backend.routers import search as search_router_module

    monkeypatch.setattr(search_router_module, "_MAX_ZIP_BYTES", 10)

    from fixtures import build_index

    build_index(client, new_album)

    response = client.post(
        f"/download_images_zip/{new_album['key']}", json={"indices": [0, 1]}
    )

    assert response.status_code == 413
    assert "limit" in response.json()["detail"].lower()


def test_zip_stores_videos_and_deflates_images(client, tmp_path):
    """Video streams are already compressed; deflating them burns CPU for ~0.

    Asserted on the archive that comes back rather than on the call, because
    the compress_type is a per-member argument that is easy to drop without
    any other visible effect.
    """
    media = tmp_path / "zipmix"
    media.mkdir()
    video = media / "clip.mp4"
    shutil.copy(media_fixture_path("clip.mp4"), video)
    photo = media / "shot.png"
    Image.new("RGB", (64, 64), (200, 40, 40)).save(photo)

    files = sorted([video, photo])
    index_path = media / "index" / "embeddings.npz"
    _write_index(
        index_path, files, np.vstack([np.array([[1.0] + [0.0] * 7])] * len(files))
    )

    album = {
        "key": "zipmix_album",
        "name": "Zip Mix",
        "image_paths": [media.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    assert client.post("/add_album/", json=album).status_code == 201
    try:
        response = client.post(
            "/download_images_zip/zipmix_album", json={"indices": [0, 1]}
        )
        assert response.status_code == 200, response.text

        with zipfile.ZipFile(BytesIO(response.content)) as archive:
            by_name = {info.filename: info for info in archive.infolist()}
            assert by_name["clip.mp4"].compress_type == zipfile.ZIP_STORED
            assert by_name["shot.png"].compress_type == zipfile.ZIP_DEFLATED
    finally:
        client.delete("/delete_album/zipmix_album")


def test_zip_size_check_ignores_files_it_would_not_include(client, new_album, monkeypatch):
    """The ceiling must be measured over what actually gets written.

    An index can name a path outside the album (a moved directory, an edited
    config); those are skipped when building the archive, so counting their
    bytes could refuse a selection that zips to almost nothing.
    """
    from fixtures import build_index

    from photomap.backend.routers import search as search_router_module

    build_index(client, new_album)

    monkeypatch.setattr(
        search_router_module, "validate_image_access", lambda *args, **kwargs: False
    )
    monkeypatch.setattr(search_router_module, "_MAX_ZIP_BYTES", 1)

    response = client.post(
        f"/download_images_zip/{new_album['key']}", json={"indices": [0, 1]}
    )

    # Nothing is includable, so nothing counts: an empty archive, not a 413.
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        assert archive.namelist() == []


def test_zip_download_still_works_under_the_limit(client, new_album):
    from fixtures import build_index

    build_index(client, new_album)

    response = client.post(
        f"/download_images_zip/{new_album['key']}", json={"indices": [0]}
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"


# --------------------------------------------------------------------------
# Index metadata
# --------------------------------------------------------------------------


def test_index_metadata_splits_images_and_videos(client, tmp_path):
    media = tmp_path / "counted"
    media.mkdir()
    files = [media / "a.mp4", media / "b.jpg", media / "c.jpg"]
    for f in files:
        f.write_bytes(b"stub")
    _write_index(
        media / "index" / "embeddings.npz",
        files,
        np.vstack([np.array([[1.0] + [0.0] * 7])] * 3),
    )

    album = {
        "key": "counted_album",
        "name": "Counted",
        "image_paths": [media.as_posix()],
        "index": (media / "index" / "embeddings.npz").as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    assert client.post("/add_album/", json=album).status_code == 201
    try:
        payload = client.get("/index_metadata/counted_album").json()
        assert payload["filename_count"] == 3
        assert payload["image_count"] == 2
        assert payload["video_count"] == 1
    finally:
        client.delete("/delete_album/counted_album")


def test_index_metadata_reports_legacy_indexes_as_all_images(client, new_album):
    from fixtures import build_index

    build_index(client, new_album)
    payload = client.get(f"/index_metadata/{new_album['key']}").json()
    assert payload["video_count"] == 0
    assert payload["image_count"] == payload["filename_count"]


# --------------------------------------------------------------------------
# Completion warnings
# --------------------------------------------------------------------------


def test_completion_warnings_compose():
    """A run can now produce more than one non-fatal notice.

    A board album may have images missing on disk *and* videos that could not
    be decoded; the single slot used to let the second writer discard the
    first silently.
    """
    tracker = ProgressTracker()
    tracker.set_completion_warning("album", "3 images missing on disk.")
    tracker.add_completion_warning("album", "2 videos could not be read.")

    tracker.start_operation("album", total_images=1, operation_type="indexing")
    tracker.complete_operation("album")

    warning = tracker.get_progress("album").warning_message
    assert "3 images missing on disk." in warning
    assert "2 videos could not be read." in warning


def test_adding_the_same_warning_twice_does_not_duplicate_it():
    tracker = ProgressTracker()
    tracker.add_completion_warning("album", "2 videos could not be read.")
    tracker.add_completion_warning("album", "2 videos could not be read.")

    tracker.start_operation("album", total_images=1, operation_type="indexing")
    tracker.complete_operation("album")

    assert tracker.get_progress("album").warning_message.count("2 videos") == 1


def test_adding_a_warning_that_is_a_substring_of_another_keeps_both():
    """Deduplication compares whole notices, not substrings of the joined text.

    "2 videos could not be read." is a substring of "12 videos could not be
    read.", so a containment check against the accumulated string dropped it —
    the exact silent discard this method exists to prevent.
    """
    tracker = ProgressTracker()
    tracker.add_completion_warning("album", "12 videos could not be read.")
    tracker.add_completion_warning("album", "2 videos could not be read.")

    tracker.start_operation("album", total_images=1, operation_type="indexing")
    tracker.complete_operation("album")

    warning = tracker.get_progress("album").warning_message
    assert "12 videos could not be read." in warning
    assert warning.count("videos could not be read.") == 2


def test_adding_an_empty_warning_is_a_noop():
    tracker = ProgressTracker()
    tracker.add_completion_warning("album", "kept")
    tracker.add_completion_warning("album", None)

    tracker.start_operation("album", total_images=1, operation_type="indexing")
    tracker.complete_operation("album")

    assert tracker.get_progress("album").warning_message == "kept"


def test_set_completion_warning_still_replaces():
    tracker = ProgressTracker()
    tracker.set_completion_warning("album", "first")
    tracker.set_completion_warning("album", "second")

    tracker.start_operation("album", total_images=1, operation_type="indexing")
    tracker.complete_operation("album")

    assert tracker.get_progress("album").warning_message == "second"
