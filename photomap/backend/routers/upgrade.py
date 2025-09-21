import signal
import subprocess
import sys
from importlib.metadata import version
from logging import getLogger

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from packaging import version as pversion

upgrade_router = APIRouter()
logger = getLogger(__name__)


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
async def update_version():
    """Update PhotoMapAI to the latest version using pip"""
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
async def restart_server():
    """Restart the server after update"""
    import os
    import subprocess
    import sys
    import threading
    import time

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
