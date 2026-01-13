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

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from photomap.backend.args import get_args, get_version
from photomap.backend.config import get_config_manager
from photomap.backend.constants import get_package_resource_path
from photomap.backend.routers.album import album_router, get_locked_albums
from photomap.backend.routers.curation import router as curation_router
from photomap.backend.routers.filetree import filetree_router
from photomap.backend.routers.index import index_router
from photomap.backend.routers.search import search_router
from photomap.backend.routers.umap import umap_router
from photomap.backend.routers.upgrade import upgrade_router
from photomap.backend.util import get_app_url

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
    album: str | None = None,
    delay: int = 0,
    high_water_mark: int | None = None,
    mode: str | None = None,
):
    """Serve the main slideshow page."""
    locked_albums = get_locked_albums()
    if locked_albums:
        album_locked = True
        multiple_locked_albums = len(locked_albums) > 1

        # If album is provided in URL, validate it's in the locked list
        if album is not None and album in locked_albums:
            pass  # Use the album from URL
        else:
            # Default to the first locked album
            album = locked_albums[0]
    else:
        album_locked = False
        multiple_locked_albums = False
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
            "multiple_locked_albums": multiple_locked_albums,
            "inline_upgrades_allowed": inline_upgrades_allowed,
        },
    )


def start_photomap_loop():
    """Start the PhotoMapAI server loop."""
    running = True
    args = [sys.executable] + ["-m", "photomap.backend.photomap_server"] + sys.argv[1:] + ["--once"]

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
        # Convert list of album keys to comma-separated string
        os.environ["PHOTOMAP_ALBUM_LOCKED"] = ",".join(args.album_locked)

    os.environ["PHOTOMAP_INLINE_UPGRADE"] = "1" if args.inline_upgrade else "0"

    app_url = get_app_url(host, port)

    config = get_config_manager()

    # Validate that all locked albums exist in the configuration
    if args.album_locked:
        available_albums = config.get_albums()
        if not available_albums:
            logger.error("Error: No albums are configured in the configuration file.")
            logger.error("Cannot lock to albums when no albums exist.")
            sys.exit(1)

        invalid_albums = [album for album in args.album_locked if album not in available_albums]
        if invalid_albums:
            logger.error("Error: The following album(s) specified in --album-locked do not exist in the configuration:")
            for album in invalid_albums:
                logger.error(f"  - {album}")
            logger.error(f"Available albums: {', '.join(available_albums.keys())}")
            sys.exit(1)

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
