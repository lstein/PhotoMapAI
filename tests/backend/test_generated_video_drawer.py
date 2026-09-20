"""``/retrieve_image`` for an InvokeAI-generated video.

The unit tests either side of this one cover the ends — the indexer lifting
the record out of the MP4, and the formatter turning a record into drawer
HTML. This one covers the join, over the route the drawer actually calls,
because the failure mode it guards against is not a wrong panel but a 500:
``/retrieve_image`` builds a JSON response model out of the metadata dict,
and a video's dict is the only one in the codebase holding two unrelated
payloads at once.

The index is synthetic so the test costs no encoder run; only the metadata
matters here, and it is the metadata the real indexer would have written.
"""

from __future__ import annotations

import shutil

import pytest
from fastapi import HTTPException
from fixtures import (
    ENCODER_SPEC,
    _write_synthetic_index,
    client,  # noqa: F401
    media_fixture_path,
)

from photomap.backend.config import get_config_manager
from photomap.backend.metadata_extraction import MetadataExtractor
from photomap.backend.video import VIDEO_METADATA_KEY
from photomap.backend.video_cache import VideoFrameCache

VIDEO_INFO = {
    "duration": 1.0,
    "fps": 10.0,
    "width": 64,
    "height": 64,
    "codec": "h264",
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "playable": True,
}


@pytest.fixture
def no_invokeai_backend():
    """No configured backend, so no recall buttons muddy the assertions."""
    manager = get_config_manager()
    manager.set_invokeai_settings(url=None, username=None, password=None)
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


@pytest.fixture
def generated_video_album(client, tmp_path):  # noqa: F811
    """One album, one video: the committed InvokeAI-tagged fixture.

    The stored metadata is produced by the same extractor the indexer calls,
    rather than hand-written, so the test cannot drift from what actually
    lands in an index.
    """
    media_dir = tmp_path / "generated"
    media_dir.mkdir()
    video = media_dir / "invoke_video.mp4"
    shutil.copy(media_fixture_path("invoke_video.mp4"), video)

    metadata = MetadataExtractor.extract_video_metadata(video)
    metadata[VIDEO_METADATA_KEY] = dict(VIDEO_INFO)

    index_path = media_dir / "photomap_index" / "embeddings.npz"
    _write_synthetic_index(index_path, [video], [metadata])

    album = {
        "key": "generated_video_album",
        "name": "Generated Video Album",
        "image_paths": [media_dir.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    try:
        assert client.post("/add_album/", json=album).status_code == 201
        yield {**album, "video": video}
    finally:
        VideoFrameCache(album["key"]).clear()
        client.delete(f"/delete_album/{album['key']}")


def _slide(client, album):  # noqa: F811
    response = client.get(f"/retrieve_image/{album['key']}/0")
    assert response.status_code == 200
    return response.json()


def test_the_route_serves_both_panels(
    client, generated_video_album, no_invokeai_backend  # noqa: F811
):
    slide = _slide(client, generated_video_album)

    description = slide["description"]
    assert "🎬 Video" in description
    assert "a paper boat crossing a puddle" in description
    assert "<th>Mode</th><td>wan_i2v</td>" in description
    assert "<th>Frames</th><td>81</td>" in description


def test_the_slide_is_still_playable(
    client, generated_video_album, no_invokeai_backend  # noqa: F811
):
    """The generation record must not cost the drawer its player."""
    slide = _slide(client, generated_video_album)

    assert slide["media_type"] == "video"
    assert slide["video_info"]["codec"] == "h264"


def test_the_keyframe_is_offered_to_the_thumbnail_pass(
    client, generated_video_album, no_invokeai_backend  # noqa: F811
):
    slide = _slide(client, generated_video_album)

    assert slide["reference_images"] == ["0f0d1c3e-first.png"]


# --------------------------------------------------------------------------
# The recall API must refuse videos, not just the drawer
# --------------------------------------------------------------------------


@pytest.fixture
def invokeai_backend_configured(client):  # noqa: F811
    manager = get_config_manager()
    manager.set_invokeai_settings(url="http://localhost:9090")
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


def test_recall_refuses_a_video(
    client, generated_video_album, invokeai_backend_configured  # noqa: F811
):
    """The drawer withholds the buttons; the endpoint behind them is public.

    A video's record is a valid v5 record — it *is* one — so without an
    explicit guard the router happily forwards a video generation's prompt,
    model, seed, cfg and dimensions to InvokeAI's recall endpoint, which
    applies them to the image tab. Nothing downstream would have caught it:
    before videos carried a record at all, the request failed only because
    the metadata dict held nothing parseable.
    """
    response = client.post(
        "/invokeai/recall",
        json={
            "album_key": generated_video_album["key"],
            "index": 0,
            "queue_id": "default",
            "include_seed": True,
        },
    )

    assert response.status_code == 400
    assert "video" in response.json()["detail"].lower()


def test_use_ref_image_still_refuses_a_video(
    client, generated_video_album, invokeai_backend_configured  # noqa: F811
):
    """The guard this one already had must not have moved."""
    response = client.post(
        "/invokeai/use_ref_image",
        json={
            "album_key": generated_video_album["key"],
            "index": 0,
            "queue_id": "default",
        },
    )

    assert response.status_code == 400
    assert "video" in response.json()["detail"].lower()


def test_a_video_record_is_refused_even_when_the_path_looks_like_an_image():
    """Belt to the path check's braces: a renamed extension, or a container
    ``is_video`` does not classify, must not get a video recalled."""
    from photomap.backend.routers import invoke as invoke_module

    record = MetadataExtractor.extract_video_metadata(
        media_fixture_path("invoke_video.mp4")
    )

    with pytest.raises(HTTPException) as excinfo:
        invoke_module._build_recall_payload(record, include_seed=True)

    assert excinfo.value.status_code == 400
    assert "video" in excinfo.value.detail.lower()


def test_an_image_record_is_still_recallable():
    """The guard must not have swallowed the feature it protects."""
    from photomap.backend.routers import invoke as invoke_module

    payload = invoke_module._build_recall_payload(
        {
            "app_version": "7.0.0",
            "generation_mode": "txt2img",
            "positive_prompt": "a lighthouse",
            "seed": 5,
            "model": {"model_name": "SDXL", "base_model": "sdxl"},
        },
        include_seed=True,
    )

    assert payload["positive_prompt"] == "a lighthouse"
    assert payload["seed"] == 5
