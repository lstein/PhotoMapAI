# slideshow_server.py
"""
Main entry point for the PhotoMapAI backend server.
Initializes the FastAPI app, mounts routers, and handles server startup.
"""
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from photomap.backend.args import get_args, get_version
from photomap.backend.config import get_config_manager
from photomap.backend.constants import get_package_resource_path
from photomap.backend.routers.album import album_router
from photomap.backend.routers.filetree import filetree_router
from photomap.backend.routers.index import index_router
from photomap.backend.routers.search import search_router
from photomap.backend.routers.umap import umap_router
from photomap.backend.routers.upgrade import upgrade_router
from photomap.backend.util import get_app_url
from photomap.backend.routers.curation import router as curation_router

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

app.include_router(curation_router, prefix="/api/curation", tags=["curation"])

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

    inline_upgrades_allowed = os.environ.get("PHOTOMAP_INLINE_UPGRADE", "1") == "1"
    logger.info(f"Inline upgrades allowed: {inline_upgrades_allowed}")

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
            "inline_upgrades_allowed": inline_upgrades_allowed,
        },
    )


def start_photomap_loop():
    """Start the PhotoMapAI server loop."""
    running = True
    exe_dir = os.path.dirname(sys.executable)
    photomap_server_exe = os.path.join(exe_dir, Path(sys.argv[0]).name)
    args = [photomap_server_exe] + sys.argv[1:] + ["--once"]

    while running:
        try:
            logger.info("Loading...")
            subprocess.run(args, check=True)
        except KeyboardInterrupt:
            logger.warning("Shutting down server...")
            running = False
        except subprocess.CalledProcessError as e:
            running = abs(e.returncode) == signal.SIGTERM.value
            if running:
                logger.info("Restarting server.")
            else:
                logger.error(f"Server exited with error code {e.returncode}")


# Set up Uvicorn Logging
def uvicorn_logging():
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "()": "photomap.backend.UvicornStyleFormatter",
                "fmt": "%(asctime)s %(levelname)s:%(uvicorn_pad)s%(message)s",
                "datefmt": "%Y-%m-%d %H:%M:%S",
            },
        },
        "handlers": {
            "default": {
                "formatter": "default",
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
            "uvicorn.error": {
                "handlers": ["default"],
                "level": "INFO",
                "propagate": False,
            },
            "uvicorn.access": {
                "handlers": ["default"],
                "level": "INFO",
                "propagate": False,
            },
        },
    }


# Main Entry Point
def main():
    """Main entry point for the slideshow server."""
    args = get_args()
    if not args.once:
        start_photomap_loop()
        return

    import uvicorn

    repo_root = Path(get_package_resource_path("photomap"), "../..").resolve()

    port = args.port or int(os.environ.get("PHOTOMAP_PORT", "8050"))
    host = args.host or os.environ.get("PHOTOMAP_HOST", "127.0.0.1")

    if args.config:
        os.environ["PHOTOMAP_CONFIG"] = args.config.as_posix()

    if args.album_locked:
        os.environ["PHOTOMAP_ALBUM_LOCKED"] = args.album_locked

    os.environ["PHOTOMAP_INLINE_UPGRADE"] = "1" if args.inline_upgrade else "0"

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
        log_config=uvicorn_logging(),
    )


if __name__ == "__main__":
    main()
