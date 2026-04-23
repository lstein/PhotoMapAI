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


@pytest.fixture
def clear_token_cache():
    """Wipe the module-level JWT cache before and after each test."""
    from photomap.backend.routers import invoke as invoke_module

    invoke_module._invalidate_token_cache()
    yield
    invoke_module._invalidate_token_cache()


def test_get_config_empty(client, clear_invokeai_config):
    response = client.get("/invokeai/config")
    assert response.status_code == 200
    body = response.json()
    assert body == {"url": "", "username": "", "has_password": False, "board_id": ""}


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

        async def post(self, url, json, **kwargs):
            captured["url"] = url
            captured["json"] = json
            captured["params"] = kwargs.get("params")
            captured["headers"] = kwargs.get("headers")
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

        async def post(self, url, json, **kwargs):
            captured["json"] = json
            return _StubResponse()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": False},
    )
    assert response.status_code == 200
    assert "seed" not in captured["json"]


def test_use_ref_image_requires_configured_url(client, clear_invokeai_config):
    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "whatever", "index": 0},
    )
    assert response.status_code == 400
    assert "not configured" in response.json()["detail"].lower()


def test_use_ref_image_uploads_then_calls_recall_without_strict(
    client, clear_invokeai_config, monkeypatch, tmp_path
):
    """Happy path — verify upload + recall ordering, payload, and no strict=true."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    # Create a real file on disk so _load_image_path + is_file() pass.
    image_file = tmp_path / "pic.png"
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfakebytes")

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    # Non-UUID filename + empty metadata means the existence probe is
    # skipped — exercising the upload happy path.
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: {}
    )

    calls: list[dict] = []

    class _UploadResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"image_name": "uploaded-abc.png"}

    class _RecallResponse:
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

        async def post(self, url, **kwargs):
            call = {"url": url, "params": kwargs.get("params")}
            if "files" in kwargs:
                call["kind"] = "upload"
                # Drain the file stream so httpx-style behavior is preserved.
                kwargs["files"]["file"][1].read()
                calls.append(call)
                return _UploadResponse()
            call["kind"] = "recall"
            call["json"] = kwargs.get("json")
            calls.append(call)
            return _RecallResponse()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["success"] is True
    assert body["uploaded_image_name"] == "uploaded-abc.png"
    assert body["sent"] == {
        "reference_images": [{"image_name": "uploaded-abc.png"}]
    }

    # Two upstream calls, in the right order, to the right URLs.
    assert len(calls) == 2
    assert calls[0]["kind"] == "upload"
    assert calls[0]["url"] == "http://localhost:9090/api/v1/images/upload"
    assert calls[0]["params"] == {
        "image_category": "user",
        "is_intermediate": "false",
    }
    assert calls[1]["kind"] == "recall"
    assert calls[1]["url"] == "http://localhost:9090/api/v1/recall/default"
    # CRITICAL: no `strict=true` — sending it would reset every other
    # parameter the user already has set up in InvokeAI.
    assert calls[1]["params"] is None or "strict" not in (calls[1]["params"] or {})
    assert calls[1]["json"] == {
        "reference_images": [{"image_name": "uploaded-abc.png"}]
    }


def test_use_ref_image_upload_failure_returns_502(
    client, clear_invokeai_config, monkeypatch, tmp_path
):
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / "pic.png"
    image_file.write_bytes(b"\x89PNG")

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: {}
    )

    class _FailedUpload:
        status_code = 500
        text = "disk full"

        def json(self):
            return {"detail": "disk full"}

    class _StubClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            if "files" in kwargs:
                kwargs["files"]["file"][1].read()
                return _FailedUpload()
            raise AssertionError("Recall should not be attempted when upload fails")

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 502
    assert "upload" in response.json()["detail"].lower()


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

        async def post(self, url, json, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 502
    assert "Could not reach InvokeAI backend" in response.json()["detail"]


# ── Auth fallback behavior ─────────────────────────────────────────────


def _install_recall_stub(monkeypatch):
    """Install a trivial metadata stub so recall requests don't need real embeddings."""
    from photomap.backend.routers import invoke as invoke_module

    raw_metadata = {
        "metadata_version": 3,
        "app_version": "3.5.0",
        "positive_prompt": "x",
        "model": {"model_name": "m", "base_model": "sd-1"},
    }
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: raw_metadata
    )


class _ScriptedClient:
    """An httpx.AsyncClient stub whose ``get``/``post`` return scripted responses.

    Each call records the (url, headers, method) it saw so tests can assert on
    the auth header progression across a retry cycle.
    """

    def __init__(self, script):
        self._script = list(script)
        self.calls: list[dict] = []

    def __call__(self, *args, **kwargs):
        # Invoked as ``httpx.AsyncClient(...)`` — return self so the ``async
        # with`` context manager works.
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, **kwargs):
        return await self._dispatch("POST", url, kwargs)

    async def get(self, url, **kwargs):
        return await self._dispatch("GET", url, kwargs)

    async def _dispatch(self, method, url, kwargs):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(kwargs.get("headers") or {}),
                "params": kwargs.get("params"),
                "json": kwargs.get("json"),
            }
        )
        entry = self._script.pop(0)
        if callable(entry):
            entry = entry(url, kwargs)
        return entry


class _Resp:
    def __init__(self, status_code=200, json_body=None, text="{}"):
        self.status_code = status_code
        self._json = json_body if json_body is not None else {}
        self.text = text
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._json


def test_recall_first_tries_without_auth_then_logs_in_on_401(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    """Initial call is anonymous; a 401 response triggers login + retry with Bearer."""
    client.post(
        "/invokeai/config",
        json={
            "url": "http://localhost:9090",
            "username": "alice",
            "password": "secret",
        },
    )
    _install_recall_stub(monkeypatch)

    from photomap.backend.routers import invoke as invoke_module

    # Script the backend: first /recall returns 401, login returns a token,
    # second /recall returns success. Dispatch by URL so we don't depend on
    # call ordering between the recall client and the login client.
    login_resp = _Resp(
        200, json_body={"token": "abc-token", "expires_in": 3600}
    )
    recall_responses = [
        _Resp(401, json_body={"detail": "Not authenticated"}, text="unauth"),
        _Resp(200, json_body={"status": "success"}),
    ]

    def _route(url, kwargs):
        if url.endswith("/auth/login"):
            return login_resp
        return recall_responses.pop(0)

    script = [_route, _route, _route]  # may be invoked up to 3 times
    stub = _ScriptedClient(script)
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 200, response.text

    # First recall attempt must have been anonymous.
    recall_calls = [c for c in stub.calls if c["url"].endswith("/recall/default")]
    assert len(recall_calls) == 2
    assert "Authorization" not in recall_calls[0]["headers"]
    # Second recall attempt must carry the Bearer token from the login response.
    assert recall_calls[1]["headers"].get("Authorization") == "Bearer abc-token"

    # A login call must have been made between the two recall attempts.
    login_calls = [c for c in stub.calls if c["url"].endswith("/auth/login")]
    assert len(login_calls) == 1
    assert login_calls[0]["json"] == {"email": "alice", "password": "secret"}


def test_recall_sends_cached_token_on_subsequent_requests(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    """Once a token is cached, later calls should send it from the first attempt."""
    client.post(
        "/invokeai/config",
        json={
            "url": "http://localhost:9090",
            "username": "alice",
            "password": "secret",
        },
    )

    # Pre-seed the token cache as though a previous login had succeeded.
    import time as _time

    from photomap.backend.routers import invoke as invoke_module

    invoke_module._cached_token = "cached-token"
    invoke_module._token_expires_at = _time.monotonic() + 3600
    invoke_module._token_base_url = "http://localhost:9090"
    invoke_module._token_username = "alice"

    _install_recall_stub(monkeypatch)

    def _route(url, kwargs):
        return _Resp(200, json_body={"status": "success"})

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 200

    # First and only attempt carried the cached token — no login call needed.
    assert len(stub.calls) == 1
    assert stub.calls[0]["headers"].get("Authorization") == "Bearer cached-token"


def test_recall_403_with_cached_token_retries_anonymously_and_forgets_token(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    """If the backend has switched to single-user mode the cached token must be
    discarded and the request retried without auth."""
    client.post(
        "/invokeai/config",
        json={
            "url": "http://localhost:9090",
            "username": "alice",
            "password": "secret",
        },
    )

    import time as _time

    from photomap.backend.routers import invoke as invoke_module

    # Pre-seed a cached token.
    invoke_module._cached_token = "stale-token"
    invoke_module._token_expires_at = _time.monotonic() + 3600
    invoke_module._token_base_url = "http://localhost:9090"
    invoke_module._token_username = "alice"

    _install_recall_stub(monkeypatch)

    responses = [
        _Resp(
            403,
            json_body={
                "detail": "Multiuser mode is disabled. Authentication is not required."
            },
            text="forbidden",
        ),
        _Resp(200, json_body={"status": "success"}),
    ]

    def _route(url, kwargs):
        assert url.endswith("/recall/default"), url  # no login expected
        return responses.pop(0)

    stub = _ScriptedClient([_route, _route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 200, response.text

    # First attempt carried the stale token, second attempt was anonymous.
    assert len(stub.calls) == 2
    assert stub.calls[0]["headers"].get("Authorization") == "Bearer stale-token"
    assert "Authorization" not in stub.calls[1]["headers"]

    # Cache must have been cleared.
    assert invoke_module._cached_token is None


def test_recall_anonymous_403_is_not_retried(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    """A 403 on a call that was already anonymous just surfaces as-is — there
    is nothing to retry without."""
    # No credentials configured, so the first request is anonymous.
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    _install_recall_stub(monkeypatch)

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        return _Resp(403, json_body={"detail": "forbidden"}, text="forbidden")

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    response = client.post(
        "/invokeai/recall",
        json={"album_key": "any", "index": 0, "include_seed": True},
    )
    assert response.status_code == 502
    assert len(stub.calls) == 1  # no retry, no login


def test_use_ref_image_403_with_token_retries_anonymously(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """The upload + recall flow must handle the same auth transition as /recall."""
    client.post(
        "/invokeai/config",
        json={
            "url": "http://localhost:9090",
            "username": "alice",
            "password": "secret",
        },
    )

    import time as _time

    from photomap.backend.routers import invoke as invoke_module

    invoke_module._cached_token = "stale-token"
    invoke_module._token_expires_at = _time.monotonic() + 3600
    invoke_module._token_base_url = "http://localhost:9090"
    invoke_module._token_username = "alice"

    image_file = tmp_path / "pic.png"
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: {}
    )

    calls: list[dict] = []

    class _ClientStub:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, **kwargs):
            entry = {
                "url": url,
                "headers": dict(kwargs.get("headers") or {}),
                "kind": "upload" if "files" in kwargs else "recall",
                "json": kwargs.get("json"),
            }
            if "files" in kwargs:
                kwargs["files"]["file"][1].read()
            calls.append(entry)

            if entry["kind"] == "upload":
                # Upload returns 403 on the first attempt (with token), then
                # succeeds anonymously.
                if entry["headers"].get("Authorization"):
                    return _Resp(
                        403,
                        json_body={"detail": "Multiuser mode is disabled."},
                        text="forbidden",
                    )
                return _Resp(200, json_body={"image_name": "uploaded.png"})

            # Recall also: 403 with token → anon success.
            if entry["headers"].get("Authorization"):
                return _Resp(
                    403,
                    json_body={"detail": "Multiuser mode is disabled."},
                    text="forbidden",
                )
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _ClientStub)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text

    upload_calls = [c for c in calls if c["kind"] == "upload"]
    recall_calls = [c for c in calls if c["kind"] == "recall"]

    # Upload retried anonymously.
    assert len(upload_calls) == 2
    assert upload_calls[0]["headers"].get("Authorization") == "Bearer stale-token"
    assert "Authorization" not in upload_calls[1]["headers"]

    # Recall also retried anonymously — and since the token was invalidated
    # by the upload's 403, the very first recall attempt is already
    # anonymous.  Either way the final recall succeeds without a token.
    assert len(recall_calls) >= 1
    assert "Authorization" not in recall_calls[-1]["headers"]

    # Cache cleared.
    assert invoke_module._cached_token is None


# ── board_id round-trip + /invokeai/status + /invokeai/boards ──────────


def test_config_round_trips_board_id(client, clear_invokeai_config):
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": "board-uuid-1"},
    )
    body = client.get("/invokeai/config").json()
    assert body["board_id"] == "board-uuid-1"


def test_config_board_id_preserved_when_omitted(client, clear_invokeai_config):
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": "keep-me"},
    )
    # Update another field without including board_id — it should survive.
    client.post("/invokeai/config", json={"url": "http://localhost:9091"})
    body = client.get("/invokeai/config").json()
    assert body["board_id"] == "keep-me"


def test_config_board_id_cleared_by_empty_string(client, clear_invokeai_config):
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": "delete-me"},
    )
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": ""},
    )
    body = client.get("/invokeai/config").json()
    assert body["board_id"] == ""


def test_status_returns_unreachable_when_url_not_configured(
    client, clear_invokeai_config
):
    response = client.get("/invokeai/status")
    assert response.status_code == 200
    body = response.json()
    assert body["reachable"] is False
    assert "no invokeai url configured" in body["detail"].lower()


def test_status_returns_version_on_reachable_backend(
    client, clear_invokeai_config, monkeypatch
):
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        assert url == "http://localhost:9090/api/v1/app/version"
        return _Resp(200, json_body={"version": "5.6.0"})

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    body = client.get("/invokeai/status").json()
    assert body["reachable"] is True
    assert body["version"] == "5.6.0"


def test_status_marks_network_failure_as_unreachable(
    client, clear_invokeai_config, monkeypatch
):
    client.post("/invokeai/config", json={"url": "http://localhost:9999"})

    from photomap.backend.routers import invoke as invoke_module

    class _ExplodingClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _ExplodingClient)

    body = client.get("/invokeai/status").json()
    assert body["reachable"] is False
    assert "could not reach" in body["detail"].lower()


def test_status_rejects_non_invokeai_server(
    client, clear_invokeai_config, monkeypatch
):
    """A random HTTP 200 without a ``version`` field should count as
    unreachable so the settings UI doesn't reveal the auth rows."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        return _Resp(200, json_body={"hello": "world"})

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    body = client.get("/invokeai/status").json()
    assert body["reachable"] is False


def test_boards_returns_flat_list_on_success(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        assert url == "http://localhost:9090/api/v1/boards/"
        assert kwargs.get("params") == {"all": "true"}
        return _Resp(
            200,
            json_body=[
                {"board_id": "abc", "board_name": "Landscapes"},
                {"board_id": "def", "board_name": "Portraits"},
                # Entries missing board_id are filtered out — they're not
                # addressable in the upload endpoint.
                {"board_name": "Missing id"},
            ],
        )

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    body = client.get("/invokeai/boards").json()
    assert body == [
        {"board_id": "abc", "board_name": "Landscapes"},
        {"board_id": "def", "board_name": "Portraits"},
    ]


def test_boards_unwraps_paginated_response(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    """If the InvokeAI build ignores ?all=true we still want to use the items list."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        return _Resp(
            200,
            json_body={
                "items": [{"board_id": "abc", "board_name": "Landscapes"}],
                "offset": 0,
                "total": 1,
            },
        )

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    body = client.get("/invokeai/boards").json()
    assert body == [{"board_id": "abc", "board_name": "Landscapes"}]


def test_boards_returns_502_on_upstream_failure(
    client, clear_invokeai_config, clear_token_cache, monkeypatch
):
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    from photomap.backend.routers import invoke as invoke_module

    def _route(url, kwargs):
        return _Resp(500, json_body={"detail": "server exploded"}, text="boom")

    stub = _ScriptedClient([_route])
    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", stub)

    response = client.get("/invokeai/boards")
    assert response.status_code == 502


def test_use_ref_image_passes_configured_board_id(
    client, clear_invokeai_config, monkeypatch, tmp_path
):
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": "my-board"},
    )

    image_file = tmp_path / "pic.png"
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: {}
    )

    captured_upload_params: list[dict] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, **kwargs):
            if "files" in kwargs:
                captured_upload_params.append(kwargs.get("params"))
                kwargs["files"]["file"][1].read()

                class _Up:
                    status_code = 200
                    text = ""

                    def json(self_inner):
                        return {"image_name": "uploaded.png"}

                return _Up()

            class _Rec:
                status_code = 200
                text = "{}"

                def json(self_inner):
                    return {"status": "success"}

            return _Rec()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "warning" not in body

    assert len(captured_upload_params) == 1
    params = captured_upload_params[0]
    assert params == {
        "image_category": "user",
        "is_intermediate": "false",
        "board_id": "my-board",
    }


def test_use_ref_image_falls_back_to_uncategorized_when_board_upload_fails(
    client, clear_invokeai_config, monkeypatch, tmp_path
):
    """When the configured board rejects the upload, retry without it so the
    image lands in Uncategorized — and surface a warning so the UI can say so."""
    client.post(
        "/invokeai/config",
        json={"url": "http://localhost:9090", "board_id": "ghost-board"},
    )

    image_file = tmp_path / "pic.png"
    image_file.write_bytes(b"\x89PNG")

    from photomap.backend.routers import invoke as invoke_module

    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    monkeypatch.setattr(
        invoke_module, "_load_raw_metadata", lambda album_key, index: {}
    )

    upload_params_seen: list[dict] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, **kwargs):
            if "files" in kwargs:
                params = kwargs.get("params") or {}
                upload_params_seen.append(params)
                kwargs["files"]["file"][1].read()

                if params.get("board_id"):
                    # First attempt — board-scoped upload fails.
                    class _BadBoard:
                        status_code = 404
                        text = '{"detail":"Board not found"}'

                        def json(self_inner):
                            return {"detail": "Board not found"}

                    return _BadBoard()

                # Retry without board_id succeeds.
                class _OK:
                    status_code = 200
                    text = ""

                    def json(self_inner):
                        return {"image_name": "uploaded.png"}

                return _OK()

            class _Rec:
                status_code = 200
                text = "{}"

                def json(self_inner):
                    return {"status": "success"}

            return _Rec()

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["uploaded_image_name"] == "uploaded.png"
    assert "warning" in body
    assert "uncategorized" in body["warning"].lower()

    # Two upload attempts: one with the board, one without.
    assert len(upload_params_seen) == 2
    assert upload_params_seen[0].get("board_id") == "ghost-board"
    assert "board_id" not in upload_params_seen[1]


# ── Skip-upload when InvokeAI already has the image ────────────────────

# A realistic InvokeAI-style UUID filename. The existence probe only fires
# for files that look like they might have come from InvokeAI in the first
# place — either because the filename still matches that shape, or because
# the file carries Invoke generation metadata.
_INVOKE_UUID_NAME = "a1b2c3d4-e5f6-7890-abcd-ef0123456789.png"


def _install_use_ref_stubs(
    invoke_module, monkeypatch, image_file, raw_metadata=None
):
    """Shared scaffold for use_ref_image tests that don't need a real album."""
    monkeypatch.setattr(
        invoke_module, "_load_image_path", lambda album_key, index: image_file
    )
    monkeypatch.setattr(
        invoke_module,
        "_load_raw_metadata",
        lambda album_key, index: raw_metadata or {},
    )


def test_use_ref_image_reuses_existing_when_uuid_filename_hits(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """UUID-style filename + backend confirms it exists → skip upload, call recall."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / _INVOKE_UUID_NAME
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    from photomap.backend.routers import invoke as invoke_module

    _install_use_ref_stubs(invoke_module, monkeypatch, image_file)

    calls: list[dict] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            calls.append({"method": "GET", "url": url})
            return _Resp(200, json_body={"image_name": _INVOKE_UUID_NAME})

        async def post(self, url, **kwargs):
            calls.append(
                {
                    "method": "POST",
                    "url": url,
                    "kind": "upload" if "files" in kwargs else "recall",
                    "json": kwargs.get("json"),
                }
            )
            if "files" in kwargs:
                raise AssertionError(
                    "Upload must not happen when the image is already on the backend"
                )
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reused_existing"] is True
    assert body["uploaded_image_name"] == _INVOKE_UUID_NAME
    assert body["sent"] == {
        "reference_images": [{"image_name": _INVOKE_UUID_NAME}]
    }

    # Exactly one probe GET (existence check) + one POST (recall). No upload.
    get_calls = [c for c in calls if c["method"] == "GET"]
    post_calls = [c for c in calls if c["method"] == "POST"]
    assert len(get_calls) == 1
    assert get_calls[0]["url"] == (
        f"http://localhost:9090/api/v1/images/i/{_INVOKE_UUID_NAME}"
    )
    assert len(post_calls) == 1
    assert post_calls[0]["kind"] == "recall"


def test_use_ref_image_uploads_when_probe_returns_404(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """UUID filename but backend doesn't recognize it → fall through to upload."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / _INVOKE_UUID_NAME
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    from photomap.backend.routers import invoke as invoke_module

    _install_use_ref_stubs(invoke_module, monkeypatch, image_file)

    calls: list[dict] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            calls.append({"method": "GET", "url": url})
            return _Resp(404, json_body={"detail": "Not found"}, text="not found")

        async def post(self, url, **kwargs):
            kind = "upload" if "files" in kwargs else "recall"
            calls.append({"method": "POST", "url": url, "kind": kind})
            if kind == "upload":
                kwargs["files"]["file"][1].read()
                return _Resp(200, json_body={"image_name": "uploaded-xyz.png"})
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reused_existing"] is False
    assert body["uploaded_image_name"] == "uploaded-xyz.png"

    assert [c["method"] for c in calls] == ["GET", "POST", "POST"]
    kinds = [c.get("kind") for c in calls if c["method"] == "POST"]
    assert kinds == ["upload", "recall"]


def test_use_ref_image_probes_when_metadata_looks_invoke(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """Even a non-UUID filename triggers the probe when the image has
    InvokeAI generation metadata — the user may have renamed the file."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / "my_portrait.png"
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    from photomap.backend.routers import invoke as invoke_module

    _install_use_ref_stubs(
        invoke_module,
        monkeypatch,
        image_file,
        raw_metadata={"app_version": "5.6.0", "positive_prompt": "anything"},
    )

    probe_urls: list[str] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            probe_urls.append(url)
            # Backend doesn't recognize the renamed file — falls through.
            return _Resp(404, json_body={"detail": "Not found"}, text="not found")

        async def post(self, url, **kwargs):
            if "files" in kwargs:
                kwargs["files"]["file"][1].read()
                return _Resp(200, json_body={"image_name": "uploaded.png"})
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    assert response.json()["reused_existing"] is False

    # Metadata signal alone is enough to make us probe.
    assert len(probe_urls) == 1
    assert probe_urls[0].endswith("/api/v1/images/i/my_portrait.png")


def test_use_ref_image_skips_probe_for_non_invoke_image(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """A normal filename with no Invoke metadata should go straight to upload
    without ever calling GET /images/i/… — no point asking the backend about
    a file it couldn't possibly know."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / "vacation.jpg"
    image_file.write_bytes(b"\xff\xd8\xff\xe0fake")

    from photomap.backend.routers import invoke as invoke_module

    _install_use_ref_stubs(invoke_module, monkeypatch, image_file)

    calls: list[dict] = []

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            calls.append({"method": "GET", "url": url})
            raise AssertionError("Existence probe should not run for non-invoke image")

        async def post(self, url, **kwargs):
            kind = "upload" if "files" in kwargs else "recall"
            calls.append({"method": "POST", "url": url, "kind": kind})
            if kind == "upload":
                kwargs["files"]["file"][1].read()
                return _Resp(200, json_body={"image_name": "uploaded.jpg"})
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reused_existing"] is False
    assert [c["method"] for c in calls] == ["POST", "POST"]


def test_use_ref_image_probe_error_falls_through_to_upload(
    client, clear_invokeai_config, clear_token_cache, monkeypatch, tmp_path
):
    """If the existence check blows up for any reason, we must still upload —
    the probe is an optimization, not a gate."""
    client.post("/invokeai/config", json={"url": "http://localhost:9090"})

    image_file = tmp_path / _INVOKE_UUID_NAME
    image_file.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    from photomap.backend.routers import invoke as invoke_module

    _install_use_ref_stubs(invoke_module, monkeypatch, image_file)

    class _StubClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **kwargs):
            raise httpx.ConnectError("flaky network")

        async def post(self, url, **kwargs):
            if "files" in kwargs:
                kwargs["files"]["file"][1].read()
                return _Resp(200, json_body={"image_name": "uploaded.png"})
            return _Resp(200, json_body={"status": "success"})

    monkeypatch.setattr(invoke_module.httpx, "AsyncClient", _StubClient)

    response = client.post(
        "/invokeai/use_ref_image",
        json={"album_key": "any", "index": 0},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reused_existing"] is False
    assert body["uploaded_image_name"] == "uploaded.png"
