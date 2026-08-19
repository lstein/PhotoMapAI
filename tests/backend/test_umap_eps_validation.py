"""A Cluster Strength DBSCAN cannot run with must never reach the config.

Both halves are reachable only through the API — the spinner cannot produce
them — but both persisted to YAML and left the album's semantic map broken
until someone edited the file by hand:

* a non-positive eps makes ``DBSCAN`` raise, so every ``/umap_data`` and
  ``/cluster_labels`` request 500s;
* a non-finite eps cannot be serialized back out at all, so ``/get_umap_eps``
  500s on its own response.
"""

import math

import pytest
import yaml
from fixtures import build_index

from photomap.backend.config import get_config_manager

BAD_JSON_LITERALS = ["NaN", "Infinity", "-Infinity"]
BAD_NUMBERS = [0, -5.0, -0.001]


def _post_raw_eps(client, album_key, literal):
    """POST a body containing a bare JSON literal ``json.loads`` accepts."""
    return client.post(
        "/set_umap_eps/",
        content=f'{{"album": "{album_key}", "eps": {literal}}}',
        headers={"Content-Type": "application/json"},
    )


@pytest.mark.parametrize("literal", BAD_JSON_LITERALS)
def test_a_non_finite_eps_is_refused(client, new_album, literal):
    key = new_album["key"]
    before = get_config_manager().get_album(key).umap_eps

    assert _post_raw_eps(client, key, literal).status_code == 422
    # Refused means not written, not "written and then rejected".
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(before)
    # And the endpoint that has to serialize it still works.
    assert client.post("/get_umap_eps/", json={"album": key}).status_code == 200


@pytest.mark.parametrize("eps", BAD_NUMBERS)
def test_a_non_positive_eps_is_refused(client, new_album, eps):
    key = new_album["key"]
    before = get_config_manager().get_album(key).umap_eps

    response = client.post("/set_umap_eps/", json={"album": key, "eps": eps})
    assert response.status_code == 422
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(before)


def test_a_usable_eps_is_still_stored(client, new_album):
    key = new_album["key"]
    assert client.post("/set_umap_eps/", json={"album": key, "eps": 0.42}).status_code == 200
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(0.42)


@pytest.mark.parametrize("eps", [0, -1])
def test_a_non_positive_query_parameter_is_refused(client, new_album, eps):
    """A 422 from the caller rather than a 500 out of sklearn."""
    build_index(client, new_album)
    key = new_album["key"]

    assert client.get(f"/umap_data/{key}?cluster_eps={eps}").status_code == 422
    assert client.get(f"/cluster_labels/{key}?cluster_eps={eps}").status_code == 422


def test_the_map_survives_a_config_that_already_holds_a_bad_value(client, new_album):
    """Validation stops new ones; a config written before it still has to load.

    A stored 0 used to 500 both map endpoints on every request, with no way
    back except editing the YAML.
    """
    build_index(client, new_album)
    key = new_album["key"]

    manager = get_config_manager()
    config_path = manager.config_path
    raw = yaml.safe_load(config_path.read_text())
    raw["albums"][key]["umap_eps"] = 0
    config_path.write_text(yaml.safe_dump(raw))
    manager.reload_config()

    # None is "nobody chose one", so the album gets a derived strength --
    # the same treatment as one that never had a value, and better than any
    # constant this code could pick.
    assert manager.get_album(key).umap_eps is None
    assert client.get(f"/umap_data/{key}").status_code == 200
    resolved = client.post("/get_umap_eps/", json={"album": key})
    assert resolved.status_code == 200
    assert resolved.json()["auto"] is True


def test_the_map_survives_a_config_that_already_holds_a_nan(client, new_album):
    build_index(client, new_album)
    key = new_album["key"]

    manager = get_config_manager()
    config_path = manager.config_path
    # `.nan` is what yaml.safe_dump writes for a stored NaN, so this is the
    # file such an album really ends up with.
    config_path.write_text(config_path.read_text().replace(
        f"umap_eps: {new_album['umap_eps']}", "umap_eps: .nan"
    ))
    manager.reload_config()

    stored = manager.get_album(key).umap_eps
    assert stored is None or not math.isnan(stored)
    assert client.post("/get_umap_eps/", json={"album": key}).status_code == 200


def test_null_still_clears_the_stored_value(client, new_album):
    """The constraint applies to a number, not to the deliberate clear that
    hands the album back to a derived Cluster Strength."""
    key = new_album["key"]
    assert client.post("/set_umap_eps/", json={"album": key, "eps": 0.42}).status_code == 200

    assert client.post("/set_umap_eps/", json={"album": key, "eps": None}).status_code == 200
    assert get_config_manager().get_album(key).umap_eps is None
