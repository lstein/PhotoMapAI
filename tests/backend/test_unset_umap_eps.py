"""An album may have no Cluster Strength of its own.

Newer PhotoMapAI versions derive the semantic map's DBSCAN epsilon when the
user has not set one, and for a while they recorded that as an explicit
``umap_eps: null`` in config.yaml. Parsing that into a non-nullable float made
the *whole* config fail to load — one album's optional map setting stopping
the app from starting at all. These tests pin the tolerant behaviour and the
fallback that replaces it.
"""

import pytest
import yaml
from fixtures import build_index

from photomap.backend.config import (
    DEFAULT_UMAP_EPS,
    Album,
    ConfigManager,
    get_config_manager,
)


def _config_with(tmp_path, album_extra):
    album = {
        "name": "Album",
        "description": "",
        "image_paths": [str(tmp_path)],
        "index": str(tmp_path / "i.npz"),
        "encoder_spec": "openai-clip:ViT-B/32",
        **album_extra,
    }
    path = tmp_path / "config.yaml"
    path.write_text(
        yaml.safe_dump({"config_version": "1.0.0", "albums": {"a": album}}, indent=2)
    )
    return path


def test_explicit_null_cluster_strength_loads(tmp_path):
    """The failure this fixes: a config carrying a null refused to load, and
    the app could not start until the user hand-edited YAML."""
    config_path = _config_with(tmp_path, {"umap_eps": None})

    album = ConfigManager(config_path=config_path).get_album("a")

    assert album is not None
    assert album.umap_eps is None


def test_absent_cluster_strength_loads(tmp_path):
    config_path = _config_with(tmp_path, {})

    assert ConfigManager(config_path=config_path).get_album("a").umap_eps is None


def test_chosen_cluster_strength_survives(tmp_path):
    config_path = _config_with(tmp_path, {"umap_eps": 0.35})

    assert ConfigManager(config_path=config_path).get_album("a").umap_eps == 0.35


def test_unset_strength_is_written_as_an_absent_key(tmp_path):
    """Not as a null: that is exactly what older versions choke on, and the
    config file is shared with them whenever a user moves between releases."""
    album = Album(
        key="a",
        name="A",
        image_paths=[str(tmp_path)],
        index=str(tmp_path / "i.npz"),
    )

    assert "umap_eps" not in album.to_dict()

    album.umap_eps = 0.3
    assert album.to_dict()["umap_eps"] == 0.3


def test_get_umap_eps_reports_the_value_the_map_will_use(client, tmp_path):
    """The slider has to open where the clustering actually is, so an album
    that never chose a strength reports the fallback rather than null."""
    key = "unset_eps_album"
    response = client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Unset Eps",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "i.npz"),
        },
    )
    assert response.status_code == 201, response.text
    try:
        response = client.post("/get_umap_eps/", json={"album": key})
        assert response.status_code == 200, response.text
        assert response.json()["eps"] == pytest.approx(DEFAULT_UMAP_EPS)

        # Setting one stores it, and it is what comes back afterwards.
        response = client.post("/set_umap_eps/", json={"album": key, "eps": 0.42})
        assert response.status_code == 200, response.text
        assert client.post("/get_umap_eps/", json={"album": key}).json()[
            "eps"
        ] == pytest.approx(0.42)
    finally:
        client.delete(f"/delete_album/{key}")


def test_umap_data_clusters_an_album_with_no_chosen_strength(client, new_album):
    """The map endpoint is the one that cannot work without the fallback:
    handing DBSCAN a None raises, and the map is the first thing the user
    opens after indexing."""
    build_index(client, new_album)

    manager = get_config_manager()
    album = manager.get_album(new_album["key"])
    album.umap_eps = None
    manager.update_album(album)

    response = client.get(f"/umap_data/{new_album['key']}")
    assert response.status_code == 200, response.text


def test_a_strength_dbscan_cannot_use_is_refused(client, tmp_path):
    """Storing a non-positive epsilon only defers the failure to the next time
    the map opens, and the value is invisible in the meantime because every
    reader resolves it away."""
    key = "bad_eps_album"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Bad Eps",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "i.npz"),
        },
    )
    try:
        for bad in (0, -0.5):
            response = client.post("/set_umap_eps/", json={"album": key, "eps": bad})
            assert response.status_code == 422, response.text
    finally:
        client.delete(f"/delete_album/{key}")


def test_cluster_labels_uses_the_fallback_when_nothing_is_chosen(
    client, new_album, monkeypatch
):
    """The endpoints resolve their own fallback rather than handing None to
    DBSCAN, which would raise on the first request the map makes."""
    manager = get_config_manager()
    album = manager.get_album(new_album["key"])
    album.umap_eps = None
    manager.update_album(album)

    captured = {}

    def fake_get_or_build(embeddings, *, cluster_eps, cluster_min_samples, top_k):
        captured["eps"] = cluster_eps
        return {}

    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        fake_get_or_build,
    )

    response = client.get(f"/cluster_labels/{new_album['key']}")
    assert response.status_code == 200, response.text
    assert captured["eps"] == pytest.approx(DEFAULT_UMAP_EPS)

    # An explicit query parameter still wins over both.
    client.get(f"/cluster_labels/{new_album['key']}?cluster_eps=0.25")
    assert captured["eps"] == pytest.approx(0.25)
