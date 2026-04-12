"""Tests for the InvokeAI recall proxy router.

Covers:

* GET/POST ``/invokeai/config`` round-tripping via the config manager.
* ``POST /invokeai/recall`` returning a clean error when the backend URL is
  not configured.
* ``POST /invokeai/recall`` happy path where we stub ``httpx.AsyncClient`` and
  verify the payload shape that would reach the upstream InvokeAI backend.
"""

from __future__ import annotations

import httpx
import pytest

from photomap.backend.config import get_config_manager


@pytest.fixture
def clear_invokeai_config():
    """Ensure each test starts and ends without stale InvokeAI config."""
    manager = get_config_manager()
    manager.set_invokeai_settings(url=None, username=None, password=None)
    yield
    manager.set_invokeai_settings(url=None, username=None, password=None)


def test_get_config_empty(client, clear_invokeai_config):
    response = client.get("/invokeai/config")
    assert response.status_code == 200
    body = response.json()
    assert body == {"url": "", "username": "", "has_password": False}


def test_set_and_get_config(client, clear_invokeai_config):
    response = client.post(
        "/invokeai/config",
        json={
            "url": "http://localhost:9090",
            "username": "alice",
            "password": "secret",
        },
    )
    assert response.status_code == 200
    assert response.json() == {"success": True}

    response = client.get("/invokeai/config")
    body = response.json()
    assert body["url"] == "http://localhost:9090"
    assert body["username"] == "alice"
    # Password is never echoed back — only a boolean flag.
    assert body["has_password"] is True
    assert "password" not in body


def test_set_config_preserves_password_on_null(client, clear_invokeai_config):
    # First store a password.
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "password": "original"},
    )
    # Now update other fields without sending a password field at all.
    client.post("/invokeai/config", json={"url": "http://other:9090"})

    manager = get_config_manager()
    manager.reload_config()
    settings = manager.get_invokeai_settings()
    assert settings["url"] == "http://other:9090"
    assert settings["password"] == "original"


def test_recall_requires_configured_url(client, clear_invokeai_config):
    response = client.post(
        "/invokeai/recall",
        json={"album_key": "whatever", "index": 0, "include_seed": True},
    )
    assert response.status_code == 400
    assert "not configured" in response.json()["detail"].lower()


def test_recall_proxies_payload_to_invokeai_backend(
    client, clear_invokeai_config, monkeypatch
):
    """Stub out the upstream call and verify the exact payload we forward."""
    # Configure the backend URL.
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    # Stub out embeddings lookup so the router receives a canned metadata dict.
    raw_metadata = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "a landscape",
        "negative_prompt": "blurry",
        "model": {"model_name": "dreamshaper", "base_model": "sd-1"},
        "seed": 321,
        "steps": 25,
        "cfg_scale": 7.5,
        "width": 512,
        "height": 512,
    }

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: raw_metadata
    )

    captured = {}

    class _StubResponse:
        status_code = 200
        text = "{}"

        def json(self):
            return {"status": "success", "updated_count": 7}

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json):
            captured["url"] = url
            captured["json"] = json
            return _StubResponse()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["sent"]["positive_prompt"] == "a landscape"
    assert body["sent"]["seed"] == 321
    assert body["sent"]["steps"] == 25
    assert body["response"]["status"] == "success"

    # The request was routed to the configured backend + the documented path.
    assert captured["url"] == "http://localhost:9090/api/v1/recall/default"
    assert captured["json"]["seed"] == 321
    assert captured["json"]["model"] == "dreamshaper"


def test_recall_remix_omits_seed(client, clear_invokeai_config, monkeypatch):
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    raw_metadata = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "x",
        "model": {"model_name": "m", "base_model": "sd-1"},
        "seed": 12345,
    }

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: raw_metadata
    )

    captured = {}

    class _StubResponse:
        status_code = 200
        text = "{}"

        def json(self):
            return {"status": "success"}

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json):
            captured["json"] = json
            return _StubResponse()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": False},
    )
    assert response.status_code == 200
    assert "seed" not in captured["json"]


def test_recall_upstream_unreachable_returns_502(
    client, clear_invokeai_config, monkeypatch
):
    client.post("/invokeai/config", json={"url": "http://localhost:9999"})

    raw_metadata = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "x",
        "model": {"model_name": "m", "base_model": "sd-1"},
    }

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: raw_metadata
    )

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 502
    assert "Could not reach InvokeAI backend" in response.json()["detail"]
