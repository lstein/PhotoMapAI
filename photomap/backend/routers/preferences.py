"""REST surface for per-device UI preferences.

A long-lived ``HttpOnly`` cookie holds an opaque device id; the same device
keeps the same preferences across browser-storage purges (which is the whole
point — iOS WebKit evicts localStorage but keeps first-party cookies under
Max-Age much more reliably).
"""
import logging
import re
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import ValidationError

from ..preferences import UserPreferences, get_preferences_manager

logger = logging.getLogger(__name__)

DEVICE_COOKIE = "photomap_device"
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # 1 year


def get_device_id(
    response: Response,
    photomap_device: Annotated[str | None, Cookie(alias=DEVICE_COOKIE)] = None,
) -> str:
    """Read the device cookie or mint a fresh one.

    The cookie is set on *every* response when missing so the very first
    request also persists client-side, regardless of which endpoint the
    frontend hits first. ``HttpOnly`` because the frontend never needs to
    read the cookie directly — the browser ships it on every same-origin
    request automatically.
    """
    if photomap_device and _ID_RE.match(photomap_device):
        return photomap_device
    new_id = uuid4().hex
    response.set_cookie(
        key=DEVICE_COOKIE,
        value=new_id,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        # Intentionally no ``secure=True``: local-first deployments are
        # almost always plain HTTP on the LAN, and a hard-coded Secure
        # would silently drop the cookie. Add it via a reverse proxy or a
        # future setting if the deployment is HTTPS-only.
    )
    return new_id


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
    device_id: DeviceIdDep,
    patch: dict,
) -> UserPreferences:
    """Merge the posted subset into stored prefs and return the full record.

    The body is a raw dict rather than ``UserPreferences`` because PATCH
    semantics require every field to be optional, and Pydantic can't express
    "all-optional view of a model" without doubling the schema. Validation
    happens inside ``PreferencesManager.patch`` over the merged record.
    """
    try:
        return get_preferences_manager().patch(device_id, patch)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors()) from e


@preferences_router.put(
    "/", response_model=UserPreferences, response_model_by_alias=True
)
async def replace_preferences(
    device_id: DeviceIdDep,
    prefs: UserPreferences,
) -> UserPreferences:
    """Replace this device's preferences with ``prefs`` in full."""
    return get_preferences_manager().replace(device_id, prefs)


@preferences_router.delete("/", status_code=204)
async def forget_preferences(device_id: DeviceIdDep, response: Response) -> None:
    """Wipe this device's stored prefs and clear the device cookie.

    Intended for a Settings → "Forget this device" affordance, and useful
    in tests that need to start from a clean cookie.
    """
    get_preferences_manager().forget(device_id)
    response.delete_cookie(DEVICE_COOKIE)
