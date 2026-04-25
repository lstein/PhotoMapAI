"""Tests for the upgrade router's auth/origin gating.

The update and restart endpoints have no authentication; both the
``PHOTOMAP_INLINE_UPGRADE`` deployment switch and the
``X-Requested-With`` header requirement must be enforced server-side.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def inline_upgrades_enabled(monkeypatch):
    monkeypatch.setenv("PHOTOMAP_INLINE_UPGRADE", "1")


@pytest.fixture
def inline_upgrades_disabled(monkeypatch):
    monkeypatch.setenv("PHOTOMAP_INLINE_UPGRADE", "0")


@pytest.fixture
def no_pip(monkeypatch):
    """Stub out ``subprocess.run`` so tests never actually invoke pip."""
    from photomap.backend.routers import upgrade as upgrade_module

    class _FakeCompleted:
        returncode = 0
        stdout = "stub"
        stderr = ""

    def _fake_run(*args, **kwargs):
        return _FakeCompleted()

    monkeypatch.setattr(upgrade_module.subprocess, "run", _fake_run)


@pytest.fixture
def no_restart(monkeypatch):
    """Stub out the ``os.kill`` path so tests never actually restart."""
    from photomap.backend.routers import upgrade as upgrade_module

    class _FakeThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(upgrade_module.threading, "Thread", _FakeThread)


def test_update_rejects_missing_xrw_header(client, inline_upgrades_enabled, no_pip):
    response = client.post("/version/update")
    assert response.status_code == 403
    assert "x-requested-with" in response.json()["detail"].lower()


def test_update_accepts_xrw_header(client, inline_upgrades_enabled, no_pip):
    response = client.post(
        "/version/update", headers={"X-Requested-With": "photomap"}
    )
    assert response.status_code == 200


def test_update_blocked_when_inline_disabled(
    client, inline_upgrades_disabled, no_pip
):
    response = client.post(
        "/version/update", headers={"X-Requested-With": "photomap"}
    )
    assert response.status_code == 403
    assert "disabled" in response.json()["detail"].lower()


def test_restart_rejects_missing_xrw_header(
    client, inline_upgrades_enabled, no_restart
):
    response = client.post("/version/restart")
    assert response.status_code == 403


def test_restart_accepts_xrw_header(client, inline_upgrades_enabled, no_restart):
    response = client.post(
        "/version/restart", headers={"X-Requested-With": "photomap"}
    )
    assert response.status_code == 200


def test_restart_blocked_when_inline_disabled(
    client, inline_upgrades_disabled, no_restart
):
    response = client.post(
        "/version/restart", headers={"X-Requested-With": "photomap"}
    )
    assert response.status_code == 403


def test_check_version_is_still_unauthenticated(client, inline_upgrades_enabled):
    """The read-only check endpoint stays open — only state-changing ones are gated."""
    # May return 200 or 503 depending on network; either is fine, just not 403.
    response = client.get("/version/check")
    assert response.status_code != 403
