"""Endpoint behavior for the derived Cluster Strength.

``/get_umap_eps`` is what fills the semantic map's spinner, and
``/umap_data`` + ``/cluster_labels`` are what cluster with the result. What
these tests pin down is that all three agree, because the ids the first two
return are joined by the UI: a mismatch attaches hover labels to the wrong
blobs.
"""

from pathlib import Path

import numpy as np
import pytest
from fixtures import build_index

from photomap.backend.config import get_config_manager


def _clear_stored_eps(album_key):
    """Put an album back into the derived state (``umap_eps`` unset)."""
    manager = get_config_manager()
    album = manager.get_album(album_key)
    album.umap_eps = None
    manager.update_album(album)


def test_get_umap_eps_reports_a_stored_value_as_not_auto(client, new_album):
    # The fixture album stores 0.1, so nothing is derived for it.
    response = client.post("/get_umap_eps/", json={"album": new_album["key"]})
    assert response.status_code == 200
    assert response.json() == {"success": True, "eps": 0.1, "auto": False}


def test_get_umap_eps_derives_a_value_when_none_is_stored(client, new_album):
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])

    response = client.post("/get_umap_eps/", json={"album": new_album["key"]})
    assert response.status_code == 200
    body = response.json()

    assert body["auto"] is True
    assert body["eps"] > 0
    # Derived from this album's own coordinates, so it is not the old fixed
    # default that used to be handed to every album regardless of size.
    assert body["eps"] != 0.07


def test_derived_eps_is_stable_across_calls(client, new_album):
    """The spinner would jitter, and the label cache would miss on every
    open, if the derived value moved between requests."""
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])

    first = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()
    second = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()
    assert first["eps"] == pytest.approx(second["eps"])


def test_umap_data_and_cluster_labels_resolve_the_same_derived_eps(
    client, new_album, monkeypatch
):
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])

    seen = {}

    def fake_get_or_build(embeddings, *, cluster_eps, cluster_min_samples, top_k):
        seen["labels_eps"] = cluster_eps
        return {}

    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        fake_get_or_build,
    )

    # Record the eps ``/umap_data`` actually clusters with, rather than the
    # one it resolved — those are the same only if the router uses what it
    # resolved, which is the property under test.
    from photomap.backend.routers import umap as umap_router

    real_dbscan = umap_router.DBSCAN

    def recording_dbscan(*, eps, min_samples):
        seen["umap_eps"] = eps
        return real_dbscan(eps=eps, min_samples=min_samples)

    monkeypatch.setattr(umap_router, "DBSCAN", recording_dbscan)

    assert client.get(f"/umap_data/{new_album['key']}").status_code == 200
    assert client.get(f"/cluster_labels/{new_album['key']}").status_code == 200

    assert seen["umap_eps"] == pytest.approx(seen["labels_eps"])


def test_an_explicit_eps_still_wins_over_the_derived_one(client, new_album, monkeypatch):
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])

    captured = {}

    def fake_get_or_build(embeddings, *, cluster_eps, cluster_min_samples, top_k):
        captured["eps"] = cluster_eps
        return {}

    monkeypatch.setattr(
        "photomap.backend.routers.cluster_labels.get_or_build_cluster_labels",
        fake_get_or_build,
    )

    client.get(f"/cluster_labels/{new_album['key']}?cluster_eps=0.42")
    assert captured["eps"] == pytest.approx(0.42)


def test_empty_album_reports_a_usable_eps(client, new_album):
    """No index yet means no coordinates to derive from. The spinner still
    needs a number rather than a blank or a 500."""
    _clear_stored_eps(new_album["key"])

    response = client.post("/get_umap_eps/", json={"album": new_album["key"]})
    assert response.status_code == 200
    body = response.json()
    assert body["auto"] is True
    assert body["eps"] > 0


def test_derived_eps_survives_a_reindex(client, new_album, tmp_path):
    """The cache is keyed on the coordinates, so new ones must produce a
    freshly derived value rather than the stale one."""
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])
    first = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()["eps"]

    # Rewrite the cached UMAP coordinates at a different scale, exactly as a
    # re-index would, and confirm the endpoint notices.
    album = get_config_manager().get_album(new_album["key"])
    umap_path = Path(album.index).parent / "umap.npz"
    coords = np.load(umap_path)["umap"]
    np.savez(umap_path, umap=coords * 25.0)

    second = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()["eps"]
    assert second != pytest.approx(first)


def test_clearing_the_stored_eps_returns_the_album_to_derived(client, new_album):
    """The UI's way back: without it, typing a number once would pin the
    album to it forever short of editing the config file."""
    build_index(client, new_album)

    # The fixture album stores 0.1.
    before = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()
    assert before == {"success": True, "eps": 0.1, "auto": False}

    response = client.post(
        "/set_umap_eps/", json={"album": new_album["key"], "eps": None}
    )
    assert response.status_code == 200

    after = client.post("/get_umap_eps/", json={"album": new_album["key"]}).json()
    assert after["auto"] is True
    assert after["eps"] != 0.1


def test_cleared_eps_survives_a_config_reload(client, new_album):
    """`umap_eps: null` has to round-trip through the YAML, or the album
    would silently reacquire a number on the next restart."""
    client.post("/set_umap_eps/", json={"album": new_album["key"], "eps": None})

    manager = get_config_manager()
    manager.reload_config()
    assert manager.get_album(new_album["key"]).umap_eps is None
