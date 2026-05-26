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
    # Curator defaults mirror the HTML input values in curation.html.
    assert body["curationTargetCount"] == 80
    assert body["curationIterations"] == 20
    assert body["curationMethod"] == "fps"
    assert body["curationExcludeThreshold"] == 90
    assert body["curationExportPath"] is None


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


def test_curation_fields_round_trip(client: TestClient):
    """All five Dataset Curator fields persist and come back unchanged."""
    client.get("/preferences/")
    response = client.patch(
        "/preferences/",
        json={
            "curationTargetCount": 250,
            "curationIterations": 15,
            "curationMethod": "kmeans",
            "curationExcludeThreshold": 75,
            "curationExportPath": "/tmp/curated",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["curationTargetCount"] == 250
    assert body["curationIterations"] == 15
    assert body["curationMethod"] == "kmeans"
    assert body["curationExcludeThreshold"] == 75
    assert body["curationExportPath"] == "/tmp/curated"

    fetched = client.get("/preferences/").json()
    assert fetched["curationTargetCount"] == 250
    assert fetched["curationMethod"] == "kmeans"
    assert fetched["curationExportPath"] == "/tmp/curated"


def test_curation_invalid_values_return_422(client: TestClient):
    client.get("/preferences/")
    # target count must be 10..1000
    assert client.patch("/preferences/", json={"curationTargetCount": 5}).status_code == 422
    assert client.patch("/preferences/", json={"curationTargetCount": 2000}).status_code == 422
    # iterations must be 1..30
    assert client.patch("/preferences/", json={"curationIterations": 0}).status_code == 422
    assert client.patch("/preferences/", json={"curationIterations": 50}).status_code == 422
    # threshold must be 1..100
    assert client.patch("/preferences/", json={"curationExcludeThreshold": 0}).status_code == 422
    assert client.patch("/preferences/", json={"curationExcludeThreshold": 200}).status_code == 422
    # method is a Literal
    assert client.patch("/preferences/", json={"curationMethod": "magic"}).status_code == 422


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
