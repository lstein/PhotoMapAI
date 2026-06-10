import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from importlib.metadata import version
from logging import getLogger
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from packaging import version as pversion

upgrade_router = APIRouter()
logger = getLogger(__name__)

# The package name to upgrade on PyPI / via the chosen package manager.
_PACKAGE = "photomapai"


class UpgradeUnavailableError(RuntimeError):
    """No usable self-upgrade mechanism for the current install."""


def _pip_available() -> bool:
    """True when ``pip`` can be run as ``python -m pip`` in this interpreter."""
    return importlib.util.find_spec("pip") is not None


def _find_uv() -> str | None:
    """Locate the ``uv`` executable for a uv-managed (pip-less) install.

    The server process runs under uv's tool environment, which is *not* on the
    same ``PATH`` we can rely on, so ``shutil.which`` may miss it. Fall back to
    the location uv self-installs to (``~/.local/bin`` on every platform).
    """
    found = shutil.which("uv")
    if found:
        return found
    for name in ("uv", "uv.exe"):
        candidate = Path.home() / ".local" / "bin" / name
        if candidate.is_file():
            return str(candidate)
    return None


def _build_upgrade_command() -> list[str]:
    """Return the argv that upgrades PhotoMapAI for the current install method.

    Pip-based installs (e.g. the dev editable venv, or the legacy installer
    scripts) keep using ``python -m pip``. Installs created by the desktop
    launcher use ``uv tool install``, which produces a deliberately pip-less
    environment — there ``python -m pip`` fails with "No module named pip", so
    we drive ``uv tool upgrade`` instead. We branch on whether ``pip`` is
    actually importable rather than sniffing install paths, since that is the
    exact condition that makes the pip command fail.
    """
    if _pip_available():
        return [sys.executable, "-m", "pip", "install", "--upgrade", _PACKAGE]
    uv = _find_uv()
    if uv is None:
        raise UpgradeUnavailableError(
            "This installation has no pip and the 'uv' command could not be found, "
            "so it cannot upgrade itself in place. Please re-run the PhotoMapAI "
            "launcher (with --reinstall) to update to the latest version."
        )
    return [uv, "tool", "upgrade", _PACKAGE]


def _require_inline_upgrades_enabled() -> None:
    """Honour the ``PHOTOMAP_INLINE_UPGRADE`` deployment switch.

    The flag is set from ``--inline-upgrade`` / env on startup; when the
    operator has explicitly disabled it the UI hides the button, but the
    endpoint was previously still callable.  Enforce it here so the backend
    is the source of truth.
    """
    if os.environ.get("PHOTOMAP_INLINE_UPGRADE", "1") != "1":
        raise HTTPException(
            status_code=403,
            detail="Inline upgrades are disabled on this deployment.",
        )


def _require_same_origin_header(request: Request) -> None:
    """Reject requests that lack the ``X-Requested-With`` marker.

    The update and restart endpoints perform side effects (pip install,
    process kill) and have no authentication.  A cross-origin page could
    otherwise submit a CSRF-able simple POST to ``http://localhost:8050``
    and trigger either action.  Requiring a non-standard request header
    forces the caller through a CORS preflight, which our server does not
    answer — so only same-origin JS with an explicit header succeeds.
    """
    if request.headers.get("x-requested-with") != "photomap":
        raise HTTPException(
            status_code=403,
            detail="Missing required X-Requested-With header.",
        )


@upgrade_router.get("/version/check", tags=["Upgrade"])
async def check_version():
    """Check if a newer version is available on PyPI"""
    try:
        # Get latest version from PyPI
        response = requests.get("https://pypi.org/pypi/photomapai/json", timeout=10)
        response.raise_for_status()

        pypi_data = response.json()
        latest_version = pypi_data["info"]["version"]

        # Get the current version
        current_version = version("photomapai")

        # Compare versions
        current_ver = pversion.parse(current_version)
        latest_ver = pversion.parse(latest_version)

        update_available = latest_ver > current_ver

        return JSONResponse(
            content={
                "current_version": current_version,
                "latest_version": latest_version,
                "update_available": update_available,
            }
        )

    except requests.RequestException as e:
        return JSONResponse(
            content={"error": f"Failed to check for updates: {str(e)}"}, status_code=503
        )
    except Exception as e:
        return JSONResponse(
            content={"error": f"Version check failed: {str(e)}"}, status_code=500
        )


@upgrade_router.post("/version/update", tags=["Upgrade"])
async def update_version(request: Request):
    """Update PhotoMapAI to the latest version via pip or uv (per install type)."""
    _require_inline_upgrades_enabled()
    _require_same_origin_header(request)
    try:
        command = _build_upgrade_command()
    except UpgradeUnavailableError as e:
        return JSONResponse(
            content={"success": False, "message": str(e)},
            status_code=500,
        )
    try:
        # Upgrade via pip or `uv tool upgrade`, depending on how this install
        # was created (see _build_upgrade_command).
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode == 0:
            return JSONResponse(
                content={
                    "success": True,
                    "message": "Update completed successfully. Server will restart automatically.",
                    "output": result.stdout,
                    "restart_available": True,
                }
            )
        else:
            return JSONResponse(
                content={
                    "success": False,
                    "message": "Update failed",
                    "error": result.stderr,
                },
                status_code=500,
            )

    except subprocess.TimeoutExpired:
        return JSONResponse(
            content={"success": False, "message": "Update timed out after 5 minutes"},
            status_code=408,
        )
    except Exception as e:
        return JSONResponse(
            content={"success": False, "message": f"Update failed: {str(e)}"},
            status_code=500,
        )


@upgrade_router.post("/version/restart", tags=["Upgrade"])
async def restart_server(request: Request):
    """Restart the server after update"""
    _require_inline_upgrades_enabled()
    _require_same_origin_header(request)

    def delayed_restart():
        time.sleep(2)  # Give time for response to be sent
        os.kill(os.getpid(), signal.SIGTERM)

    # Start restart in background thread
    threading.Thread(target=delayed_restart, daemon=True).start()

    return JSONResponse(
        content={
            "success": True,
            "message": "Server restart initiated. Please refresh your browser in a few seconds.",
        }
    )
