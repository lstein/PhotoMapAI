"""
test_app.py
Tests for the main entry point of the Clipslide application.
"""
import os
import pytest
from fixtures import client

def test_temp_config_file():
    assert os.path.exists(os.environ["PHOTOMAP_CONFIG"])

def test_root_route(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    assert response.template.name == "main.html"
    assert "<title id=\"slideshow_title\">PhotoMap</title>" in response.text

