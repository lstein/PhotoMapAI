"""
test_browser.py
Tests for the auto-open-browser guard logic in photomap.backend.browser.

These cover should_open_browser()'s suppression rules; the actual
open_browser_when_ready() thread is not exercised (it would pop a real browser).
"""

import pytest

from photomap.backend import browser


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Default to a non-headless, non-Docker, no-env-override environment."""
    monkeypatch.delenv("PHOTOMAP_NO_BROWSER", raising=False)
    monkeypatch.setattr(browser, "_is_docker", lambda: False)
    monkeypatch.setattr(browser, "_is_headless", lambda: False)


def test_opens_for_loopback_by_default():
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=False) is True
    assert browser.should_open_browser("localhost", no_browser=False, reload=False) is True


def test_suppressed_by_no_browser_flag():
    assert browser.should_open_browser("127.0.0.1", no_browser=True, reload=False) is False


def test_suppressed_under_reload():
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=True) is False


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.50", "example.com"])
def test_suppressed_for_non_loopback_hosts(host):
    assert browser.should_open_browser(host, no_browser=False, reload=False) is False


def test_suppressed_in_docker(monkeypatch):
    monkeypatch.setattr(browser, "_is_docker", lambda: True)
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=False) is False


def test_suppressed_when_headless(monkeypatch):
    monkeypatch.setattr(browser, "_is_headless", lambda: True)
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=False) is False


@pytest.mark.parametrize("value", ["1", "true", "yes", "on", "anything"])
def test_env_var_suppresses(monkeypatch, value):
    monkeypatch.setenv("PHOTOMAP_NO_BROWSER", value)
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=False) is False


@pytest.mark.parametrize("value", ["0", "false", "no", "off", ""])
def test_falsey_env_var_does_not_suppress(monkeypatch, value):
    monkeypatch.setenv("PHOTOMAP_NO_BROWSER", value)
    assert browser.should_open_browser("127.0.0.1", no_browser=False, reload=False) is True
