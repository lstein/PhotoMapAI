"""A Cluster Strength the semantic map cannot use must never reach the config.

All of it is reachable only through the API — the spinner cannot produce
these — but every kind persisted to YAML and left the album's map either
broken or lying about itself until someone edited the file by hand:

* a non-positive eps makes ``DBSCAN`` raise, so every ``/umap_data`` and
  ``/cluster_labels`` request 500s;
* a non-finite eps cannot be serialized back out at all, so ``/get_umap_eps``
  500s on its own response;
* a positive eps below ``MIN_CLUSTER_EPS`` is quieter and just as wrong:
  ``resolve_cluster_eps`` floors it, so the map is clustered at one number
  while the spinner and ``/get_umap_eps`` report another.

The refusal has to hold at every door into the field — ``/set_umap_eps``,
``/add_album`` and ``/update_album`` — and the 422 it produces has to be
serializable, which for a rejected NaN is not free.
"""


import json

import pytest
import yaml
from fixtures import build_index

from photomap.backend.cluster_eps import MIN_CLUSTER_EPS
from photomap.backend.config import get_config_manager

BAD_JSON_LITERALS = ["NaN", "Infinity", "-Infinity"]
# Zero and negative are what DBSCAN itself refuses; the last two are the
# quiet half — positive, but under the floor the clustering applies anyway.
BAD_NUMBERS = [0, -5.0, -0.001, MIN_CLUSTER_EPS / 2, MIN_CLUSTER_EPS - 1e-9]


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
def test_an_unusable_eps_is_refused(client, new_album, eps):
    key = new_album["key"]
    before = get_config_manager().get_album(key).umap_eps

    response = client.post("/set_umap_eps/", json={"album": key, "eps": eps})
    assert response.status_code == 422
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(before)


@pytest.mark.parametrize("eps", [0.42, MIN_CLUSTER_EPS])
def test_a_usable_eps_is_still_stored(client, new_album, eps):
    """The floor itself is usable: the bound is ``ge``, and it is the number
    the spinner's own ``min`` lets a user ask for."""
    key = new_album["key"]
    assert client.post("/set_umap_eps/", json={"album": key, "eps": eps}).status_code == 200
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(eps)


@pytest.mark.parametrize("eps", [0, -1, 0.005])
def test_an_unusable_query_parameter_is_refused(client, new_album, eps):
    """A 422 from the caller rather than a 500 out of sklearn — or, for the
    value under the floor, rather than a map clustered at something the
    caller was never told about."""
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
    original = config_path.read_text()
    patched = original.replace(f"umap_eps: {new_album['umap_eps']}", "umap_eps: .nan")
    assert patched != original, "the fixture's stored eps was not where this test expects it"
    config_path.write_text(patched)
    manager.reload_config()

    # Nobody chose a NaN, so the album is handed back to a derived strength
    # rather than left holding a number that cannot even be serialized.
    assert manager.get_album(key).umap_eps is None
    resolved = client.post("/get_umap_eps/", json={"album": key})
    assert resolved.status_code == 200
    assert resolved.json()["auto"] is True
    assert client.get(f"/umap_data/{key}").status_code == 200


def test_a_stored_value_under_the_floor_is_raised_to_it(client, new_album):
    """Not discarded: it is a real intent, and the map already clusters there.

    Dropping it back to derived would answer "the tightest clustering you can
    ask for" with whatever the album's coordinates suggest, which can be an
    order of magnitude looser.
    """
    key = new_album["key"]
    manager = get_config_manager()
    config_path = manager.config_path
    config_path.write_text(
        config_path.read_text().replace(f"umap_eps: {new_album['umap_eps']}", "umap_eps: 0.004")
    )
    manager.reload_config()

    assert manager.get_album(key).umap_eps == pytest.approx(MIN_CLUSTER_EPS)
    resolved = client.post("/get_umap_eps/", json={"album": key})
    assert resolved.json()["eps"] == pytest.approx(MIN_CLUSTER_EPS)
    assert resolved.json()["auto"] is False


@pytest.mark.parametrize(
    "body",
    [
        # The rejected float is not always the error's `input`: pydantic
        # reports the *containing* object whenever some other field is what
        # failed, so the NaN arrives one or two levels down. Sanitizing only
        # a top-level float leaves those 500ing on the way out — the very
        # failure the handler exists to prevent.
        '{"eps": NaN}',
        '{"album": "test_album", "eps": [NaN]}',
        '{"album": {"nested": NaN}, "eps": 0.5}',
        '{"album": "test_album", "eps": {"value": -Infinity}}',
    ],
)
def test_a_nan_the_error_only_contains_is_still_serializable(client, new_album, body):
    response = client.post(
        "/set_umap_eps/", content=body, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422
    # The body has to survive being read, which is where it used to fail.
    assert "detail" in response.json()


@pytest.mark.parametrize("eps", BAD_NUMBERS)
def test_add_album_refuses_a_bad_eps(client, tmp_path, eps):
    """Every door into the field, not just /set_umap_eps."""
    images = tmp_path / "images"
    images.mkdir()
    response = client.post(
        "/add_album/",
        json={
            "key": "eps_probe",
            "name": "Eps Probe",
            "image_paths": [images.as_posix()],
            "index": (images / "embeddings.npz").as_posix(),
            "umap_eps": eps,
        },
    )
    try:
        assert response.status_code == 422
        assert get_config_manager().get_album("eps_probe") is None
    finally:
        client.delete("/delete_album/eps_probe")


@pytest.mark.parametrize("eps", BAD_NUMBERS)
def test_update_album_refuses_a_bad_eps(client, new_album, eps):
    """A 422, not a 200 that quietly drops the number the caller sent."""
    key = new_album["key"]
    before = get_config_manager().get_album(key).umap_eps

    response = client.post(
        "/update_album/",
        json={
            "key": key,
            "name": new_album["name"],
            "image_paths": new_album["image_paths"],
            "index": new_album["index"],
            "umap_eps": eps,
        },
    )
    assert response.status_code == 422
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(before)


def _album_body_with_nan_eps(album: dict) -> str:
    """An album payload carrying a bare ``NaN`` literal.

    ``json.dumps`` will not emit one, so the sentinel is swapped out after
    encoding — which is also exactly how a client that *can* emit it (any
    ``json.dumps(..., allow_nan=True)``, i.e. the default) reaches this API.
    """
    encoded = json.dumps(
        {
            "key": album["key"],
            "name": album["name"],
            "image_paths": album["image_paths"],
            "index": album["index"],
            "umap_eps": "__NAN__",
        }
    )
    return encoded.replace('"__NAN__"', "NaN")


def test_update_album_refuses_a_non_finite_eps_serializably(client, new_album):
    """The NaN reaches the client's error body through a different route here.

    /update_album takes a free-form dict, so the refusal is a ValidationError
    turned into an HTTPException rather than FastAPI's own 422 — and an
    HTTPException detail is rendered without the encoder the validation
    handler applies, so it has to be made safe on its own.
    """
    key = new_album["key"]
    response = client.post(
        "/update_album/",
        content=_album_body_with_nan_eps(new_album),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert "detail" in response.json()
    assert get_config_manager().get_album(key).umap_eps is not None


def test_add_album_refuses_a_non_finite_eps_serializably(client, tmp_path):
    """Same value, third door: here it is FastAPI's own body validation, and
    the NaN sits inside the album object rather than being the input itself."""
    images = tmp_path / "images"
    images.mkdir()
    payload = {
        "key": "eps_probe",
        "name": "Eps Probe",
        "image_paths": [images.as_posix()],
        "index": (images / "embeddings.npz").as_posix(),
    }
    response = client.post(
        "/add_album/",
        content=_album_body_with_nan_eps(payload),
        headers={"Content-Type": "application/json"},
    )
    try:
        assert response.status_code == 422
        assert "detail" in response.json()
        assert get_config_manager().get_album("eps_probe") is None
    finally:
        client.delete("/delete_album/eps_probe")


@pytest.mark.parametrize("written", ['"0.004"', "false", "0"])
def test_a_config_the_model_would_now_refuse_still_loads(client, new_album, written):
    """The bound is new; the files it applies to are not.

    Every one of these reaches the Album model as a float it refuses — a
    quoted number, a bool pydantic reads as 0.0, a plain zero — so if the
    repair does not catch it the album does not merely lose its Cluster
    Strength, the whole config fails to load.
    """
    key = new_album["key"]
    manager = get_config_manager()
    config_path = manager.config_path
    config_path.write_text(
        config_path.read_text().replace(f"umap_eps: {new_album['umap_eps']}", f"umap_eps: {written}")
    )
    manager.reload_config()

    stored = manager.get_album(key).umap_eps
    assert stored is None or stored >= MIN_CLUSTER_EPS
    assert client.post("/get_umap_eps/", json={"album": key}).status_code == 200


def test_a_string_eps_under_the_floor_still_loads(client, new_album):
    """A hand-written config can quote its numbers.

    The model refuses out-of-bounds values now, so anything the repair does
    not recognize as a number takes the *whole config* down rather than one
    album's Cluster Strength.
    """
    key = new_album["key"]
    manager = get_config_manager()
    config_path = manager.config_path
    config_path.write_text(
        config_path.read_text().replace(f"umap_eps: {new_album['umap_eps']}", 'umap_eps: "0.004"')
    )
    manager.reload_config()

    assert manager.get_album(key).umap_eps == pytest.approx(MIN_CLUSTER_EPS)


@pytest.mark.parametrize("min_samples", [0, -1])
def test_a_non_positive_min_samples_is_refused(client, new_album, min_samples):
    """The other DBSCAN parameter these endpoints hand to sklearn unchecked."""
    build_index(client, new_album)
    key = new_album["key"]

    assert client.get(f"/umap_data/{key}?cluster_min_samples={min_samples}").status_code == 422
    assert client.get(f"/cluster_labels/{key}?cluster_min_samples={min_samples}").status_code == 422


def test_null_still_clears_the_stored_value(client, new_album):
    """The constraint applies to a number, not to the deliberate clear that
    hands the album back to a derived Cluster Strength."""
    key = new_album["key"]
    assert client.post("/set_umap_eps/", json={"album": key, "eps": 0.42}).status_code == 200

    assert client.post("/set_umap_eps/", json={"album": key, "eps": None}).status_code == 200
    assert get_config_manager().get_album(key).umap_eps is None
