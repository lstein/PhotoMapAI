"""Tests for the server-side per-device user-preferences API."""
import pytest
from fastapi.testclient import TestClient

from photomap.backend.preferences import get_preferences_manager
from photomap.backend.routers.preferences import DEVICE_COOKIE


@pytest.fixture(autouse=True)
def _isolate_preferences():
    """Clean preferences state between tests.

    The PreferencesManager is an ``lru_cache``'d singleton that points at a
    file under the session-scoped config dir. Without this fixture, every
    test inherits the previous test's devices on disk and in memory.
    """
    mgr = get_preferences_manager()
    if mgr.path.exists():
        mgr.path.unlink()
    mgr.reload()
    yield
    if mgr.path.exists():
        mgr.path.unlink()
    mgr.reload()


def _device_cookie(response) -> str | None:
    """Pull the device id out of a Set-Cookie header, if present."""
    return response.cookies.get(DEVICE_COOKIE)


def test_get_without_cookie_mints_one_and_returns_defaults(client: TestClient):
    response = client.get("/preferences/")
    assert response.status_code == 200

    # A fresh cookie should have been set.
    cookie = _device_cookie(response)
    assert cookie is not None and len(cookie) == 32

    body = response.json()
    # Defaults match the in-memory defaults declared in state.js.
    assert body["currentDelay"] == 5
    assert body["mode"] == "chronological"
    assert body["moveToTrash"] is True
    assert body["autotaggingEnabled"] is False
    assert body["updatedAt"] == 0.0
    assert body["album"] is None


def test_patch_then_get_returns_merged(client: TestClient):
    # Establish a session so the cookie sticks.
    client.get("/preferences/")

    patched = client.patch(
        "/preferences/", json={"currentDelay": 12, "mode": "random"}
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["currentDelay"] == 12
    assert body["mode"] == "random"
    # Untouched fields keep their defaults.
    assert body["moveToTrash"] is True
    assert body["updatedAt"] > 0.0

    fetched = client.get("/preferences/").json()
    assert fetched["currentDelay"] == 12
    assert fetched["mode"] == "random"


def test_patch_accepts_snake_case_too(client: TestClient):
    client.get("/preferences/")
    response = client.patch(
        "/preferences/", json={"current_delay": 7, "grid_thumb_size_factor": 1.5}
    )
    assert response.status_code == 200
    body = response.json()
    # Server normalizes to camelCase on the wire regardless of input casing.
    assert body["currentDelay"] == 7
    assert body["gridThumbSizeFactor"] == 1.5


def test_patch_drops_unknown_fields(client: TestClient):
    client.get("/preferences/")
    response = client.patch(
        "/preferences/",
        json={"currentDelay": 9, "totallyMadeUp": "ignored"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["currentDelay"] == 9
    assert "totallyMadeUp" not in body


def test_patch_invalid_value_returns_422(client: TestClient):
    client.get("/preferences/")
    # currentDelay has ge=1
    response = client.patch("/preferences/", json={"currentDelay": 0})
    assert response.status_code == 422

    # Literal field
    response = client.patch("/preferences/", json={"mode": "shuffle"})
    assert response.status_code == 422


def test_two_clients_are_isolated():
    """Each TestClient session gets a separate cookie, so prefs don't leak."""
    from photomap.backend.photomap_server import app

    alice = TestClient(app)
    bob = TestClient(app)

    alice.patch("/preferences/", json={"currentDelay": 30})
    bob.patch("/preferences/", json={"currentDelay": 60})

    assert alice.get("/preferences/").json()["currentDelay"] == 30
    assert bob.get("/preferences/").json()["currentDelay"] == 60


def test_put_replaces_full_record(client: TestClient):
    client.get("/preferences/")
    # First, set a non-default value via PATCH.
    client.patch("/preferences/", json={"currentDelay": 42})

    # PUT a fresh full record — currentDelay should revert because PUT
    # replaces rather than merges.
    response = client.put(
        "/preferences/",
        json={
            "mode": "random",
            "moveToTrash": False,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "random"
    assert body["moveToTrash"] is False
    # currentDelay returns to the default, not the patched value.
    assert body["currentDelay"] == 5


def test_delete_clears_state_and_cookie(client: TestClient):
    client.get("/preferences/")
    client.patch("/preferences/", json={"currentDelay": 25})
    cookie_before = client.cookies.get(DEVICE_COOKIE)
    assert cookie_before is not None

    response = client.delete("/preferences/")
    assert response.status_code == 204

    # On the next request, the cookie has been cleared client-side, so the
    # TestClient mints a brand-new device id and gets defaults.
    fresh = client.get("/preferences/").json()
    assert fresh["currentDelay"] == 5


def test_existing_cookie_is_honored():
    """A client that already has a device cookie keeps using it."""
    from photomap.backend.photomap_server import app

    client = TestClient(app)
    fixed_id = "a" * 32
    client.cookies.set(DEVICE_COOKIE, fixed_id)

    # No new cookie should be issued — the existing one validates.
    response = client.patch("/preferences/", json={"currentDelay": 17})
    assert response.status_code == 200
    # response.cookies only contains *new* Set-Cookie headers; should be empty.
    assert response.cookies.get(DEVICE_COOKIE) is None

    # And the stored prefs land under the supplied id.
    stored = get_preferences_manager().get(fixed_id)
    assert stored.current_delay == 17


def test_malformed_cookie_is_replaced():
    """A cookie that doesn't match the 32-hex-char shape gets rotated."""
    from photomap.backend.photomap_server import app

    client = TestClient(app)
    client.cookies.set(DEVICE_COOKIE, "not-a-uuid")

    response = client.get("/preferences/")
    assert response.status_code == 200
    new_cookie = _device_cookie(response)
    assert new_cookie is not None and len(new_cookie) == 32
    assert new_cookie != "not-a-uuid"
