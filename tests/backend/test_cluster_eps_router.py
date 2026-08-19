"""Endpoint behavior for the derived Cluster Strength.

``/get_umap_eps`` is what fills the semantic map's spinner, and
``/umap_data`` + ``/cluster_labels`` are what cluster with the result. What
these tests pin down is that all three agree, because the ids the first two
return are joined by the UI: a mismatch attaches hover labels to the wrong
blobs.
"""

import asyncio
import os
from pathlib import Path

import numpy as np
import pytest
import yaml
from fixtures import build_index

from photomap.backend import embeddings as embeddings_module
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


def test_a_derived_eps_is_written_as_an_absent_key(client, new_album):
    """Not `umap_eps: null`: a PhotoMapAI predating the nullable field parses
    an explicit null into a non-nullable float and refuses to load the config,
    so writing one would stop the older version from starting on a config file
    the two share."""
    client.post("/set_umap_eps/", json={"album": new_album["key"], "eps": None})

    album = get_config_manager().get_album(new_album["key"])
    assert "umap_eps" not in album.to_dict()

    stored = yaml.safe_load(get_config_manager().config_path.read_text())
    assert "umap_eps" not in stored["albums"][new_album["key"]]


# ---------------------------------------------------------------------------
# The coordinate load is a rebuild in disguise
# ---------------------------------------------------------------------------


def _stale_umap_cache(album_key):
    """Leave ``umap.npz`` older than ``embeddings.npz``, as any rewrite of the
    index does — deleting an image, an ``update_images`` run.

    That is the state in which ``Embeddings.umap_embeddings`` stops being a
    read and becomes a full UMAP refit.
    """
    album = get_config_manager().get_album(album_key)
    index_path = Path(album.index)
    umap_path = index_path.parent / "umap.npz"
    newer = umap_path.stat().st_mtime + 100
    os.utime(index_path, (newer, newer))


def _spy_on_umap_refit(monkeypatch):
    """Record which kind of thread each UMAP refit happens on.

    ``asyncio.get_running_loop()`` succeeds only on the thread running the
    event loop, so it distinguishes "inside the endpoint coroutine" from
    "inside a worker" without depending on thread names.
    """
    threads = []
    real = embeddings_module.Embeddings.create_umap_index

    def spy(self, embeddings):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            threads.append("worker")
        else:
            threads.append("event-loop")
        return real(self, embeddings)

    monkeypatch.setattr(embeddings_module.Embeddings, "create_umap_index", spy)
    return threads


@pytest.mark.parametrize(
    "call",
    [
        lambda client, key: client.post("/get_umap_eps/", json={"album": key}),
        lambda client, key: client.get(f"/cluster_labels/{key}"),
        lambda client, key: client.get(f"/umap_data/{key}"),
    ],
    ids=["get_umap_eps", "cluster_labels", "umap_data"],
)
def test_a_stale_umap_cache_is_rebuilt_off_the_event_loop(
    client, new_album, monkeypatch, call
):
    """Loading an album's coordinates can refit UMAP outright, which is
    minutes on a large album. Doing that in the endpoint coroutine stalls
    every other request — including the indexing-progress polling on the very
    screen the semantic map is opened from.

    Note this cannot be left to ``asyncio.to_thread(f, album_umap_coords(e))``:
    the argument is evaluated before the thread is spawned.
    """
    build_index(client, new_album)
    _clear_stored_eps(new_album["key"])
    _stale_umap_cache(new_album["key"])

    threads = _spy_on_umap_refit(monkeypatch)

    assert call(client, new_album["key"]).status_code == 200

    # Non-vacuous: the refit really did happen, it just happened elsewhere.
    assert threads, "expected the stale cache to trigger a UMAP refit"
    assert "event-loop" not in threads

# ---------------------------------------------------------------------------
# Album edits must not discard a tuned Cluster Strength
# ---------------------------------------------------------------------------


def _album_edit_payload(album_key, **overrides):
    """The payload the album-manager edit form actually sends.

    ``saveAlbumChanges()`` builds it from the fields the form has, and the
    form has no Cluster Strength control — so ``umap_eps`` is absent, which
    is the whole point of the tests below.
    """
    album = get_config_manager().get_album(album_key)
    payload = {
        "key": album_key,
        "name": album.name,
        "description": album.description,
        "encoder_spec": album.encoder_spec,
        "image_paths": album.image_paths,
        "index": album.index,
        "min_image_dimension": album.min_image_dimension,
        "min_image_bytes": album.min_image_bytes,
    }
    payload.update(overrides)
    return payload


def test_editing_an_album_keeps_a_tuned_cluster_strength(client, new_album):
    """Renaming an album must not undo the user's tuning.

    The edit form omits ``umap_eps``, so an update that treats "absent" as
    "clear it" throws the number away the moment anything else about the
    album is saved — while the docs promise the album keeps it.
    """
    key = new_album["key"]
    client.post("/set_umap_eps/", json={"album": key, "eps": 0.55})

    response = client.post(
        "/update_album/", json=_album_edit_payload(key, name="Renamed")
    )
    assert response.status_code == 200

    assert get_config_manager().get_album(key).name == "Renamed"
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(0.55)
    assert client.post("/get_umap_eps/", json={"album": key}).json() == {
        "success": True,
        "eps": 0.55,
        "auto": False,
    }


def test_editing_an_album_leaves_a_derived_strength_derived(client, new_album):
    """The other half: preserving an omitted value must not resurrect one for
    an album that never had it."""
    key = new_album["key"]
    client.post("/set_umap_eps/", json={"album": key, "eps": None})

    response = client.post("/update_album/", json=_album_edit_payload(key))
    assert response.status_code == 200

    assert get_config_manager().get_album(key).umap_eps is None


def test_an_explicit_null_in_an_update_still_clears(client, new_album):
    """Absent means "keep"; null means "clear". Bookmarks send the album's
    own value back verbatim, so both spellings have to keep working."""
    key = new_album["key"]
    client.post("/set_umap_eps/", json={"album": key, "eps": 0.55})

    response = client.post(
        "/update_album/", json=_album_edit_payload(key, umap_eps=None)
    )
    assert response.status_code == 200

    assert get_config_manager().get_album(key).umap_eps is None


def test_a_failed_set_umap_eps_does_not_come_back_later(client, new_album, monkeypatch):
    """A write the user was told had failed must not become durable.

    `set_umap_eps` mutates the Album object the config manager has cached, so
    a save that raises leaves the cache holding a value that is not on disk.
    The next unrelated edit reads that value forward — and now that an
    omitted `umap_eps` means "keep what is stored", it gets written out.
    """
    key = new_album["key"]

    def _no_disk(*args, **kwargs):
        raise OSError("read-only file system")

    monkeypatch.setattr("photomap.backend.config.atomic_write_text", _no_disk)
    with pytest.raises(RuntimeError):
        client.post("/set_umap_eps/", json={"album": key, "eps": 0.99})
    monkeypatch.undo()

    # The album kept the value it had on disk, not the one that failed.
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(0.1)

    response = client.post(
        "/update_album/", json=_album_edit_payload(key, name="Renamed")
    )
    assert response.status_code == 200
    assert get_config_manager().get_album(key).umap_eps == pytest.approx(0.1)
