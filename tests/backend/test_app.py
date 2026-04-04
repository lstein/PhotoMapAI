"""
test_app.py
Tests for the main entry point of the Clipslide application.
"""
import os


def test_temp_config_file():
    assert os.path.exists(os.environ["PHOTOMAP_CONFIG"])

def test_root_route(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    assert response.template.name == "main.html"
    assert "<title id=\"slideshow_title\">PhotoMap</title>" in response.text


def test_ie_compatibility_header_on_html(client):
    """The root page must carry X-UA-Compatible: IE=edge to prevent Edge/IE
    from switching into IE Compatibility Mode, which would break Swiper v11
    and cause SCRIPT1028 / HTML1416 / HTML1500 console errors."""
    response = client.get("/")
    assert response.headers.get("x-ua-compatible") == "IE=edge"


def test_ie_compatibility_header_on_api(client):
    """The X-UA-Compatible header should also be present on API responses."""
    response = client.get("/api/albums/")
    assert response.headers.get("x-ua-compatible") == "IE=edge"


def test_legacy_edge_detection_script_present(client):
    """The root page must include an inline script that detects legacy EdgeHTML
    (Edge ≤18 / Edge 44) and redirects to the upgrade-instructions page before
    any ES2020 library code runs."""
    response = client.get("/")
    assert "window.StyleMedia" in response.text
    assert "/static/unsupported-browser.html" in response.text


def test_unsupported_browser_page_served(client):
    """The static unsupported-browser page must be served and contain the
    upgrade link so that legacy Edge users see the instructions."""
    response = client.get("/static/unsupported-browser.html")
    assert response.status_code == 200
    assert "microsoft.com/edge" in response.text

