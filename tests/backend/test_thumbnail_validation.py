"""Input validation for the ``/thumbnails/{album}/{index}`` endpoint.

The ``color`` query parameter is interpolated into the on-disk thumbnail
cache filename, so unsanitised values like ``../../evil`` would have
escaped the cache directory and caused arbitrary-location writes.  These
tests lock down the whitelist.
"""

from __future__ import annotations

import pytest
from fixtures import build_index


@pytest.fixture
def indexed_album(client, new_album, monkeypatch):
    build_index(client, new_album, monkeypatch)
    return new_album


@pytest.mark.parametrize(
    "bad_color",
    [
        "../../evil",
        "#../foo",
        "red",  # not hex / rgb triple
        "#xyz",
        "#abc",  # short-form hex — not supported by our 6-digit parser
        "256,256,256" + "," * 20,
        "#1234567",  # wrong length
        "1,2",  # too few components
    ],
)
def test_thumbnail_rejects_unsafe_color(client, indexed_album, bad_color):
    response = client.get(
        f"/thumbnails/{indexed_album['key']}/0",
        params={"color": bad_color},
    )
    assert response.status_code == 400, response.text


@pytest.mark.parametrize(
    "good_color",
    ["#ff00aa", "ff00aa", "255,128,0"],
)
def test_thumbnail_accepts_valid_color(client, indexed_album, good_color):
    response = client.get(
        f"/thumbnails/{indexed_album['key']}/0",
        params={"color": good_color},
    )
    assert response.status_code == 200


@pytest.mark.parametrize("bad_size", [0, -1, 10_000, 99_999])
def test_thumbnail_rejects_out_of_range_size(client, indexed_album, bad_size):
    response = client.get(
        f"/thumbnails/{indexed_album['key']}/0",
        params={"size": bad_size},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("bad_radius", [-1, 10_000])
def test_thumbnail_rejects_out_of_range_radius(client, indexed_album, bad_radius):
    response = client.get(
        f"/thumbnails/{indexed_album['key']}/0",
        params={"radius": bad_radius},
    )
    assert response.status_code == 400
