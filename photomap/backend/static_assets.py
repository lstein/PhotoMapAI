"""Cache-busting for the no-build frontend.

PhotoMapAI serves its ES6 modules and CSS straight off disk with no bundler, so
a browser (iOS Safari especially) can hold on to a stale ``swiper.js`` or
stylesheet long after it changed — which once looked like a phantom regression.

The fix is *path-based* versioning: assets are referenced as
``static/<version>/css/base.css`` instead of ``static/css/base.css``. A query
string (``?v=...``) would not work here because the relative ``import`` URLs
inside a module resolve against the module's own URL with the query stripped, so
only the entry point would be busted. A version *path segment* is preserved
through relative resolution: ``main.js`` loaded from ``/static/<v>/main.js``
imports ``./javascript/state.js`` as ``/static/<v>/javascript/state.js``, so the
whole module graph (and ``@import``-free CSS) inherits the version automatically.

``VersionedStaticFiles`` strips the leading ``<version>`` segment back off so the
file is still found on disk, and stamps versioned responses as immutable so the
browser may cache them forever — a new release changes the version, hence the
URL, so there is nothing stale to serve. Unversioned ``/static/...`` requests
still work unchanged (e.g. the hardcoded ``unsupported-browser.html`` fallback).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# Files whose contents define the asset fingerprint. Limiting to the text assets
# that are actually served to the page keeps startup hashing cheap and stable.
_HASHED_SUFFIXES = {".js", ".css", ".html", ".webmanifest"}


def compute_asset_version(static_dir: str | Path, app_version: str) -> str:
    """Return a stable cache-busting token for the current static assets.

    The token folds in the package version and a content hash of the served
    text assets, so it changes whenever any module/stylesheet changes (busting
    caches) but is identical across restarts and deploys of the same code
    (keeping caches warm). Pure content hashing — not mtimes — so reinstalling
    the same release does not needlessly invalidate client caches.
    """
    static_dir = Path(static_dir)
    hasher = hashlib.sha1()
    hasher.update(app_version.encode("utf-8"))
    for path in sorted(static_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in _HASHED_SUFFIXES:
            continue
        hasher.update(path.relative_to(static_dir).as_posix().encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
    # Keep the token to URL-path-safe characters: dev versions from
    # importlib.metadata can carry '+'/local-version segments (e.g.
    # "1.0.7.dev3+g1234") that read awkwardly inside a path.
    safe_version = re.sub(r"[^A-Za-z0-9.-]", "-", app_version)
    return f"v{safe_version}.{hasher.hexdigest()[:10]}"


class VersionedStaticFiles(StaticFiles):
    """``StaticFiles`` that accepts (and strips) a leading ``<version>`` segment.

    ``/static/<version>/css/base.css`` is served from ``css/base.css`` on disk
    and marked immutable; plain ``/static/css/base.css`` is served as usual.
    """

    def __init__(self, *args, version: str, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._version_prefix = f"{version}/"

    async def get_response(self, path: str, scope: Scope) -> Response:
        # StaticFiles.get_path normalises to OS-specific separators, so on
        # Windows ``path`` arrives with backslashes (e.g. ``v1.2.3\\main.js``).
        # Compare on forward slashes so the version segment is recognised on
        # every platform; the forward-slash remainder we hand back to
        # ``super().get_response`` resolves correctly on Windows too.
        normalized = path.replace("\\", "/")
        versioned = normalized.startswith(self._version_prefix)
        if versioned:
            path = normalized[len(self._version_prefix) :]
        response = await super().get_response(path, scope)
        if versioned and response.status_code == 200:
            # The version segment uniquely identifies this content, so it can be
            # cached indefinitely; a new release changes the URL.
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
