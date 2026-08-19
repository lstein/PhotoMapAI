"""
This module provides utility functions for the PhotoMap application."""

import os
import socket
import stat
import threading
from collections import OrderedDict
from collections.abc import Hashable
from pathlib import Path
from typing import Any, Generic, TypeVar

import numpy as np

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


def is_cuda_oom(err: BaseException) -> bool:
    """True if ``err`` is a CUDA out-of-memory error from torch.

    Tolerates older torch versions where the exception class differs by also
    sniffing the message of any ``RuntimeError``. Imported lazily so this
    module doesn't pull torch in when used from CLI tools or tests with a
    fake encoder that never touch CUDA.
    """
    try:
        import torch
    except ImportError:
        return False
    oom_cls = getattr(torch, "OutOfMemoryError", None)
    if oom_cls is not None and isinstance(err, oom_cls):
        return True
    return isinstance(err, RuntimeError) and "out of memory" in str(err).lower()


class BoundedLRU(Generic[K, V]):
    """Thread-safe LRU cache capped at ``maxsize`` entries.

    Replaces ad-hoc per-module ``dict``s that previously had no eviction
    policy (e.g. ``_curation_results`` accumulating one entry per curation
    job for the life of the server). Get / put are O(1) and serialized by
    an internal lock — fine for the modest hit rates these caches see.

    Hits move-to-end (most-recently-used). Inserts evict the
    least-recently-used entry once ``maxsize`` is exceeded.
    """

    def __init__(self, maxsize: int) -> None:
        if maxsize <= 0:
            raise ValueError(f"maxsize must be positive (got {maxsize})")
        self._maxsize = maxsize
        self._data: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: K, default: V | None = None) -> V | None:
        with self._lock:
            value = self._data.get(key)
            if value is None and key not in self._data:
                return default
            self._data.move_to_end(key)
            return value

    def put(self, key: K, value: V) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._maxsize:
                self._data.popitem(last=False)

    def __contains__(self, key: K) -> bool:
        with self._lock:
            return key in self._data

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


def atomic_savez(path: Path, **arrays: Any) -> None:
    """Write a ``.npz`` archive to ``path`` atomically.

    Writes to a sibling temp file and then ``Path.replace``s into place, so a
    crash or concurrent reader never sees a half-written file. Callers that
    previously called ``np.savez(path, ...)`` directly risked leaving a
    truncated index that the next read would fail to load.

    The temp name carries the pid and thread id rather than being a fixed
    ``<name>.tmp``: two threads writing the same target would otherwise open
    the *same* temp file, interleave their writes, and rename a corrupt
    archive into place — which, for a cache whose freshness is judged by
    mtime, is a permanently poisoned file rather than a transient error.
    Concurrent writers of one path now simply race to rename, and the winner's
    file is whole.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
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

    The rename replaces the file rather than writing through it, so two
    properties of the *existing* file have to be carried across by hand:

    * its permissions — config.yaml holds an InvokeAI password and a
      LocationIQ key, and a fresh file created at the process umask is
      typically world-readable, so a user who tightened it to 0600 would
      have it quietly widened again by the next album edit;
    * its identity when it is a symlink — a dotfiles setup symlinks
      config.yaml into a repo, and replacing the link with a regular file
      leaves the real config behind, still holding the old content.
    """
    if path.is_symlink():
        path = Path(os.path.realpath(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing_mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        existing_mode = None
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        with tmp_path.open("w", encoding=encoding) as fh:
            fh.write(text)
        if existing_mode is not None:
            os.chmod(tmp_path, existing_mode)
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
