# slideshow_server.py
print("Loading, please wait...")
import logging
import os
import signal
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import get_config_manager
from .constants import get_package_resource_path
from .routers.album import album_router
from .routers.filetree import filetree_router
from .routers.index import index_router
from .routers.search import search_router
from .routers.umap import umap_router
from .routers.upgrade import upgrade_router
from .util import get_app_url

# Initialize logging
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="PhotoMapAI")

# Include routers
for router in [
    umap_router,
    search_router,
    index_router,
    album_router,
    filetree_router,
    upgrade_router,
]:
    app.include_router(router)

# Mount static files and templates
static_path = get_package_resource_path("static")
app.mount("/static", StaticFiles(directory=static_path), name="static")

templates_path = get_package_resource_path("templates")
templates = Jinja2Templates(directory=templates_path)


# Main Routes
@app.get("/", response_class=HTMLResponse, tags=["Main"])
async def get_root(
    request: Request,
    album: Optional[str] = None,
    delay: int = 0,
    high_water_mark: Optional[int] = None,
    mode: Optional[str] = None,
):
    """Serve the main slideshow page."""
    if os.environ.get("PHOTOMAP_ALBUM_LOCKED"):
        album = os.environ.get("PHOTOMAP_ALBUM_LOCKED")
        album_locked = True
    else:
        album_locked = False
        config_manager = get_config_manager()
        if album is not None:
            albums = config_manager.get_albums()
            if albums and album in albums:
                pass
            elif albums:
                album = list(albums.keys())[0]

    return templates.TemplateResponse(
        request,
        "main.html",
        {
            "album": album,
            "delay": delay,
            "mode": mode,
            "highWaterMark": high_water_mark,
            "version": get_version(),
            "album_locked": album_locked,
        },
    )


def get_version():
    """Get the current version of the PhotoMapAI package."""
    try:
        return version("photomapai")
    except PackageNotFoundError:
        return "unknown"


# Main Entry Point
def main():
    """Main entry point for the slideshow server."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Run the PhotoMap slideshow server.")
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to the configuration file (default: ~/.config/photomap/config.yaml, uses environment variable PHOTOMAP_CONFIG)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=None,
        help="Network interface to run the server on (default: 127.0.0.1), uses environment variable PHOTOMAP_HOST",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to run the server on (default: 8050), uses environment variable PHOTOMAP_PORT",
    )
    parser.add_argument(
        "--cert",
        type=Path,
        default=None,
        help="Path to SSL certificate file (optional, for HTTPS)",
    )
    parser.add_argument(
        "--key",
        type=Path,
        default=None,
        help="Path to SSL key file (optional, for HTTPS)",
    )
    parser.add_argument(
        "--album-locked",
        type=str,
        default=None,
        help="Start with a specific locked in album and disable album management (default: None)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload when source files change for development (default: False)",
    )
    args = parser.parse_args()

    repo_root = Path(get_package_resource_path("photomap"), "../..").resolve()

    port = args.port or int(os.environ.get("PHOTOMAP_PORT", "8050"))
    host = args.host or os.environ.get("PHOTOMAP_HOST", "127.0.0.1")

    if args.config:
        os.environ["PHOTOMAP_CONFIG"] = args.config.as_posix()

    if args.album_locked:
        os.environ["PHOTOMAP_ALBUM_LOCKED"] = args.album_locked

    app_url = get_app_url(host, port)

    config = get_config_manager()
    logger.info(f"Using configuration file: {config.config_path}")
    logger.info(f"Backend root directory: {repo_root}")
    logger.info(
        f"Please open your browser to \033[1m{app_url}\033[0m to access the PhotoMapAI application"
    )

    uvicorn.run(
        "photomap.backend.photomap_server:app",
        host=host,
        port=port,
        reload=args.reload,
        reload_dirs=[repo_root.as_posix()],
        ssl_keyfile=str(args.key) if args.key else None,
        ssl_certfile=str(args.cert) if args.cert else None,
        log_level="info",
    )


if __name__ == "__main__":
    main()
