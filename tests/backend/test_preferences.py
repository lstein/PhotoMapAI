"""Tests for the server-side per-device user-preferences API."""
import pytest
from fastapi.testclient import TestClient

from photomap.backend.preferences import UserPreferences, get_preferences_manager
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
    """Each TestClient session gets a separate cookie, so prefs don't leak.

    Distinct User-Agents, because two cookieless clients with the same IP and
    User-Agent are deliberately treated as one device (see the re-link tests).
    """
    from photomap.backend.photomap_server import app

    alice = TestClient(app, headers={"User-Agent": "alice-browser"})
    bob = TestClient(app, headers={"User-Agent": "bob-browser"})

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

    # The existing id validates; the cookie is re-sent with that same id so
    # its Max-Age keeps sliding forward.
    response = client.patch("/preferences/", json={"currentDelay": 17})
    assert response.status_code == 200
    assert response.cookies.get(DEVICE_COOKIE) == fixed_id

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


def test_media_filter_round_trips(client: TestClient):
    """The images/videos filter persists like any other preference.

    It was missing from ``UserPreferences`` while being listed in state.js's
    PERSISTED_SETTINGS, so ``extra="ignore"`` dropped it from every PATCH.
    """
    client.get("/preferences/")
    response = client.patch("/preferences/", json={"mediaFilter": "videos"})
    assert response.status_code == 200
    assert response.json()["mediaFilter"] == "videos"

    assert client.get("/preferences/").json()["mediaFilter"] == "videos"


def test_media_filter_starts_null_and_rejects_junk(client: TestClient):
    """Null, not "both", until the device has actually sent one.

    A concrete default would be indistinguishable from a deliberate choice,
    and a server-authoritative reconcile would apply it over the value the
    device already had in localStorage.
    """
    client.get("/preferences/")
    assert client.get("/preferences/").json()["mediaFilter"] is None

    response = client.patch("/preferences/", json={"mediaFilter": "gifs"})
    assert response.status_code == 422


def test_model_covers_every_persisted_frontend_setting():
    """Every key in state.js's PERSISTED_SETTINGS has a field here.

    The two lists are hand-kept mirrors, and a field missing from this model
    is silent: ``extra="ignore"`` drops it from the PATCH body, so the setting
    never survives a localStorage eviction and reconciliation re-PATCHes it on
    every boot. Parsing state.js is ugly, but it is the only thing that
    actually fails when the mirror drifts.
    """
    import re
    from pathlib import Path

    from photomap.backend.constants import get_package_resource_path

    state_js = (
        Path(get_package_resource_path("static")) / "javascript" / "state.js"
    ).read_text()
    registry = state_js.split("const PERSISTED_SETTINGS = [", 1)[1].split("\n];", 1)[0]
    keys = re.findall(r'key:\s*"([A-Za-z0-9_]+)"', registry)
    assert len(keys) > 10, "PERSISTED_SETTINGS parse looks wrong"

    snake = [re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower() for key in keys]
    missing = [key for key in snake if key not in UserPreferences.model_fields]
    assert not missing, f"UserPreferences is missing persisted settings: {missing}"


# --- Re-linking a request that lost its cookie -----------------------------
#
# iOS WebKit deletes the device cookie together with localStorage after the
# browser has been closed for a while. Without re-linking, every such
# request was handed a new device id and a record full of defaults.


def _client(user_agent: str = "test-browser") -> TestClient:
    from photomap.backend.photomap_server import app

    return TestClient(app, headers={"User-Agent": user_agent})


def test_cookieless_request_relinks_by_ip_and_user_agent():
    first = _client()
    first.patch("/preferences/", json={"currentDelay": 3, "autotaggingEnabled": True})
    original_id = first.cookies.get(DEVICE_COOKIE)

    # Same browser, cookie gone.
    returning = _client()
    response = returning.get("/preferences/")
    assert response.json()["currentDelay"] == 3
    assert response.json()["autotaggingEnabled"] is True
    # The original id is handed back, so later requests carry it again.
    assert _device_cookie(response) == original_id


def test_different_user_agent_is_not_relinked():
    _client("ipad-safari").patch("/preferences/", json={"currentDelay": 3})

    response = _client("desktop-firefox").get("/preferences/")
    assert response.json()["currentDelay"] == 5
    assert response.json()["updatedAt"] == 0.0


def test_recordless_device_is_not_fingerprinted():
    """A visit that never saved anything leaves nothing to re-link to."""
    _client().get("/preferences/")
    assert get_preferences_manager()._load().clients == {}


def test_fingerprint_belongs_to_the_device_that_last_used_it():
    """Two records with one fingerprint: re-link picks the latest user."""
    older = _client()
    older.cookies.set(DEVICE_COOKIE, "a" * 32)
    older.patch("/preferences/", json={"currentDelay": 10})

    newer = _client()
    newer.cookies.set(DEVICE_COOKIE, "b" * 32)
    newer.patch("/preferences/", json={"currentDelay": 20})

    assert _client().get("/preferences/").json()["currentDelay"] == 20

    # The older device using it again takes it back.
    older.get("/preferences/")
    assert _client().get("/preferences/").json()["currentDelay"] == 10


def test_forgotten_device_is_not_relinked():
    """Reset-to-defaults must not resurrect the record it just deleted."""
    older = _client()
    older.cookies.set(DEVICE_COOKIE, "a" * 32)
    older.patch("/preferences/", json={"currentDelay": 10})

    current = _client()
    current.cookies.set(DEVICE_COOKIE, "b" * 32)
    current.patch("/preferences/", json={"currentDelay": 20})
    current.delete("/preferences/")

    # Neither the forgotten record nor the older one that had shared its
    # fingerprint comes back.
    fresh = _client().get("/preferences/").json()
    assert fresh["currentDelay"] == 5
    assert fresh["updatedAt"] == 0.0


def test_fingerprints_persist_across_restarts():
    first = _client()
    first.patch("/preferences/", json={"currentDelay": 3})

    get_preferences_manager().reload()  # as if the server restarted
    assert _client().get("/preferences/").json()["currentDelay"] == 3


def test_store_without_clients_section_still_loads():
    """Files written before fingerprints existed load unchanged."""
    import json

    mgr = get_preferences_manager()
    mgr.path.parent.mkdir(parents=True, exist_ok=True)
    mgr.path.write_text(json.dumps({"version": 1, "devices": {"a" * 32: {"current_delay": 8}}}))
    mgr.reload()

    client = _client()
    client.cookies.set(DEVICE_COOKIE, "a" * 32)
    assert client.get("/preferences/").json()["currentDelay"] == 8


def test_visual_session_state_round_trips(client: TestClient):
    response = client.patch(
        "/preferences/",
        json={"umapWindowOpen": False, "gridViewActive": True, "lastSlideIndex": {"album1": 200}},
    )
    assert response.status_code == 200
    body = client.get("/preferences/").json()
    assert body["umapWindowOpen"] is False
    assert body["gridViewActive"] is True
    assert body["lastSlideIndex"] == {"album1": 200}


def test_last_slide_index_rejects_negative(client: TestClient):
    response = client.patch("/preferences/", json={"lastSlideIndex": {"album1": -1}})
    assert response.status_code == 422


# --- The page carries the preferences ---------------------------------------


def _embedded_preferences(html: str):
    import json
    import re

    match = re.search(r"window\.initialPreferences = (.*?);\n", html)
    assert match, "initialPreferences not embedded in the page"
    return json.loads(match.group(1))


def test_root_page_embeds_null_for_a_new_device():
    response = _client().get("/")
    assert response.status_code == 200
    assert _embedded_preferences(response.text) is None
    assert _device_cookie(response) is not None
    assert response.headers["cache-control"] == "no-cache"


def test_root_page_embeds_stored_preferences_and_relinks():
    first = _client()
    first.patch("/preferences/", json={"currentDelay": 3, "showControlPanelText": False})
    original_id = first.cookies.get(DEVICE_COOKIE)

    # The page load is the first request after iOS dropped the cookie.
    response = _client().get("/")
    prefs = _embedded_preferences(response.text)
    assert prefs["currentDelay"] == 3
    assert prefs["showControlPanelText"] is False
    assert _device_cookie(response) == original_id
