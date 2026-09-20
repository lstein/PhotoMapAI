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
