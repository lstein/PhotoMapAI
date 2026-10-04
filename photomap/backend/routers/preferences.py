"""REST surface for per-device UI preferences.

A long-lived ``HttpOnly`` cookie holds an opaque device id. iOS WebKit does
*not* reliably keep it: it is routinely deleted along with localStorage after
the browser has been closed for a while. So a request that arrives without
the cookie is matched back to its device by client IP + User-Agent (see
``resolve_device_id``) before a fresh id is minted.
"""
import logging
import re
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import ValidationError

from ..preferences import UserPreferences, get_preferences_manager

logger = logging.getLogger(__name__)

DEVICE_COOKIE = "photomap_device"
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year


def _fingerprint(request: Request) -> tuple[str, str]:
    return (request.client.host if request.client else "", request.headers.get("user-agent", ""))


def resolve_device_id(request: Request) -> str:
    """Return the requesting device's id: cookie, then fingerprint, then new.

    The fingerprint is ``request.client.host`` plus the User-Agent header.
    Behind a reverse proxy the host is the proxy's address unless uvicorn's
    proxy-header support is enabled, in which case every cookieless client
    of that proxy with the same browser build shares one record.
    """
    manager = get_preferences_manager()
    ip, user_agent = _fingerprint(request)

    cookie = request.cookies.get(DEVICE_COOKIE)
    if cookie and _ID_RE.match(cookie):
        device_id = cookie
    else:
        device_id = manager.find_device(ip, user_agent)
        if device_id:
            logger.info(f"Re-linked a request without a device cookie to device {device_id[:8]} ({ip})")
        else:
            device_id = uuid4().hex
    manager.record_client(device_id, ip, user_agent)
    return device_id


def set_device_cookie(response: Response, device_id: str) -> None:
    """(Re)issue the device cookie, renewing its Max-Age.

    Sent on every response, not just when minted, so the expiry slides
    forward with use and a re-linked device gets its cookie back.
    ``HttpOnly`` because the frontend never needs to read it.
    """
    response.set_cookie(
        key=DEVICE_COOKIE,
        value=device_id,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        # Intentionally no ``secure=True``: local-first deployments are
        # almost always plain HTTP on the LAN, and a hard-coded Secure
        # would silently drop the cookie. Add it via a reverse proxy or a
        # future setting if the deployment is HTTPS-only.
    )


def get_device_id(
    request: Request,
    response: Response,
    # Declared only so the cookie shows up in the OpenAPI schema;
    # resolve_device_id reads it from the request.
    photomap_device: Annotated[str | None, Cookie(alias=DEVICE_COOKIE)] = None,
) -> str:
    """Dependency form of ``resolve_device_id`` for JSON endpoints."""
    device_id = resolve_device_id(request)
    set_device_cookie(response, device_id)
    return device_id


DeviceIdDep = Annotated[str, Depends(get_device_id)]


preferences_router = APIRouter(prefix="/preferences", tags=["Preferences"])


@preferences_router.get(
    "/", response_model=UserPreferences, response_model_by_alias=True
)
async def read_preferences(device_id: DeviceIdDep) -> UserPreferences:
    """Return this device's preferences (defaults if never set)."""
    return get_preferences_manager().get(device_id)


@preferences_router.patch(
    "/", response_model=UserPreferences, response_model_by_alias=True
)
async def patch_preferences(
    request: Request,
    device_id: DeviceIdDep,
    patch: dict,
) -> UserPreferences:
    """Merge the posted subset into stored prefs and return the full record.

    The body is a raw dict rather than ``UserPreferences`` because PATCH
    semantics require every field to be optional, and Pydantic can't express
    "all-optional view of a model" without doubling the schema. Validation
    happens inside ``PreferencesManager.patch`` over the merged record.
    """
    manager = get_preferences_manager()
    try:
        prefs = manager.patch(device_id, patch)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors()) from e
    # The dependency could not fingerprint a device whose first PATCH this is.
    manager.record_client(device_id, *_fingerprint(request))
    return prefs


@preferences_router.put(
    "/", response_model=UserPreferences, response_model_by_alias=True
)
async def replace_preferences(
    request: Request,
    device_id: DeviceIdDep,
    prefs: UserPreferences,
) -> UserPreferences:
    """Replace this device's preferences with ``prefs`` in full."""
    manager = get_preferences_manager()
    result = manager.replace(device_id, prefs)
    manager.record_client(device_id, *_fingerprint(request))
    return result


@preferences_router.delete("/", status_code=204)
async def forget_preferences(device_id: DeviceIdDep, response: Response) -> None:
    """Wipe this device's stored prefs and clear the device cookie.

    Intended for a Settings → "Forget this device" affordance, and useful
    in tests that need to start from a clean cookie.
    """
    get_preferences_manager().forget(device_id)
    response.delete_cookie(DEVICE_COOKIE)
