"""Auto-open the user's web browser once the server is accepting connections.

The desktop experience should land the user on the running app without making them
copy a URL out of a terminal. We only do this for an interactive, local, non-dev
server; remote/headless/Docker deployments and the dev ``--reload`` loop are left
alone. See :func:`should_open_browser` for the exact guards.
"""

import logging
import os
import socket
import sys
import threading
import time
import webbrowser

logger = logging.getLogger(__name__)

# Hosts that mean "this machine" — the only ones we'll pop a browser for.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Wildcard binds; reachable locally via loopback even though we never auto-open for them.
_WILDCARD_HOSTS = {"0.0.0.0", "::"}

_FALSEY = {"", "0", "false", "no", "off"}


def _env_truthy(value: str | None) -> bool:
    """Return True for a set-and-non-falsey environment value."""
    return value is not None and value.strip().lower() not in _FALSEY


def _is_docker() -> bool:
    """Best-effort detection of running inside a Docker container."""
    return os.path.exists("/.dockerenv")


def _is_headless() -> bool:
    """True when there is no graphical display to open a browser into.

    Only Linux/BSD can be headless in practice; macOS and Windows always have a
    window server when a user is running the app.
    """
    if sys.platform.startswith(("linux", "freebsd")):
        return not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return False


def should_open_browser(host: str, *, no_browser: bool, reload: bool) -> bool:
    """Decide whether to auto-open a browser for a freshly started server.

    Suppressed when:
    - explicitly disabled via ``--no-browser`` or the ``PHOTOMAP_NO_BROWSER`` env var,
    - running under uvicorn ``--reload`` (a dev workflow that also spawns reloader children),
    - bound to a non-loopback interface (a remote/headless server, e.g. ``0.0.0.0``),
    - running headless or inside Docker.
    """
    if no_browser or _env_truthy(os.environ.get("PHOTOMAP_NO_BROWSER")):
        return False
    if reload:
        return False
    if host not in _LOOPBACK_HOSTS:
        return False
    if _is_docker() or _is_headless():
        return False
    return True


def open_browser_when_ready(host: str, port: int, *, timeout: float = 30.0) -> threading.Thread:
    """Spawn a daemon thread that opens the browser once ``port`` accepts a connection.

    Polling for an accepted TCP connection (rather than sleeping a fixed delay) means
    we open exactly when uvicorn is ready, and never open at all if the server fails to
    come up within ``timeout`` seconds.
    """
    thread = threading.Thread(
        target=_wait_and_open,
        args=(host, port, timeout),
        name="photomap-browser-opener",
        daemon=True,
    )
    thread.start()
    return thread


def _wait_and_open(host: str, port: int, timeout: float) -> None:
    connect_host = "127.0.0.1" if host in _WILDCARD_HOSTS else host
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((connect_host, port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.25)
    else:
        logger.debug("Server not reachable within %ss; not opening a browser", timeout)
        return

    url = f"http://{connect_host}:{port}"
    try:
        webbrowser.open(url)
        logger.info("Opened %s in your default browser", url)
    except Exception as exc:  # webbrowser can raise on misconfigured/headless systems
        logger.debug("Could not open a browser automatically: %s", exc)
