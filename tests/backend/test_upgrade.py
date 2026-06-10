"""Inline self-upgrade endpoint (``POST /version/update``).

The desktop launcher installs PhotoMapAI with ``uv tool install``, which
produces a deliberately pip-less environment. The endpoint historically ran
``python -m pip install --upgrade`` unconditionally, so for every launcher
install it failed with "No module named pip". These tests lock in that the
command is chosen by install type: pip when pip is importable, ``uv tool
upgrade`` otherwise, and a clear error when neither is usable.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from photomap.backend.routers import upgrade

# The endpoint requires this non-standard header (CSRF hardening); supply it on
# every request that should reach the handler body.
_HEADERS = {"X-Requested-With": "photomap"}


def _ok_run(captured: list[list[str]]):
    """Return a fake ``subprocess.run`` that records argv and reports success."""

    def fake_run(command, *args, **kwargs):
        captured.append(command)
        return SimpleNamespace(returncode=0, stdout="done", stderr="")

    return fake_run


# --- command selection (unit) ---------------------------------------------


def test_build_command_prefers_pip_when_available(monkeypatch):
    monkeypatch.setattr(upgrade, "_pip_available", lambda: True)
    # _find_uv must not be consulted when pip is available.
    monkeypatch.setattr(
        upgrade, "_find_uv", lambda: pytest.fail("uv should not be probed")
    )

    command = upgrade._build_upgrade_command()

    assert command[:3] == [upgrade.sys.executable, "-m", "pip"]
    assert command[-1] == "photomapai"


def test_build_command_uses_uv_when_pip_absent(monkeypatch):
    monkeypatch.setattr(upgrade, "_pip_available", lambda: False)
    monkeypatch.setattr(upgrade, "_find_uv", lambda: "/opt/bin/uv")

    command = upgrade._build_upgrade_command()

    assert command == ["/opt/bin/uv", "tool", "upgrade", "photomapai"]


def test_build_command_raises_when_no_pip_and_no_uv(monkeypatch):
    monkeypatch.setattr(upgrade, "_pip_available", lambda: False)
    monkeypatch.setattr(upgrade, "_find_uv", lambda: None)

    with pytest.raises(upgrade.UpgradeUnavailableError):
        upgrade._build_upgrade_command()


# --- endpoint plumbing -----------------------------------------------------
# (The X-Requested-With / inline-disabled gating is covered by
# test_upgrade_router.py; these focus on which upgrade command runs.)


def test_update_runs_pip_for_pip_install(client, monkeypatch):
    captured: list[list[str]] = []
    monkeypatch.setattr(upgrade, "_pip_available", lambda: True)
    monkeypatch.setattr(upgrade.subprocess, "run", _ok_run(captured))

    response = client.post("/version/update", headers=_HEADERS)

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert captured[0][:3] == [upgrade.sys.executable, "-m", "pip"]


def test_update_runs_uv_for_launcher_install(client, monkeypatch):
    captured: list[list[str]] = []
    monkeypatch.setattr(upgrade, "_pip_available", lambda: False)
    monkeypatch.setattr(upgrade, "_find_uv", lambda: "/opt/bin/uv")
    monkeypatch.setattr(upgrade.subprocess, "run", _ok_run(captured))

    response = client.post("/version/update", headers=_HEADERS)

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert captured[0] == ["/opt/bin/uv", "tool", "upgrade", "photomapai"]


def test_update_reports_clear_error_when_unupgradeable(client, monkeypatch):
    """No pip, no uv: fail with guidance instead of a cryptic pip error."""
    monkeypatch.setattr(upgrade, "_pip_available", lambda: False)
    monkeypatch.setattr(upgrade, "_find_uv", lambda: None)

    def explode(*args, **kwargs):
        raise AssertionError("subprocess must not run when no upgrader exists")

    monkeypatch.setattr(upgrade.subprocess, "run", explode)

    response = client.post("/version/update", headers=_HEADERS)

    assert response.status_code == 500
    body = response.json()
    assert body["success"] is False
    assert "launcher" in body["message"].lower()


def test_update_surfaces_subprocess_failure(client, monkeypatch):
    monkeypatch.setattr(upgrade, "_pip_available", lambda: True)

    def failing_run(command, *args, **kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="boom")

    monkeypatch.setattr(upgrade.subprocess, "run", failing_run)

    response = client.post("/version/update", headers=_HEADERS)

    assert response.status_code == 500
    assert response.json()["error"] == "boom"


def test_update_handles_timeout(client, monkeypatch):
    monkeypatch.setattr(upgrade, "_pip_available", lambda: True)

    def slow_run(command, *args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=command, timeout=300)

    monkeypatch.setattr(upgrade.subprocess, "run", slow_run)

    response = client.post("/version/update", headers=_HEADERS)

    assert response.status_code == 408
