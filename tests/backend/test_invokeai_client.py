"""Tests for the raw HTTP behaviour of ``photomap.backend.invokeai_client``.

The board-index tests (``test_invokeai_board_index.py``) monkeypatch
``fetch_board_image_names`` / ``fetch_board_video_names`` wholesale, so the
request-building details are covered here instead — most importantly that
board fetches ask InvokeAI to exclude canvas intermediates and mask/control
assets, mirroring what the InvokeAI gallery itself displays.
"""

import pytest
from fastapi import HTTPException

from photomap.backend import invokeai_client


class _Resp:
    def __init__(self, status_code=200, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body if json_body is not None else []
        self.text = text

    def json(self):
        return self._json


class _RecordingClient:
    """httpx.AsyncClient stub that records each GET and returns scripted responses."""

    def __init__(self, script):
        self._script = list(script)
        self.calls: list[dict] = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, **kwargs):
        self.calls.append({"url": url, "params": kwargs.get("params")})
        return self._script.pop(0)

    async def delete(self, url, **kwargs):
        self.calls.append({"url": url, "method": "DELETE"})
        return self._script.pop(0)


@pytest.fixture(autouse=True)
def _clear_token_cache():
    invokeai_client._invalidate_token_cache()
    yield
    invokeai_client._invalidate_token_cache()


@pytest.mark.asyncio
async def test_fetch_board_image_names_filters_out_intermediates(monkeypatch):
    """Board fetches must request only non-intermediate general/user images."""
    stub = _RecordingClient(
        [
            _Resp(json_body=["aaa.png", "bbb.png"]),
            _Resp(json_body=["bbb.png", "ccc.png"]),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    names = await invokeai_client.fetch_board_image_names(
        "http://localhost:9090", ["board-1", "none"], None, None
    )

    assert names == ["aaa.png", "bbb.png", "ccc.png"]
    assert [call["url"] for call in stub.calls] == [
        "http://localhost:9090/api/v1/boards/board-1/image_names",
        "http://localhost:9090/api/v1/boards/none/image_names",
    ]
    for call in stub.calls:
        assert call["params"] == {
            "is_intermediate": "false",
            "categories": ["general", "user"],
        }


@pytest.mark.asyncio
async def test_fetch_board_video_names_queries_each_board_with_filters(monkeypatch):
    """Videos are listed by a query parameter, not a path segment, and get the
    same intermediate/category filtering as images (a Wan pipeline writes its
    intermediate clips to the board too)."""
    stub = _RecordingClient(
        [
            _Resp(json_body={"video_names": ["a.mp4", "b.mp4"], "total_count": 2}),
            _Resp(json_body={"video_names": ["b.mp4", "c.mp4"], "total_count": 2}),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_names(
        "http://localhost:9090", ["board-1", "none"], None, None
    )

    assert result.names == ["a.mp4", "b.mp4", "c.mp4"]
    assert result.api_available is True
    assert [call["url"] for call in stub.calls] == [
        "http://localhost:9090/api/v1/videos/names",
        "http://localhost:9090/api/v1/videos/names",
    ]
    assert [call["params"]["board_id"] for call in stub.calls] == ["board-1", "none"]
    for call in stub.calls:
        assert call["params"]["is_intermediate"] == "false"
        assert call["params"]["categories"] == ["general", "user"]


@pytest.mark.asyncio
async def test_fetch_board_video_names_tolerates_backend_without_videos(monkeypatch):
    """An InvokeAI predating the video API 404s the whole router; that must
    not fail the index run, and it must be distinguishable from a board that
    genuinely holds no videos — the caller prunes rows for anything absent
    from the listing."""
    stub = _RecordingClient([_Resp(status_code=404, text="Not Found")])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_names(
        "http://localhost:9090", ["board-1"], None, None
    )

    assert result.names == []
    assert result.api_available is False


@pytest.mark.asyncio
async def test_fetch_board_video_names_keeps_names_from_earlier_boards(monkeypatch):
    """A 404 on a later board must not discard what earlier boards returned.
    InvokeAI answers 404 for a board a non-admin cannot read, not only for a
    missing video router, so the successful listings are still good data."""
    stub = _RecordingClient(
        [
            _Resp(json_body={"video_names": ["a.mp4"], "total_count": 1}),
            _Resp(status_code=404, text="Board not found"),
        ]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    result = await invokeai_client.fetch_board_video_names(
        "http://localhost:9090", ["board-1", "board-gone"], None, None
    )

    assert result.names == ["a.mp4"]
    assert result.api_available is False


@pytest.mark.asyncio
async def test_fetch_board_video_names_rejects_unexpected_shape(monkeypatch):
    """A bare list (the *images* endpoint's shape) is not silently accepted —
    reading no names off a successful response would quietly drop every video
    from the album."""
    stub = _RecordingClient([_Resp(json_body=["a.mp4"])])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.fetch_board_video_names(
            "http://localhost:9090", ["board-1"], None, None
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_delete_video_uses_the_video_endpoint(monkeypatch):
    stub = _RecordingClient(
        [_Resp(json_body={"deleted_videos": ["a.mp4"], "failed_videos": []})]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video(
        "http://localhost:9090", "a.mp4", None, None
    )

    assert stub.calls == [
        {"url": "http://localhost:9090/api/v1/videos/i/a.mp4", "method": "DELETE"}
    ]


@pytest.mark.asyncio
async def test_delete_video_raises_when_reported_as_failed(monkeypatch):
    """InvokeAI can report a failure *inside* a 200 response. Treating that as
    success would drop the local index row while the video stayed on the
    board, so it has to surface as an error."""
    stub = _RecordingClient(
        [_Resp(json_body={"deleted_videos": [], "failed_videos": ["a.mp4"]})]
    )
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    with pytest.raises(HTTPException) as excinfo:
        await invokeai_client.delete_video(
            "http://localhost:9090", "a.mp4", None, None
        )
    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_delete_video_tolerates_already_gone(monkeypatch):
    """A 404 means InvokeAI has forgotten the video; the caller still needs to
    drop its index row, so this returns rather than raising."""
    stub = _RecordingClient([_Resp(status_code=404, text="Video not found")])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video(
        "http://localhost:9090", "a.mp4", None, None
    )


@pytest.mark.asyncio
async def test_delete_video_accepts_a_200_that_is_not_an_object(monkeypatch):
    """The success check reads ``failed_videos`` off the body, so a 200
    carrying anything but a JSON object must not blow up: InvokeAI has
    already deleted the video at that point, and an exception here would keep
    the index row pointing at a file that is gone."""
    stub = _RecordingClient([_Resp(json_body=["a.mp4"])])
    monkeypatch.setattr(invokeai_client.httpx, "AsyncClient", stub)

    await invokeai_client.delete_video("http://localhost:9090", "a.mp4", None, None)
