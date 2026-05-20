"""
This module provides utility functions for the PhotoMap application."""

import os
import socket
from pathlib import Path
from typing import Any

import numpy as np


def atomic_savez(path: Path, **arrays: Any) -> None:
    """Write a ``.npz`` archive to ``path`` atomically.

    Writes to a sibling ``<name>.tmp`` and then ``Path.replace``s into place,
    so a crash or concurrent reader never sees a half-written file. Callers
    that previously called ``np.savez(path, ...)`` directly risked leaving a
    truncated index that the next read would fail to load.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        with tmp_path.open("wb") as fh:
            np.savez(fh, **arrays)
        os.replace(tmp_path, path)
    except BaseException:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """Write ``text`` to ``path`` atomically via a ``.tmp`` rename.

    Used for long-lived config files where a partial write would leave the
    user unable to reload the app.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        with tmp_path.open("w", encoding=encoding) as fh:
            fh.write(text)
        os.replace(tmp_path, path)
    except BaseException:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise


def get_public_ip_and_hostname():
    try:
        # This does not actually connect to 8.8.8.8, just figures out the outbound interface
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        try:
            hostname = socket.gethostbyaddr(ip)[0]
        except Exception:
            hostname = None
        return ip, hostname
    except Exception:
        return None, None


def get_app_url(host: str, port: int) -> str:
    """Get the URL to access the app based on environment variables and network configuration."""
    ip, hostname = get_public_ip_and_hostname()
    if host == "0.0.0.0":
        if ip:
            if hostname and hostname != ip:
                url = f"http://{hostname}:{port} (or http://{ip}:{port})"
            else:
                url = f"http://{ip}:{port}"
        else:
            url = f"http://127.0.0.1:{port}"
    else:
        url = f"http://{host}:{port}"
    return url
