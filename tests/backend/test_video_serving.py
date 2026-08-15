"""Serving video bytes and video stills.

The directory walk does not collect videos yet, so these tests build a
synthetic index directly rather than going through ``build_index``.  That is
also faster and fully deterministic: none of what is under test here depends
on real CLIP embeddings.
"""

from __future__ import annotations

import shutil
from io import BytesIO

import numpy as np
import pytest
from fixtures import media_fixture_path
from PIL import Image

from photomap.backend.embeddings import _open_npz_file
from photomap.backend.util import atomic_savez
from photomap.backend.video import VIDEO_METADATA_KEY, ffmpeg_exe
from photomap.backend.video_cache import VideoFrameCache

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
    assert client.post("/add_album/", json=album).status_code == 201
    try:
        yield {**album, "video": video, "photo": photo, "media_dir": media_dir}
    finally:
        VideoFrameCache(album["key"]).clear()
        client.delete(f"/delete_album/{album['key']}")


# --------------------------------------------------------------------------
# /videos/ — byte serving and range support
# --------------------------------------------------------------------------


def test_serve_video_returns_the_whole_file(client, mixed_album):
    expected = mixed_album["video"].read_bytes()
    response = client.get("/videos/mixed_album/clip.mp4")
    assert response.status_code == 200
    assert response.content == expected
    assert response.headers["content-type"] == "video/mp4"


def test_serve_video_advertises_range_support(client, mixed_album):
    """The <video> scrubber needs this to offer seeking at all."""
    response = client.get("/videos/mixed_album/clip.mp4")
    assert response.headers.get("accept-ranges") == "bytes"


def test_serve_video_honors_a_byte_range(client, mixed_album):
    """Regression guard on seeking.

    Nothing in PhotoMapAI implements Range itself — this works because the
    route returns a FileResponse and Starlette handles it. Rewriting the route
    as a StreamingResponse (as the HEIC path does) would silently kill
    seeking with no other symptom, so it is asserted explicitly.
    """
    size = mixed_album["video"].stat().st_size
    expected = mixed_album["video"].read_bytes()[:100]

    response = client.get(
        "/videos/mixed_album/clip.mp4", headers={"Range": "bytes=0-99"}
    )

    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 0-99/{size}"
    assert len(response.content) == 100
    assert response.content == expected


def test_serve_video_honors_an_open_ended_range(client, mixed_album):
    data = mixed_album["video"].read_bytes()
    size = len(data)
    response = client.get(
        "/videos/mixed_album/clip.mp4", headers={"Range": "bytes=100-"}
    )
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes 100-{size - 1}/{size}"
    assert response.content == data[100:]


def test_serve_video_rejects_an_unsatisfiable_range(client, mixed_album):
    size = mixed_album["video"].stat().st_size
    response = client.get(
        "/videos/mixed_album/clip.mp4",
        headers={"Range": f"bytes={size + 500}-{size + 999}"},
    )
    assert response.status_code == 416


# --------------------------------------------------------------------------
# /videos/ — the security allowlist
# --------------------------------------------------------------------------


def test_serve_video_rejects_an_image(client, mixed_album):
    response = client.get("/videos/mixed_album/building1.jpeg")
    assert response.status_code == 403


def test_serve_video_rejects_an_arbitrary_file(client, mixed_album):
    """Mirror of test_image_type_guard for the video route.

    ``add_album`` accepts arbitrary absolute ``image_paths``, so this route
    needs its own extension guard for exactly the same reason ``/images/``
    does.
    """
    (mixed_album["media_dir"] / "passwd").write_text("root:x:0:0:")
    response = client.get("/videos/mixed_album/passwd")
    assert response.status_code == 403


def test_serve_video_404s_for_a_missing_file(client, mixed_album):
    response = client.get("/videos/mixed_album/absent.mp4")
    assert response.status_code == 404


def test_images_route_still_rejects_videos(client, mixed_album):
    """The split is asserted in both directions.

    ``/images/`` must not have gained video suffixes as a side effect of
    adding video support.
    """
    response = client.get("/images/mixed_album/clip.mp4")
    assert response.status_code == 403
    assert "unsupported" in response.json()["detail"].lower()


# --------------------------------------------------------------------------
# /video_frame/ and /thumbnails/
# --------------------------------------------------------------------------


@requires_ffmpeg
def test_video_frame_endpoint_serves_a_jpeg(client, mixed_album):
    response = client.get("/video_frame/mixed_album/0")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert Image.open(BytesIO(response.content)).size == (64, 64)


@requires_ffmpeg
def test_video_frame_endpoint_regenerates_after_a_cache_wipe(client, mixed_album):
    """A pruned or hand-deleted cache must self-heal, not break the UI."""
    assert client.get("/video_frame/mixed_album/0").status_code == 200
    VideoFrameCache("mixed_album").clear()
    assert client.get("/video_frame/mixed_album/0").status_code == 200


def test_video_frame_endpoint_404s_for_an_image_index(client, mixed_album):
    response = client.get("/video_frame/mixed_album/1")
    assert response.status_code == 404
    assert "not a video" in response.json()["detail"].lower()


def test_video_frame_endpoint_404s_for_an_out_of_range_index(client, mixed_album):
    assert client.get("/video_frame/mixed_album/99").status_code == 404


@requires_ffmpeg
def test_thumbnail_endpoint_renders_a_video_via_its_still(client, mixed_album):
    """Grid tiles, UMAP hover and landmark thumbnails all go through here."""
    response = client.get("/thumbnails/mixed_album/0?size=32")
    assert response.status_code == 200
    thumb = Image.open(BytesIO(response.content))
    assert max(thumb.size) <= 32


@requires_ffmpeg
def test_thumbnail_endpoint_still_works_for_images(client, mixed_album):
    response = client.get("/thumbnails/mixed_album/1?size=32")
    assert response.status_code == 200


# --------------------------------------------------------------------------
# The slide payload
# --------------------------------------------------------------------------


def test_retrieve_image_marks_a_video_and_points_at_its_frame(client, mixed_album):
    payload = client.get("/retrieve_image/mixed_album/0").json()

    assert payload["media_type"] == "video"
    # image_url must stay displayable so consumers that only want a picture
    # keep working; the playable bytes get their own field.
    assert payload["image_url"] == "video_frame/mixed_album/0"
    assert payload["video_url"] == "videos/mixed_album/clip.mp4"
    assert payload["video_info"]["duration"] == 2.0
    assert payload["video_info"]["fps"] == 10.0


def test_retrieve_image_leaves_images_untouched(client, mixed_album):
    """Existing payloads must be byte-identical to the pre-video shape."""
    payload = client.get("/retrieve_image/mixed_album/1").json()

    assert payload["media_type"] == "image"
    assert payload["image_url"] == "images/mixed_album/building1.jpeg"
    assert payload["video_url"] == ""
    assert payload["video_info"] is None


def test_video_description_lists_the_video_facts(client, mixed_album):
    description = client.get("/retrieve_image/mixed_album/0").json()["description"]
    assert "Duration" in description and "0:02" in description
    assert "Frame Rate" in description and "10 fps" in description
    assert "Resolution" in description and "64 × 64" in description
    assert "h264" in description


def test_video_description_offers_an_external_link(client, mixed_album):
    description = client.get("/retrieve_image/mixed_album/0").json()["description"]
    assert "videos/mixed_album/clip.mp4" in description


def test_get_metadata_serializes_video_info(client, mixed_album):
    """The endpoint json.dumps the raw metadata dict.

    Anything stashed there by the probe has to be plain Python scalars —
    numpy scalars raise here.
    """
    response = client.get("/get_metadata/mixed_album/0")
    assert response.status_code == 200
    assert response.json()[VIDEO_METADATA_KEY]["codec"] == "h264"
