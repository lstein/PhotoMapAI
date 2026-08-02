"""Tests for the raw HTTP behaviour of ``photomap.backend.invokeai_client``.

The board-index tests (``test_invokeai_board_index.py``) monkeypatch
``fetch_board_image_names`` wholesale, so the request-building details are
covered here instead — most importantly that board fetches ask InvokeAI to
exclude canvas intermediates and mask/control assets, mirroring what the
InvokeAI gallery itself displays.
"""

import pytest

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
