"""Shared HTTP client helpers for talking to an InvokeAI backend.

This module owns everything needed to make authenticated calls against a
running InvokeAI instance: URL validation, the JWT token cache with its
single-user/multi-user fallback logic, and thin wrappers around the
InvokeAI REST endpoints PhotoMap consumes (version probe, board listing,
board image and video paths, image and video deletion).

Images and videos are distinct resources on the InvokeAI side — separate
routers, separate output directories — so each has its own wrapper here
over the shared paging helper.

Board contents are reported as paths *relative to the media type's outputs
directory*, never as bare names: InvokeAI's subfolder strategy is a
server-side setting, and the subfolder each file was actually written to is
recorded per row, so only the row itself says where the file lives.

It deliberately lives outside ``routers/`` so that non-router code (the
indexing pipeline, curation) can use it without importing a FastAPI router
module. ``routers/invoke.py`` re-exports the auth helpers for backward
compatibility with existing tests.

The token cache holds a single entry keyed by ``(base_url, username)``.
Per-album credentials that differ from the global settings will therefore
thrash it — each switch costs one extra login round-trip. That is
acceptable for the access patterns here (indexing and deletion are not
high-frequency), so no multi-entry cache is kept.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from typing import NamedTuple
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# 5 seconds is plenty for a local loopback call; anything slower almost
# certainly means the backend is unreachable rather than genuinely busy.
_HTTP_TIMEOUT = 5.0

# Listing the contents of a very large board can legitimately take longer
# than the snappy 5s used for control-plane calls.
_BOARD_FETCH_TIMEOUT = 30.0

# The videos listing declares ``limit: le=MAX_PAGE_SIZE`` and answers 422
# above it; the images listing has no such clamp.  MAX_PAGE_SIZE has been
# 1000 since it was introduced, so this is the largest page both will serve.
_DTO_PAGE_SIZE = 1000

# Last-resort backstop.  A server that ignores ``offset`` is normally caught
# far sooner, by the "paged past the declared total" break in the walk.
_MAX_DTO_PAGES = 1_000

# ── InvokeAI JWT token cache ──────────────────────────────────────────
_cached_token: str | None = None
_token_expires_at: float = 0.0
_token_base_url: str | None = None
_token_username: str | None = None


def _cached_auth_headers(base_url: str, username: str | None) -> dict[str, str]:
    """Return ``{"Authorization": "Bearer ..."}`` if we still hold a valid
    cached token for this ``(base_url, username)`` pair, else ``{}``.

    This never talks to the network.  Deliberate: the first attempt at any
    request always uses whatever auth we already have (or none), so that a
    backend that has since been reconfigured into single-user mode is given
    a chance to accept the call anonymously.
    """
    if (
        _cached_token
        and time.monotonic() < _token_expires_at
        and _token_base_url == base_url
        and _token_username == username
    ):
        return {"Authorization": f"Bearer {_cached_token}"}
    return {}


async def _login(base_url: str, username: str, password: str) -> dict[str, str]:
    """Exchange ``username``/``password`` for a JWT via the InvokeAI auth
    endpoint, cache the token, and return the ``Authorization`` header.
    """
    global _cached_token, _token_expires_at, _token_base_url, _token_username  # noqa: PLW0603

    login_url = f"{base_url.rstrip('/')}/api/v1/auth/login"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.post(login_url, json={"email": username, "password": password})
    except httpx.RequestError as exc:
        logger.warning("InvokeAI auth request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend for authentication: {exc}",
        ) from exc

    if resp.status_code != 200:
        detail = resp.json().get("detail", resp.text[:200]) if resp.headers.get("content-type", "").startswith("application/json") else resp.text[:200]
        raise HTTPException(
            status_code=502,
            detail=f"InvokeAI authentication failed ({resp.status_code}): {detail}",
        )

    data = resp.json()
    _cached_token = data["token"]
    _token_expires_at = time.monotonic() + data.get("expires_in", 86400) - 60  # refresh 60s early
    _token_base_url = base_url
    _token_username = username
    return {"Authorization": f"Bearer {_cached_token}"}


def _invalidate_token_cache() -> None:
    """Clear the cached token so the next request re-authenticates."""
    global _cached_token, _token_expires_at, _token_base_url, _token_username  # noqa: PLW0603
    _cached_token = None
    _token_expires_at = 0.0
    _token_base_url = None
    _token_username = None


async def _request_with_auth_fallback(
    base_url: str,
    username: str | None,
    password: str | None,
    request_fn: Callable[[dict[str, str]], Awaitable[httpx.Response]],
) -> httpx.Response:
    """Perform an InvokeAI request with graceful handling of auth transitions.

    ``request_fn`` is an async callable that takes a headers dict and
    performs the HTTP call — using a factory lets the caller re-open file
    streams (needed for multipart uploads) on a retry.

    Three-step flow:

    1. First attempt uses whatever token we have cached (or no auth at all).
       A freshly-restarted single-user backend then accepts the call even
       if credentials are stored in PhotoMap.
    2. If the first attempt returns **401**, the backend demands
       authentication: if credentials are configured we log in, cache a
       fresh token, and retry.
    3. If the first attempt was made *with* a token and returns **403**
       (most commonly "Multiuser mode is disabled. Authentication is not
       required…"), the backend was reconfigured to single-user mode — we
       invalidate the cached token and retry anonymously.
    """
    auth_headers = _cached_auth_headers(base_url, username)
    response = await request_fn(auth_headers)

    if response.status_code == 401 and username and password:
        _invalidate_token_cache()
        auth_headers = await _login(base_url, username, password)
        response = await request_fn(auth_headers)
    elif response.status_code == 403 and auth_headers:
        _invalidate_token_cache()
        response = await request_fn({})

    return response


def _validate_invokeai_url(url: str | None) -> str | None:
    """Reject non-http(s) schemes so configured URLs cannot be used for SSRF.

    The configured URL is later concatenated into outbound requests; ``httpx``
    already refuses non-http(s) schemes, but validating up front returns
    a clean 400 to the caller rather than a 502 at call time, and blocks
    obviously-wrong values like ``file://`` or ``javascript:`` from ever
    reaching the config file.

    Empty / None is allowed — that's "not configured yet".
    """
    if not url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid InvokeAI URL: {exc}"
        ) from exc
    if parts.scheme not in {"http", "https"}:
        raise HTTPException(
            status_code=400,
            detail="InvokeAI URL must use http:// or https://",
        )
    if not parts.netloc:
        raise HTTPException(
            status_code=400, detail="InvokeAI URL must include a host"
        )
    return url


async def check_status(base_url: str | None) -> dict:
    """Report whether ``base_url`` is reachable and looks like InvokeAI.

    Probes the unauthenticated ``/api/v1/app/version`` endpoint.  Returns
    ``{"reachable": True, "version": ...}`` on success and
    ``{"reachable": False, "detail": ...}`` for any network or HTTP failure
    rather than raising, so callers can render a neutral hint instead of an
    error banner while the user is still typing.
    """
    if not base_url:
        return {"reachable": False, "detail": "No InvokeAI URL configured"}

    version_url = f"{base_url.rstrip('/')}/api/v1/app/version"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(version_url)
    except httpx.RequestError as exc:
        return {"reachable": False, "detail": f"Could not reach backend: {exc}"}

    if resp.status_code != 200:
        return {
            "reachable": False,
            "detail": f"Backend returned HTTP {resp.status_code}",
        }
    not_invokeai = "Server is reachable but doesn't appear to be an InvokeAI backend"
    try:
        payload = resp.json()
    except ValueError:
        return {"reachable": False, "detail": not_invokeai}
    version = payload.get("version")
    if not version:
        # A non-InvokeAI server happening to have /api/v1/app/version would
        # almost certainly not return a version field.
        return {"reachable": False, "detail": not_invokeai}
    return {"reachable": True, "version": version}


async def list_boards(
    base_url: str,
    username: str | None,
    password: str | None,
) -> list[dict]:
    """Return the boards available on ``base_url``.

    Uses the same auth-fallback pattern as the other wrappers.  Returns a
    flat ``[{"board_id": ..., "board_name": ...}]`` list.  Any failure
    (unreachable, auth, 5xx) raises 502.
    """
    boards_url = f"{base_url.rstrip('/')}/api/v1/boards/"

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.get(
                    boards_url, params={"all": "true"}, headers=headers
                )

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI boards request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI backend returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    try:
        raw = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="Boards endpoint did not return JSON"
        ) from exc

    # ``?all=true`` returns a flat list; without it InvokeAI returns
    # ``{"items": [...], "offset": ..., "total": ...}``.  Handle both shapes
    # so an accidentally-paginated response doesn't blank out the dropdown.
    items = raw if isinstance(raw, list) else raw.get("items", [])
    return [
        {
            "board_id": item.get("board_id"),
            "board_name": item.get("board_name") or "(unnamed board)",
        }
        for item in items
        if isinstance(item, dict) and item.get("board_id")
    ]


def _has_path_syntax(part: str) -> bool:
    """True if ``part`` is anything other than one plain path component.

    An empty string, a dot segment, or a component carrying a separator of
    either flavour all mean the server handed back structure where a bare
    name was expected — which is the only way a joined path can leave the
    outputs directory.
    """
    return not part or part in {".", ".."} or "/" in part or "\\" in part


def _media_relpath(name: object, subfolder: object, resource: str) -> str | None:
    """Join InvokeAI's stored subfolder onto a media name, or ``None``.

    InvokeAI does not necessarily store a board's media flat under
    ``outputs/images`` / ``outputs/videos``: the subfolder strategy is a
    server-side setting (``flat``, ``type``, ``date``, ``hash``) and the
    subfolder actually used is recorded per row at save time, which is why
    it has to be read off each DTO rather than derived here.  An empty or
    absent subfolder is the flat layout, and is what every InvokeAI
    predating the setting reports.

    The result is turned into a local filesystem path by the caller, so the
    server's string is treated as untrusted: a name that is not a bare
    basename, or a subfolder that is absolute or walks upwards, is dropped
    with a warning rather than allowed to escape the outputs directory.

    The accepted grammar is deliberately the one InvokeAI itself enforces
    when it *writes* a subfolder (``DiskImageFileStorage._validate_subfolder``):
    forward-slash separated, relative, no empty or dot segments, and no
    backslashes at all.  Every strategy emits ``/`` even when InvokeAI runs
    on Windows, so a backslash is not a separator to be normalized but a
    value InvokeAI would have refused to store.  Rewriting them to ``/``
    instead is actively unsafe: a lone backslash followed by ``etc`` is not
    absolute as written, so an is-absolute check on it passes, and it then
    *becomes* ``/etc`` — and joining an absolute path discards the outputs
    directory entirely.

    Names are held to the same rule.  Testing only for ``/`` leaves a
    backslash-separated ``..`` chain looking like an ordinary filename,
    which it is on Linux but is not on a Windows PhotoMap host, where those
    segments would be walked.
    """
    if not isinstance(name, str) or _has_path_syntax(name):
        logger.warning("Ignoring InvokeAI %s with a suspicious name: %r", resource, name)
        return None
    if not subfolder:
        return name
    if not isinstance(subfolder, str):
        logger.warning(
            "Ignoring InvokeAI %s %r: non-string subfolder %r", resource, name, subfolder
        )
        return None
    parts = subfolder.split("/")
    if any(_has_path_syntax(part) for part in parts):
        logger.warning(
            "Ignoring InvokeAI %s %r: unsafe subfolder %r", resource, name, subfolder
        )
        return None
    return "/".join([*parts, name])


class BoardMediaPaths(NamedTuple):
    """What a board listing learned about one media type on a board.

    ``relpaths`` are paths *relative to that media type's outputs directory*
    (``general/x.mp4`` under a type-organized InvokeAI, plain ``x.mp4``
    under a flat one), so the caller only has to join them to
    ``<invokeai_root>/outputs/<images|videos>``.

    ``api_available`` is False when the backend answered 404 for the
    listing router.  ``relpaths`` may still be non-empty in that case
    (earlier boards in the same call succeeded); what the flag says is that
    the listing is incomplete, so an empty or short list must not be read as
    "these files were removed from the board".
    """

    relpaths: list[str]
    api_available: bool


class _BoardWalk(NamedTuple):
    """One pass over a single board's listing.

    ``relpaths`` is in listing order and may repeat an entry: rows added
    while the walk is in progress shift later rows to a higher offset, so a
    page can re-show something an earlier page already returned.

    ``seen_names`` holds the raw names, deduped, *before* sanitizing — it is
    what gets compared against ``declared_total``, so a row dropped for an
    unsafe path does not read as a page the server failed to serve.
    """

    relpaths: list[str]
    seen_names: set[str]
    declared_total: int | None


async def _fetch_board_media_relpaths(
    base_url: str,
    board_ids: list[str],
    username: str | None,
    password: str | None,
    *,
    resource: str,
    name_key: str,
    subfolder_key: str,
    tolerate_absent_router: bool,
) -> BoardMediaPaths:
    """Page a board listing endpoint and return relative on-disk paths.

    ``GET /api/v1/{resource}/`` is used rather than the cheaper
    ``.../names`` endpoints because only the DTO carries the row's
    subfolder, and without it there is no way to locate the file on disk on
    any InvokeAI not configured for the flat layout.  (The name endpoints
    are deprecated upstream in favour of the polymorphic gallery listing
    anyway.)  It costs roughly one request per 1000 rows and a fatter
    payload, since a whole DTO is fetched to read one field.

    Canvas intermediates (region masks, staging composites) and
    control/mask-category assets are excluded, matching what InvokeAI's own
    gallery shows — a Wan pipeline writes its intermediate clips to the
    board just as canvas writes its staging images.  Servers that predate
    these query params ignore them and return the unfiltered list.

    **Completeness matters more than freshness here.**  The caller feeds
    this list to an index *update*, which prunes every indexed row the list
    does not mention, so a listing that is quietly short deletes rows for
    files that are still on the board.  Offset pagination is not a snapshot:
    InvokeAI orders by ``starred DESC, created_at DESC`` and serves each page
    from a separate query, so deleting, unstarring or un-boarding one row
    between pages shifts every later row down an offset and skips exactly one
    of them.  Each board is therefore checked against the ``total`` its own
    listing reported, re-walked once if it came up short, and only then
    failed — an aborted update leaves the previous index intact, which is the
    recoverable outcome; silently pruning live rows is not.  (Rows *added*
    mid-walk are harmless: they push entries to a higher offset, so they can
    only produce a repeat, which the dedupe absorbs.)

    ``tolerate_absent_router`` reports a 404 as ``api_available=False``
    instead of raising.  That matters only for videos: an InvokeAI predating
    video support has no ``/api/v1/videos`` router at all, and a board album
    on such a backend still has to index its images.  The 404 is *not*
    unambiguous — InvokeAI answers 404 "Board not found" for a caller whose
    board id no longer resolves, and a reverse proxy can route
    ``/api/v1/images`` while 404ing ``/api/v1/videos`` — so an absent
    listing is reported as a distinct fact from an empty one, and only the
    caller can decide whether dropping previously indexed rows is warranted.

    Paths already collected from earlier boards are kept when a later board
    404s, for the same reason: they were fetched successfully and are not
    made wrong by a subsequent failure.
    """
    filter_params: dict[str, object] = {
        "is_intermediate": "false",
        "categories": ["general", "user"],
        "limit": _DTO_PAGE_SIZE,
    }
    list_url = f"{base_url.rstrip('/')}/api/v1/{resource}/"
    all_relpaths: list[str] = []

    def _incomplete(walk: _BoardWalk) -> bool:
        """Did the walk return fewer distinct rows than the server claimed?"""
        return walk.declared_total is not None and len(walk.seen_names) < walk.declared_total

    try:
        async with httpx.AsyncClient(timeout=_BOARD_FETCH_TIMEOUT) as client:

            async def _walk(board_id: str) -> _BoardWalk | None:
                """One full pass over ``board_id``; ``None`` if it 404'd and
                a 404 is tolerated for this resource."""
                relpaths: list[str] = []
                seen_names: set[str] = set()
                declared_total: int | None = None
                offset = 0
                for _ in range(_MAX_DTO_PAGES):
                    params = {**filter_params, "board_id": board_id, "offset": offset}

                    async def _do(
                        headers: dict[str, str], params: dict = params
                    ) -> httpx.Response:
                        return await client.get(list_url, params=params, headers=headers)

                    response = await _request_with_auth_fallback(
                        base_url, username, password, _do
                    )
                    if response.status_code == 404 and tolerate_absent_router:
                        logger.info(
                            "InvokeAI backend at %s did not answer the %s listing "
                            "for board %r (no such API, or the board is not "
                            "readable); board %s were not listed.",
                            base_url,
                            resource,
                            board_id,
                            resource,
                        )
                        return None
                    if response.status_code >= 400:
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"InvokeAI backend returned {response.status_code} for "
                                f"{resource} on board {board_id!r}: {response.text[:200]}"
                            ),
                        )
                    try:
                        payload = response.json()
                    except ValueError as exc:
                        raise HTTPException(
                            status_code=502,
                            detail=f"The {resource} listing for board {board_id!r} did not return JSON",
                        ) from exc
                    items = payload.get("items") if isinstance(payload, dict) else None
                    if not isinstance(items, list):
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"The {resource} listing for board {board_id!r} "
                                "returned an unexpected shape"
                            ),
                        )
                    total = payload.get("total")
                    if declared_total is None and isinstance(total, int) and total >= 0:
                        declared_total = total
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        name = item.get(name_key)
                        if isinstance(name, str):
                            seen_names.add(name)
                        relpath = _media_relpath(
                            name, item.get(subfolder_key, ""), resource
                        )
                        if relpath is not None:
                            relpaths.append(relpath)
                    # A short page is the last page.
                    if len(items) < _DTO_PAGE_SIZE:
                        break
                    offset += len(items)
                    # Paging past what the server said it holds means it is
                    # not honouring ``offset`` (a caching or query-stripping
                    # proxy will re-serve page one forever).  Stop and let the
                    # completeness check below report it, rather than grinding
                    # through the whole page budget.
                    if declared_total is not None and offset >= declared_total + _DTO_PAGE_SIZE:
                        break
                else:
                    logger.warning(
                        "Stopped paging %s on board %r after %d pages.",
                        resource,
                        board_id,
                        _MAX_DTO_PAGES,
                    )
                return _BoardWalk(relpaths, seen_names, declared_total)

            for board_id in board_ids:
                walk = await _walk(board_id)
                if walk is None:
                    return BoardMediaPaths(list(dict.fromkeys(all_relpaths)), False)
                if _incomplete(walk):
                    logger.warning(
                        "InvokeAI listed %d of %d %s for board %r; the board "
                        "changed mid-listing. Re-reading it.",
                        len(walk.seen_names),
                        walk.declared_total,
                        resource,
                        board_id,
                    )
                    retry = await _walk(board_id)
                    if retry is None:
                        return BoardMediaPaths(list(dict.fromkeys(all_relpaths)), False)
                    if _incomplete(retry):
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                f"InvokeAI listed only {len(retry.seen_names)} of "
                                f"{retry.declared_total} {resource} on board "
                                f"{board_id!r}, twice in a row. Indexing was "
                                f"stopped rather than treat the missing entries "
                                f"as deleted; try again once the board is idle."
                            ),
                        )
                    walk = retry
                all_relpaths.extend(walk.relpaths)
    except httpx.RequestError as exc:
        logger.warning("InvokeAI %s listing request failed: %s", resource, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    # A file belongs to one board, but overlapping selections (a board plus
    # "none") must not index the same file twice — dedupe preserving order.
    return BoardMediaPaths(list(dict.fromkeys(all_relpaths)), True)


async def fetch_board_image_relpaths(
    base_url: str,
    board_ids: list[str],
    username: str | None,
    password: str | None,
) -> list[str]:
    """Return the board images' paths relative to ``outputs/images``.

    The special board id ``"none"`` is InvokeAI's Uncategorized bucket.
    Names include their file extension (``{uuid}.png`` style) and are
    prefixed by the subfolder InvokeAI filed them under, if any.  Raises 502
    on any network error or non-200 response — unlike videos, there is no
    InvokeAI old enough to lack an image listing, so a failure here is a
    real failure.
    """
    media = await _fetch_board_media_relpaths(
        base_url,
        board_ids,
        username,
        password,
        resource="images",
        name_key="image_name",
        subfolder_key="image_subfolder",
        tolerate_absent_router=False,
    )
    return media.relpaths


async def fetch_board_video_relpaths(
    base_url: str,
    board_ids: list[str],
    username: str | None,
    password: str | None,
) -> BoardMediaPaths:
    """Return the board videos' paths relative to ``outputs/videos``.

    Videos are a separate resource from images in InvokeAI, with their own
    router and their own outputs directory, so they are listed separately.
    A backend predating video support answers 404 and is reported as
    ``api_available=False`` rather than as an empty board — see
    :func:`_fetch_board_media_relpaths`.
    """
    return await _fetch_board_media_relpaths(
        base_url,
        board_ids,
        username,
        password,
        resource="videos",
        name_key="video_name",
        subfolder_key="video_subfolder",
        tolerate_absent_router=True,
    )


async def delete_image(
    base_url: str,
    image_name: str,
    username: str | None,
    password: str | None,
) -> None:
    """Delete ``image_name`` on the InvokeAI backend.

    A 404 means InvokeAI no longer knows the image — log and return so the
    caller can still drop it from the local index.  Any other failure
    raises 502.
    """
    url = f"{base_url.rstrip('/')}/api/v1/images/i/{image_name}"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.delete(url, headers=headers)

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI image delete request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code == 404:
        logger.warning(
            "InvokeAI no longer has image %s; removing from index anyway",
            image_name,
        )
        return
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI image delete returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )


async def delete_video(
    base_url: str,
    video_name: str,
    username: str | None,
    password: str | None,
) -> None:
    """Delete ``video_name`` on the InvokeAI backend.

    The video counterpart of :func:`delete_image`, and a separate call rather
    than a different path handed to that one: videos live behind their own
    router and answer with a ``DeleteVideosResult`` body instead of the
    images route's ``DeleteImagesResult``.

    Today's single-video route reports failure as a 500 and always sends an
    empty ``failed_videos``; a populated one comes from the batch
    ``POST /videos/delete``.  The list is still checked, because it is the
    one way this endpoint can report a failure *with* HTTP 200, and taking
    that for success would drop the row from the local index while the file
    stayed in InvokeAI — the video would silently reappear on the next
    re-index.

    As with images, a 404 means InvokeAI no longer knows the video: log and
    return so the caller can still drop it locally.
    """
    url = f"{base_url.rstrip('/')}/api/v1/videos/i/{video_name}"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:

            async def _do(headers: dict[str, str]) -> httpx.Response:
                return await client.delete(url, headers=headers)

            response = await _request_with_auth_fallback(
                base_url, username, password, _do
            )
    except httpx.RequestError as exc:
        logger.warning("InvokeAI video delete request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach InvokeAI backend at {base_url}: {exc}",
        ) from exc

    if response.status_code == 404:
        logger.warning(
            "InvokeAI no longer has video %s; removing from index anyway",
            video_name,
        )
        return
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                f"InvokeAI video delete returned {response.status_code}: "
                f"{response.text[:200]}"
            ),
        )

    try:
        payload = response.json()
    except ValueError:
        payload = None
    # Guarded on the shape, not just on the parse: a proxy (or a future
    # response model) can answer 200 with a JSON array or string, and
    # ``.get`` on one of those would escape as an AttributeError *after*
    # InvokeAI had already deleted the video — leaving the row in the local
    # index pointing at a file that is gone.
    failed = payload.get("failed_videos") if isinstance(payload, dict) else None
    if isinstance(failed, list) and video_name in failed:
        raise HTTPException(
            status_code=502,
            detail=f"InvokeAI reported that {video_name} could not be deleted",
        )
