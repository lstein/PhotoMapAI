"""Tests for cache-busting of the no-build frontend assets."""
import asyncio
import re

from photomap.backend.constants import get_package_resource_path
from photomap.backend.static_assets import VersionedStaticFiles, compute_asset_version


def test_compute_asset_version_is_stable_for_unchanged_content(tmp_path):
    (tmp_path / "app.js").write_text("console.log('hi');")
    (tmp_path / "style.css").write_text("body { color: red; }")

    first = compute_asset_version(tmp_path, "1.2.3")
    second = compute_asset_version(tmp_path, "1.2.3")

    assert first == second
    assert first.startswith("v1.2.3.")


def test_compute_asset_version_changes_when_content_changes(tmp_path):
    js = tmp_path / "app.js"
    js.write_text("console.log('hi');")
    before = compute_asset_version(tmp_path, "1.2.3")

    js.write_text("console.log('changed');")
    after = compute_asset_version(tmp_path, "1.2.3")

    assert before != after


def test_compute_asset_version_changes_with_app_version(tmp_path):
    (tmp_path / "app.js").write_text("console.log('hi');")

    assert compute_asset_version(tmp_path, "1.2.3") != compute_asset_version(tmp_path, "1.2.4")


def test_compute_asset_version_ignores_binary_assets(tmp_path):
    """Non-text assets (icons) don't perturb the fingerprint."""
    (tmp_path / "app.js").write_text("console.log('hi');")
    before = compute_asset_version(tmp_path, "1.2.3")

    (tmp_path / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\n_fake_image_data")
    after = compute_asset_version(tmp_path, "1.2.3")

    assert before == after


def _asset_version_from_home(client) -> str:
    """Pull the live asset-version token out of the rendered main page."""
    body = client.get("/").text
    match = re.search(r"static/(v[^/\"']+)/main\.js", body)
    assert match, "main page should reference a version-stamped main.js"
    return match.group(1)


def test_home_page_references_versioned_assets(client):
    body = client.get("/").text
    # The cache-busting prefix is present...
    assert re.search(r"static/v[^/\"']+/css/base\.css", body)
    # ...and the old unversioned reference is gone.
    assert 'href="static/css/base.css"' not in body


def test_versioned_asset_is_served_and_marked_immutable(client):
    version = _asset_version_from_home(client)

    resp = client.get(f"/static/{version}/main.js")
    assert resp.status_code == 200
    # Confirm the real module was served. The content-type for .js varies by OS
    # / registry (notably on Windows), so assert on the body, not the MIME type.
    assert "import" in resp.text
    assert "immutable" in resp.headers.get("cache-control", "")

    # A nested module import resolves under the same version segment.
    resp_css = client.get(f"/static/{version}/css/base.css")
    assert resp_css.status_code == 200
    assert "immutable" in resp_css.headers.get("cache-control", "")


def test_unversioned_asset_still_served_without_immutable_cache(client):
    # The hardcoded unsupported-browser fallback relies on the plain path.
    resp = client.get("/static/css/base.css")
    assert resp.status_code == 200
    assert "immutable" not in resp.headers.get("cache-control", "")


def test_wrong_version_segment_is_not_served(client):
    # A stale/foreign version segment must not resolve to a real file.
    resp = client.get("/static/vDOESNOTMATCH.0000000000/main.js")
    assert resp.status_code == 404


def test_os_specific_separator_in_path_is_handled(client):
    """StaticFiles.get_path hands get_response an OS-specific path: backslashes
    on Windows. The version prefix must still be recognised, or every versioned
    asset 404s on Windows. Reproduce that path shape directly so the regression
    is caught on any platform."""
    version = _asset_version_from_home(client)
    static_dir = get_package_resource_path("static")
    handler = VersionedStaticFiles(directory=static_dir, version=version)
    scope = {"type": "http", "method": "GET", "headers": []}

    # Backslash separator, as os.path.normpath would produce on Windows.
    response = asyncio.run(handler.get_response(f"{version}\\main.js", scope))

    assert response.status_code == 200
    assert "immutable" in response.headers.get("cache-control", "")
