"""
Return parsed command-line arguments
"""

import argparse
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path


def get_version():
    """Get the current version of the PhotoMapAI package."""
    try:
        return version("photomapai")
    except PackageNotFoundError:
        return "unknown"


def get_args() -> argparse.Namespace:
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
        nargs='+',
        default=None,
        help="Lock to specific album(s) and disable album management. Provide one or more album keys separated by spaces (default: None)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload when source files change for development (default: False)",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {get_version()}",
        help="Show the version number and exit",
    )
    parser.add_argument(
        "--once", action="store_true", help="Run server once; do not respawn"
    )
    parser.add_argument(
        "--inline-upgrade",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Perform inline database upgrades",
    )
    return parser.parse_args()
