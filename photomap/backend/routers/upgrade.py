import os
import signal
import subprocess
import sys
import threading
import time
from importlib.metadata import version
from logging import getLogger

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from packaging import version as pversion

upgrade_router = APIRouter()
logger = getLogger(__name__)


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
    """Update PhotoMapAI to the latest version using pip"""
    _require_inline_upgrades_enabled()
    _require_same_origin_header(request)
    try:
        # Run pip install --upgrade photomapai
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "photomapai"],
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
