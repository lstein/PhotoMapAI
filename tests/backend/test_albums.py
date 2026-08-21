"""
test_albums.py
Tests for the albums functionality of the PhotoMap application.
"""

from pathlib import Path

import pytest

from photomap.backend.config import Album, create_album, get_config_manager


def test_config():
    manager = get_config_manager()
    assert manager is not None
    assert manager.validate_config() is True
    assert manager.has_albums() is False
    assert manager.is_first_run() is True
    assert manager.get_albums() == {}


def test_encoder_idle_timeout_default_and_round_trip(tmp_path):
    """The new encoder_idle_timeout_seconds field must default to 30s and
    round-trip through YAML so changes in config.yaml take effect on restart.
    """
    import yaml

    from photomap.backend.config import Config, ConfigManager

    # Default applies when the YAML file omits the field.
    cfg = Config()
    assert cfg.encoder_idle_timeout_seconds == 30.0

    # Negative values are rejected so a typo can't silently disable the feature
    # forever (0 is the explicit "off" value).
    with pytest.raises(ValueError):
        Config(encoder_idle_timeout_seconds=-1.0)

    # Round-trip through ConfigManager.save_config / load_config.
    config_path = tmp_path / "config.yaml"
    manager = ConfigManager(config_path=config_path)
    cfg = manager.load_config()
    cfg.encoder_idle_timeout_seconds = 90.0
    manager._config = cfg
    manager.save_config()

    raw = yaml.safe_load(config_path.read_text())
    assert raw["encoder_idle_timeout_seconds"] == 90.0

    fresh = ConfigManager(config_path=config_path)
    assert fresh.load_config().encoder_idle_timeout_seconds == 90.0


def test_add_delete_album():
    manager = get_config_manager()
    album = create_album(
        "test_album",
        "Test Album",
        image_paths=["./tests/test_images"],
        index="./tests/test_images/embeddings.npz",
        umap_eps=0.1,
        description="A test album",
    )
    manager.add_album(album)
    try:
        assert manager.has_albums() is True
        assert album.key in manager.get_albums()
        assert (
            Path(album.index).resolve().as_posix()
            == Path("./tests/test_images", "embeddings.npz").resolve().as_posix()
        )
        assert Path("./tests/test_images").resolve().as_posix() in [
            Path(x).resolve().as_posix() for x in album.image_paths
        ]
    except AssertionError as e:
        raise e
    finally:
        manager.delete_album(album.key)
    assert album.key not in manager.get_albums()


def test_album_routes(client):
    response = client.get("/available_albums")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    albums = response.json()
    assert isinstance(albums, list)
    assert len(albums) == 0

    # Test /add_album route
    # Create an album and check if it appears in the list
    new_album = create_album(
        "test_album",
        "Test Album",
        image_paths=["./tests/test_images"],
        index="./tests/test_images/embeddings.npz",
        umap_eps=0.1,
        description="A test album",
    )
    response = client.post("/add_album", json=new_album.model_dump())
    assert response.status_code == 201
    assert response.json() == {
        "success": True,
        "message": "Album 'test_album' added successfully",
    }

    # Check if the album is now available
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 1
    assert albums[0]["name"] == "Test Album"
    album = Album.from_dict(data=albums[0], key=albums[0]["key"])
    assert album.key == "test_album"
    assert album.name == "Test Album"
    assert [Path(x).resolve().as_posix() for x in album.image_paths] == [
        Path("./tests/test_images").resolve().as_posix()
    ]
    assert (
        Path(album.index).resolve().as_posix()
        == Path("./tests/test_images", "embeddings.npz").resolve().as_posix()
    )
    assert album.umap_eps == 0.1
    assert album.description == "A test album"

    # Check that we can update the album
    updated_album = album.model_dump()
    updated_album["name"] = "Updated Test Album"
    response = client.post("/update_album", json=updated_album)
    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "Album 'test_album' updated successfully",
    }

    # Check that the album was updated
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 1
    assert albums[0]["name"] == "Updated Test Album"

    # Check the EPS get/set functionality
    from photomap.backend.routers.album import (
        UmapEpsSetRequest,
    )

    response = client.post(
        "/set_umap_eps", json=UmapEpsSetRequest(eps=0.50, album=album.key).model_dump()
    )
    assert response.status_code == 200
    assert response.json() == {"success": True, "eps": 0.50}
    response = client.post("/get_umap_eps", json={"album": album.key})
    assert response.status_code == 200
    # ``auto`` false: the value was stored by the caller above, not derived
    # from the album's coordinates.
    assert response.json() == {"success": True, "eps": 0.50, "auto": False}

    # Check that we can delete the album
    response = client.delete(f"/delete_album/{album.key}")
    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "Album 'test_album' deleted successfully",
    }

    # Check that the album is no longer available
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 0


def test_default_encoder_endpoint(client, monkeypatch):
    """/default_encoder/ reports the host-resolved default the frontend
    pre-selects in the new-album dropdown."""
    from photomap.backend.encoders import (
        CPU_FALLBACK_ENCODER_SPEC,
        DEFAULT_ENCODER_SPEC,
    )

    monkeypatch.setattr(
        "photomap.backend.routers.album.default_encoder_spec",
        lambda: CPU_FALLBACK_ENCODER_SPEC,
    )
    assert client.get("/default_encoder/").json() == {
        "encoder_spec": CPU_FALLBACK_ENCODER_SPEC
    }

    monkeypatch.setattr(
        "photomap.backend.routers.album.default_encoder_spec",
        lambda: DEFAULT_ENCODER_SPEC,
    )
    assert client.get("/default_encoder/").json() == {
        "encoder_spec": DEFAULT_ENCODER_SPEC
    }


def test_encoder_spec_round_trips_through_available_albums(client, tmp_path):
    """Regression: /available_albums/ used to strip encoder_spec, which
    caused the album-manager edit form to always show the default encoder
    even after the user had picked something else.
    """
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()
    spec = "siglip:google/siglip2-large-patch16-256"

    response = client.post(
        "/add_album/",
        json={
            "key": "siglip_album",
            "name": "SigLIP Album",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "siglip.npz"),
            "umap_eps": 0.1,
            "description": "",
            "encoder_spec": spec,
        },
    )
    assert response.status_code == 201

    listing = client.get("/available_albums/").json()
    siglip_albums = [a for a in listing if a["key"] == "siglip_album"]
    assert len(siglip_albums) == 1
    assert siglip_albums[0]["encoder_spec"] == spec

    detail = client.get("/album/siglip_album/").json()
    assert detail["encoder_spec"] == spec

    # Edits via /update_album/ persist a new spec, and it shows up on the next listing.
    new_spec = "open-clip:ViT-L-14/dfn2b_s39b"
    response = client.post(
        "/update_album/",
        json={
            "key": "siglip_album",
            "name": "SigLIP Album",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "siglip.npz"),
            "encoder_spec": new_spec,
        },
    )
    assert response.status_code == 200

    listing = client.get("/available_albums/").json()
    siglip_albums = [a for a in listing if a["key"] == "siglip_album"]
    assert siglip_albums[0]["encoder_spec"] == new_spec

    client.delete("/delete_album/siglip_album")


def test_per_album_search_settings_round_trip(client, tmp_path):
    """Per-album min_score / max_results / use_query_optimization round-trip
    through add_album → /available_albums → /update_album.

    Also locks in the encoder-aware default for min_search_score: SigLIP
    albums default to 0.005 (its compressed-cosine band needs a much lower
    threshold than CLIP) and OpenAI CLIP albums to 0.2. The per-family table
    itself lives in test_score_floors.py.
    """
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()

    # SigLIP album: omit min_search_score so we exercise the default.
    response = client.post(
        "/add_album/",
        json={
            "key": "siglip_defaults",
            "name": "SigLIP defaults",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "s.npz"),
            "umap_eps": 0.1,
            "encoder_spec": "siglip:google/siglip2-base-patch16-224",
        },
    )
    assert response.status_code == 201

    # CLIP album: omit too — different default.
    response = client.post(
        "/add_album/",
        json={
            "key": "clip_defaults",
            "name": "CLIP defaults",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "c.npz"),
            "umap_eps": 0.1,
            "encoder_spec": "openai-clip:ViT-B/32",
        },
    )
    assert response.status_code == 201

    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["siglip_defaults"]["min_search_score"] == pytest.approx(0.005)
    assert listing["clip_defaults"]["min_search_score"] == pytest.approx(0.2)
    assert listing["siglip_defaults"]["max_search_results"] == 100
    assert listing["siglip_defaults"]["use_query_optimization"] is True

    # Update through /update_album/ persists explicit values, including
    # turning query_optimization off and bumping the threshold.
    response = client.post(
        "/update_album/",
        json={
            "key": "siglip_defaults",
            "name": "SigLIP defaults",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "s.npz"),
            "min_search_score": 0.05,
            "max_search_results": 250,
            "use_query_optimization": False,
            "encoder_spec": "siglip:google/siglip2-base-patch16-224",
        },
    )
    assert response.status_code == 200

    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["siglip_defaults"]["min_search_score"] == pytest.approx(0.05)
    assert listing["siglip_defaults"]["max_search_results"] == 250
    assert listing["siglip_defaults"]["use_query_optimization"] is False

    client.delete("/delete_album/siglip_defaults")
    client.delete("/delete_album/clip_defaults")


def test_min_image_dimension_round_trips(client, tmp_path):
    """The Edit Album dialogue's "Exclude thumbnails..." input must round-trip
    through add_album → /available_albums → /update_album, and an album with
    no ``min_image_dimension`` set should expose the 256 default. Backs the
    Album Manager UI wiring for the per-album dimension gate.
    """
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()

    # Add with no min_image_dimension — backend should default to 256.
    response = client.post(
        "/add_album/",
        json={
            "key": "dim_default",
            "name": "Default dim",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "d.npz"),
            "umap_eps": 0.1,
            "encoder_spec": "openai-clip:ViT-B/32",
        },
    )
    assert response.status_code == 201

    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["dim_default"]["min_image_dimension"] == 256

    # Update with an explicit value — must persist on the next listing.
    response = client.post(
        "/update_album/",
        json={
            "key": "dim_default",
            "name": "Default dim",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "d.npz"),
            "encoder_spec": "openai-clip:ViT-B/32",
            "min_image_dimension": 512,
        },
    )
    assert response.status_code == 200

    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["dim_default"]["min_image_dimension"] == 512

    # Pydantic ``ge=1`` guard: zero and negatives are rejected at the API.
    response = client.post(
        "/update_album/",
        json={
            "key": "dim_default",
            "name": "Default dim",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "d.npz"),
            "encoder_spec": "openai-clip:ViT-B/32",
            "min_image_dimension": 0,
        },
    )
    assert response.status_code == 500
    # Previous valid value must remain — failed update must not corrupt state.
    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["dim_default"]["min_image_dimension"] == 512

    client.delete("/delete_album/dim_default")


# ── InvokeAI board-backed albums ──────────────────────────────────────────


def _board_album_payload(key="board_album", **overrides):
    payload = {
        "key": key,
        "name": "Board Album",
        "description": "Backed by InvokeAI boards",
        "source_type": "invokeai_board",
        "invokeai_url": "http://localhost:9090",
        "invokeai_username": "alice",
        "invokeai_password": "secret",
        "invokeai_root": "/srv/invokeai",
        "invokeai_board_ids": ["b1", "none"],
        "encoder_spec": "openai-clip:ViT-B/32",
    }
    payload.update(overrides)
    return payload


def test_add_board_album_derives_paths_and_index(client):
    """POSTing a board album without index/image_paths derives both."""
    from photomap.backend.config import default_board_index_path

    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text

    try:
        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album is not None
        assert album.source_type == "invokeai_board"
        # Both output directories: a board's videos are indexed alongside its
        # images, and ``image_paths`` is what grants access to them.
        assert album.image_paths == [
            str(Path("/srv/invokeai") / "outputs" / "images"),
            str(Path("/srv/invokeai") / "outputs" / "videos"),
        ]
        assert album.index == default_board_index_path("board_album").as_posix()
        assert album.invokeai_board_ids == ["b1", "none"]
        assert album.invokeai_password == "secret"
    finally:
        client.delete("/delete_album/board_album")


def test_board_album_written_before_video_support_gains_the_videos_path():
    """Albums persisted when only ``outputs/images`` was derived must pick up
    the videos directory on load, with no migration step: ``image_paths`` is
    what gates file access, so without it a board video indexes and then 403s
    at playback."""
    from photomap.backend.config import Album

    album = Album(
        **_board_album_payload(image_paths=[str(Path("/srv/invokeai/outputs/images"))])
    )

    assert album.image_paths == [
        str(Path("/srv/invokeai") / "outputs" / "images"),
        str(Path("/srv/invokeai") / "outputs" / "videos"),
    ]


def test_board_album_does_not_warn_about_an_absent_videos_directory(caplog):
    """InvokeAI creates ``outputs/videos`` only once it writes a video, and the
    directory is derived rather than user-chosen — warning about it would fire
    on every config load for a correct setup."""
    import logging

    from photomap.backend.config import Album

    with caplog.at_level(logging.WARNING, logger="photomap.backend.config"):
        Album(**_board_album_payload())

    assert "Image path does not exist" not in caplog.text


def test_directory_album_still_warns_about_a_missing_path(caplog, tmp_path):
    """The warning itself stays: it is the only notice a directory album gets
    for a path that is not there."""
    import logging

    from photomap.backend.config import Album

    with caplog.at_level(logging.WARNING, logger="photomap.backend.config"):
        Album(
            key="dir_album",
            name="Dir Album",
            image_paths=[str(tmp_path / "not-there")],
            index=str(tmp_path / "idx.npz"),
        )

    assert "Image path does not exist" in caplog.text


def test_board_album_yaml_round_trip(client):
    """All board fields survive a save/reload cycle of the YAML config."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        manager = get_config_manager()
        before = manager.get_album("board_album")
        manager.reload_config()
        after = manager.get_album("board_album")
        assert after == before
    finally:
        client.delete("/delete_album/board_album")


def test_album_endpoints_never_leak_password(client):
    """Neither /album/{key}/ nor /available_albums/ may expose the stored
    per-album InvokeAI password."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        single = client.get("/album/board_album/").json()
        assert "invokeai_password" not in single
        assert single["has_invokeai_password"] is True
        assert single["source_type"] == "invokeai_board"
        assert single["invokeai_board_ids"] == ["b1", "none"]

        listing = client.get("/available_albums/").json()
        entry = next(a for a in listing if a["key"] == "board_album")
        assert "invokeai_password" not in entry
        assert entry["has_invokeai_password"] is True
        assert entry["invokeai_url"] == "http://localhost:9090"
    finally:
        client.delete("/delete_album/board_album")


def test_partial_update_does_not_demote_a_board_album(client):
    """A payload that omits ``source_type`` is a patch, not a replacement: the
    bookmark menu sends key/name/image_paths only, and rebuilding the album
    from that used to reset it to a directory album with every ``invokeai_*``
    field cleared — after which indexing walked InvokeAI's output directories
    directly and deletions stopped routing through its API (issue #371)."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        response = client.post(
            "/update_album/",
            json={"key": "board_album", "name": "Board Album"},
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album.source_type == "invokeai_board"
        assert album.invokeai_root == "/srv/invokeai"
        assert album.invokeai_url == "http://localhost:9090"
        assert album.invokeai_board_ids == ["b1", "none"]
        assert album.invokeai_username == "alice"
    finally:
        client.delete("/delete_album/board_album")


def test_adding_a_folder_to_a_board_album_is_refused(client):
    """A board album's directories are derived from the InvokeAI root, so an
    added folder cannot survive. Accepting the request and discarding it would
    make "add this folder to the album" look like it worked."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        album = client.get("/album/board_album/").json()
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "image_paths": [*album["image_paths"], "/tmp/somewhere-else"],
            },
        )
        assert response.status_code == 400, response.text
        assert "InvokeAI root" in response.json()["detail"]

        manager = get_config_manager()
        manager.reload_config()
        assert manager.get_album("board_album").image_paths == album["image_paths"]
    finally:
        client.delete("/delete_album/board_album")


def test_unresolvable_path_is_refused_not_a_crash(client, tmp_path):
    """The board guard normalizes paths to compare them, and what
    ``Path.resolve()`` raises for an unresolvable one is interpreter-dependent
    (a symlink loop is a RuntimeError up to 3.12, an OSError from 3.13). The
    request is still just a refused change, not a 500."""
    loop = tmp_path / "loop"
    loop.symlink_to(tmp_path / "loop2")
    (tmp_path / "loop2").symlink_to(loop)

    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "image_paths": [str(loop)],
            },
        )
        assert response.status_code == 400, response.text
    finally:
        client.delete("/delete_album/board_album")


def test_partial_update_keeps_tuning_fields(client, tmp_path):
    """The same patch rule for every other field: a payload that carries only
    a rename must not reset the encoder, the scan gates or the search
    settings to their model defaults."""
    key = "patch_album"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Patch Album",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "photomap_index" / "embeddings.npz"),
            "encoder_spec": "openai-clip:ViT-L/14",
            "min_image_dimension": 512,
            "min_image_bytes": 0,
            "max_search_results": 42,
            "use_query_optimization": False,
            "description": "keep me",
        },
    )
    try:
        response = client.post(
            "/update_album/", json={"key": key, "name": "Renamed"}
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album(key)
        assert album.name == "Renamed"
        assert album.encoder_spec == "openai-clip:ViT-L/14"
        assert album.min_image_dimension == 512
        # 0 is a real setting (the gate off), not a missing value.
        assert album.min_image_bytes == 0
        assert album.max_search_results == 42
        assert album.use_query_optimization is False
        assert album.description == "keep me"
        assert album.image_paths == [str(tmp_path)]
    finally:
        client.delete(f"/delete_album/{key}")


def test_update_can_still_clear_and_change_values(client, tmp_path):
    """Patching must not become "you can never change anything": explicit
    values, including a falsy one, still win over what is stored."""
    key = "patch_album_2"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Patch Album 2",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "photomap_index" / "embeddings.npz"),
            "description": "original",
            "min_image_bytes": 8192,
        },
    )
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Patch Album 2",
                "description": "",
                "min_image_bytes": 0,
            },
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album(key)
        assert album.description == ""
        assert album.min_image_bytes == 0
    finally:
        client.delete(f"/delete_album/{key}")


def test_changing_the_invokeai_root_moves_the_derived_paths(client):
    """A board album's directories are derived from its root, so an edit that
    moves the root has to move them: carrying the stored list over would
    suppress the derivation and leave the access gate pointing at the old
    root, 404ing every image the re-index just wrote."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        # Exactly what the album editor sends: image_paths and index omitted.
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "source_type": "invokeai_board",
                "invokeai_url": "http://localhost:9090",
                "invokeai_root": "/srv/invokeai2",
                "invokeai_board_ids": ["b1", "none"],
            },
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album.invokeai_root == "/srv/invokeai2"
        assert album.image_paths[0].startswith(str(Path("/srv/invokeai2")))
    finally:
        client.delete("/delete_album/board_album")


def test_source_type_cannot_be_changed_by_an_update(client):
    """The kind of an album is fixed at creation. A payload that disagrees is
    a partial payload being read as a replacement, which is how board albums
    used to be demoted (issue #371).

    ``image_paths`` is deliberately omitted: with it, the request would be
    refused by the board-paths guard instead, and this test would pass while
    the source type went unchecked."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "source_type": "directory",
            },
        )
        assert response.status_code == 400, response.text

        manager = get_config_manager()
        manager.reload_config()
        assert manager.get_album("board_album").source_type == "invokeai_board"
    finally:
        client.delete("/delete_album/board_album")


def test_invokeai_username_can_be_cleared(client):
    """The edit form sends null for an emptied username — InvokeAI dropping
    out of multi-user mode — and that has to clear it rather than read as
    'field omitted'."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "source_type": "invokeai_board",
                "invokeai_url": "http://localhost:9090",
                "invokeai_root": "/srv/invokeai",
                "invokeai_board_ids": ["b1", "none"],
                "invokeai_username": None,
            },
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album.invokeai_username is None
        assert album.invokeai_password == "secret"  # still kept
    finally:
        client.delete("/delete_album/board_album")


def test_unrelated_edits_keep_a_tuned_min_search_score(client, tmp_path):
    """The score is tuned from the search dialog and never sent by the album
    editor, so any other edit — including swapping one CLIP model for another
    — has to leave it alone."""
    key = "tuned_score_album"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Tuned Score",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "photomap_index" / "embeddings.npz"),
            "encoder_spec": "openai-clip:ViT-B/32",
            "min_search_score": 0.35,
        },
    )
    try:
        manager = get_config_manager()

        response = client.post("/update_album/", json={"key": key, "name": "Renamed"})
        assert response.status_code == 200, response.text
        manager.reload_config()
        assert manager.get_album(key).min_search_score == 0.35

        # Same family, different model: still no reason to touch the score.
        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Renamed",
                "encoder_spec": "openai-clip:ViT-L/14",
            },
        )
        assert response.status_code == 200, response.text
        manager.reload_config()
        assert manager.get_album(key).min_search_score == 0.35
    finally:
        client.delete(f"/delete_album/{key}")


def test_null_does_not_reset_a_tuning_field_to_its_default(client, tmp_path):
    """``create_album`` turns a None into the *model default*, so honoring an
    explicit null here would quietly re-encode an album under a different
    encoder rather than clear anything."""
    key = "null_field_album"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Null Field",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "photomap_index" / "embeddings.npz"),
            "encoder_spec": "openai-clip:ViT-L/14",
            "min_image_bytes": 0,
        },
    )
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Null Field",
                "encoder_spec": None,
                "min_image_bytes": None,
            },
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album(key)
        assert album.encoder_spec == "openai-clip:ViT-L/14"
        assert album.min_image_bytes == 0
    finally:
        client.delete(f"/delete_album/{key}")


def _derived_board_paths(root: str) -> list[str]:
    """The image directories a board album derives from ``root``.

    Both of them — board albums have indexed videos alongside images since
    #369, so the derived list is a pair and a caller echoing only the images
    directory is not echoing what the album has.
    """
    outputs = Path(root) / "outputs"
    return [str(outputs / "images"), str(outputs / "videos")]


def test_board_album_accepts_the_paths_its_own_root_change_derives(client):
    """A caller that computes the new derived paths and sends them is not
    asking for a change, and neither is one still echoing the stored list
    while a root edit is in flight."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        base = {
            "key": "board_album",
            "name": "Board Album",
            "source_type": "invokeai_board",
            "invokeai_url": "http://localhost:9090",
            "invokeai_root": "/srv/invokeai2",
            "invokeai_board_ids": ["b1", "none"],
        }
        # Both of them: a board album derives an images *and* a videos
        # directory from its root, so "the paths this root derives" is the
        # pair, not the images one alone.
        derived = _derived_board_paths("/srv/invokeai2")
        response = client.post("/update_album/", json={**base, "image_paths": derived})
        assert response.status_code == 200, response.text

        # A root edit that carries the album's *stored* paths — what the
        # album editor's own GET-then-POST produces — is likewise not a
        # request to change them.
        response = client.post(
            "/update_album/",
            json={
                **base,
                "invokeai_root": "/srv/invokeai3",
                "image_paths": _derived_board_paths("/srv/invokeai2"),
            },
        )
        assert response.status_code == 200, response.text
        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album.invokeai_root == "/srv/invokeai3"
        assert album.image_paths[0].startswith(str(Path("/srv/invokeai3")))

        # A stale writer that fetched the album before the root moved posts
        # the old root together with the old paths: consistent with itself,
        # asking for nothing, and not the guard's business (it loses the root
        # edit, which is the pre-existing last-write-wins race).
        stale_root = {**base, "invokeai_root": "/srv/invokeai2"}
        stale_paths = _derived_board_paths("/srv/invokeai2")
        response = client.post(
            "/update_album/", json={**stale_root, "image_paths": stale_paths}
        )
        assert response.status_code == 200, response.text
    finally:
        client.delete("/delete_album/board_album")


def test_invokeai_password_can_be_forgotten(client):
    """A blank password means "I did not touch this", so clearing one needs a
    signal of its own: the edit form's *Forget saved password* box sends an
    explicit null. Without it a backend that leaves multi-user mode keeps
    offering a credential nobody can remove short of editing YAML."""
    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        base = {
            "key": "board_album",
            "name": "Board Album",
            "source_type": "invokeai_board",
            "invokeai_url": "http://localhost:9090",
            "invokeai_root": "/srv/invokeai",
            "invokeai_board_ids": ["b1", "none"],
        }
        manager = get_config_manager()

        # Blank still means keep.
        response = client.post(
            "/update_album/", json={**base, "invokeai_password": ""}
        )
        assert response.status_code == 200, response.text
        manager.reload_config()
        assert manager.get_album("board_album").invokeai_password == "secret"
        assert client.get("/album/board_album/").json()["has_invokeai_password"] is True

        # Null clears it.
        response = client.post(
            "/update_album/", json={**base, "invokeai_password": None}
        )
        assert response.status_code == 200, response.text
        manager.reload_config()
        assert manager.get_album("board_album").invokeai_password is None
        assert (
            client.get("/album/board_album/").json()["has_invokeai_password"] is False
        )
    finally:
        client.delete("/delete_album/board_album")


def test_changing_the_encoder_reresolves_min_search_score(client, tmp_path):
    """The sensible score floor differs by an order of magnitude between
    encoder families, and the edit form never sends one. Carrying the old
    value across an encoder change makes the new encoder look broken."""
    key = "encoder_switch_album"
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Encoder Switch",
            "image_paths": [str(tmp_path)],
            "index": str(tmp_path / "photomap_index" / "embeddings.npz"),
            "encoder_spec": "siglip:google/siglip2-base-patch16-224",
        },
    )
    try:
        manager = get_config_manager()
        manager.reload_config()
        assert manager.get_album(key).min_search_score == 0.005

        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Encoder Switch",
                "encoder_spec": "openai-clip:ViT-B/32",
            },
        )
        assert response.status_code == 200, response.text

        manager.reload_config()
        assert manager.get_album(key).min_search_score == 0.2

        # An explicit score still wins over the re-resolution.
        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Encoder Switch",
                "encoder_spec": "siglip:google/siglip2-base-patch16-224",
                "min_search_score": 0.15,
            },
        )
        assert response.status_code == 200, response.text
        manager.reload_config()
        assert manager.get_album(key).min_search_score == 0.15
    finally:
        client.delete(f"/delete_album/{key}")


def test_blank_index_keeps_the_stored_one(client, tmp_path):
    """The edit form sends "" for the index when an album has no paths left to
    derive one from; that must not be resolved against the server's working
    directory."""
    key = "blank_index_album"
    index = str(tmp_path / "photomap_index" / "embeddings.npz")
    client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "Blank Index",
            "image_paths": [str(tmp_path)],
            "index": index,
        },
    )
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": key,
                "name": "Blank Index",
                "image_paths": [str(tmp_path)],
                "index": "",
            },
        )
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        # Compared as paths, not strings: Album.validate_index_path stores the
        # posix form, so on Windows the stored value uses forward slashes
        # while str(tmp_path / ...) uses backslashes. Both name the same file,
        # which is what this test is about.
        assert Path(manager.get_album(key).index) == Path(index)
    finally:
        client.delete(f"/delete_album/{key}")


def test_update_board_album_keeps_password_and_index_when_omitted(client):
    """The edit form omits the password (never echoed) and the index — both
    must survive an update untouched."""
    from photomap.backend.config import default_board_index_path

    response = client.post("/add_album/", json=_board_album_payload())
    assert response.status_code == 201, response.text
    try:
        update = {
            "key": "board_album",
            "name": "Renamed Board Album",
            "source_type": "invokeai_board",
            "invokeai_url": "http://localhost:9090",
            "invokeai_username": "alice",
            "invokeai_root": "/srv/invokeai",
            "invokeai_board_ids": ["b2"],
        }
        response = client.post("/update_album/", json=update)
        assert response.status_code == 200, response.text

        manager = get_config_manager()
        manager.reload_config()
        album = manager.get_album("board_album")
        assert album.name == "Renamed Board Album"
        assert album.invokeai_board_ids == ["b2"]
        assert album.invokeai_password == "secret"  # kept
        assert album.index == default_board_index_path("board_album").as_posix()
    finally:
        client.delete("/delete_album/board_album")


def test_board_album_requires_connection_fields(client):
    """Board albums without url/root/board ids are rejected."""
    for missing in ("invokeai_url", "invokeai_root", "invokeai_board_ids"):
        payload = _board_album_payload(**{missing: None})
        response = client.post("/add_album/", json=payload)
        assert response.status_code >= 400, (
            f"album missing {missing} was accepted: {response.text}"
        )


def test_board_album_key_cannot_traverse_paths():
    """Album keys land in a filesystem path — traversal must be rejected."""
    import pytest as _pytest
    from pydantic import ValidationError

    from photomap.backend.config import Album, default_board_index_path

    for bad_key in ("../evil", "a/b", "a\\b"):
        with _pytest.raises(ValueError):
            default_board_index_path(bad_key)
        with _pytest.raises(ValidationError):
            Album(
                key=bad_key,
                name="Bad",
                source_type="invokeai_board",
                invokeai_url="http://localhost:9090",
                invokeai_root="/srv/invokeai",
                invokeai_board_ids=["b1"],
            )


def test_legacy_album_dict_loads_as_directory_album():
    """YAML written before source_type existed must load unchanged."""
    legacy = {
        "name": "Old Album",
        "image_paths": ["/tmp/somewhere"],
        "index": "/tmp/somewhere/embeddings.npz",
    }
    album = Album.from_dict("old_album", legacy)
    assert album.source_type == "directory"
    assert album.invokeai_url is None
    assert album.invokeai_board_ids == []
    # And directory albums keep their YAML free of InvokeAI keys.
    assert not any(k.startswith("invokeai") for k in album.to_dict())


def test_min_image_bytes_round_trips(client, tmp_path):
    """The Edit Album dialogue's byte-size gate must round-trip through
    add_album → /available_albums → /update_album, defaulting to 8192, and
    0 (gate disabled) must be accepted."""
    img_dir = tmp_path / "imgs"
    img_dir.mkdir()

    response = client.post(
        "/add_album/",
        json={
            "key": "bytes_default",
            "name": "Default bytes",
            "image_paths": [str(img_dir)],
            "index": str(tmp_path / "b.npz"),
            "umap_eps": 0.1,
            "encoder_spec": "openai-clip:ViT-B/32",
        },
    )
    assert response.status_code == 201

    listing = {a["key"]: a for a in client.get("/available_albums/").json()}
    assert listing["bytes_default"]["min_image_bytes"] == 8192

    # Explicit value (16 kb) and the 0 = disabled sentinel must both persist.
    for value in (16 * 1024, 0):
        response = client.post(
            "/update_album/",
            json={
                "key": "bytes_default",
                "name": "Default bytes",
                "image_paths": [str(img_dir)],
                "index": str(tmp_path / "b.npz"),
                "encoder_spec": "openai-clip:ViT-B/32",
                "min_image_bytes": value,
            },
        )
        assert response.status_code == 200
        listing = {a["key"]: a for a in client.get("/available_albums/").json()}
        assert listing["bytes_default"]["min_image_bytes"] == value


def _directory_album(client, tmp_path, key, **overrides):
    """A plain directory album to patch in the tests below."""
    images = tmp_path / key
    images.mkdir()
    payload = {
        "key": key,
        "name": key.capitalize(),
        "image_paths": [str(images)],
        "index": str(tmp_path / f"{key}.npz"),
        "encoder_spec": "openai-clip:ViT-B/32",
    }
    payload.update(overrides)
    assert client.post("/add_album/", json=payload).status_code == 201
    return payload


def test_a_null_score_still_re_resolves_across_an_encoder_family_change(
    client, tmp_path
):
    """Null means "not supplied" to ``kept``, so it has to mean that here too.

    Testing presence instead made the two halves of this rule disagree: an
    explicit null suppressed the re-resolve *and* then fell through ``kept``
    to the stored number, leaving a CLIP floor of 0.35 on a SigLIP album.
    SigLIP similarities sit around 0.05-0.15, so that floor matches nothing
    and the album's search silently returns empty.
    """
    _directory_album(client, tmp_path, "nullscore", min_search_score=0.35)

    response = client.post(
        "/update_album/",
        json={
            "key": "nullscore",
            "encoder_spec": "siglip:google/siglip2-large-patch16-256",
            "min_search_score": None,
        },
    )
    assert response.status_code == 200

    album = get_config_manager().get_album("nullscore")
    assert album.encoder_spec.startswith("siglip:")
    assert album.min_search_score == pytest.approx(0.005)


def test_a_hand_tuned_score_survives_a_change_within_one_family(client, tmp_path):
    """The other half: swapping one OpenCLIP model for another must not touch
    a score the user chose.

    "Family" is the *score band*, not the word CLIP: OpenAI CLIP and OpenCLIP
    are two bands about 0.1 apart (see ``default_min_search_score``), so the
    pair swapped here has to sit inside one backend to test what it claims.
    """
    _directory_album(
        client,
        tmp_path,
        "tuned",
        encoder_spec="open-clip:ViT-B-32/laion2b_s34b_b79k",
        min_search_score=0.35,
    )

    # `name` carried so this pins the family logic alone, not the separate
    # fix that made an omitted name patchable.
    response = client.post(
        "/update_album/",
        json={
            "key": "tuned",
            "name": "Tuned",
            "encoder_spec": "open-clip:ViT-L-14/dfn2b_s39b",
        },
    )
    assert response.status_code == 200
    assert get_config_manager().get_album("tuned").min_search_score == pytest.approx(0.35)


def test_a_hand_tuned_score_is_re_resolved_across_the_two_clip_bands(
    client, tmp_path
):
    """OpenAI CLIP -> OpenCLIP is a band change, not a model swap.

    OpenCLIP's whole distribution sits about 0.1 below OpenAI CLIP's, so a
    0.35 tuned against the latter is above nearly every match the former
    produces. Carrying it over would leave the album searching into silence,
    which is the same failure the per-encoder floors exist to prevent.
    """
    _directory_album(
        client,
        tmp_path,
        "crossband",
        encoder_spec="openai-clip:ViT-B/32",
        min_search_score=0.35,
    )

    response = client.post(
        "/update_album/",
        json={
            "key": "crossband",
            "name": "Crossband",
            "encoder_spec": "open-clip:ViT-L-14/dfn2b_s39b",
        },
    )
    assert response.status_code == 200
    album = get_config_manager().get_album("crossband")
    assert album.min_search_score == pytest.approx(0.1)


def test_name_is_patchable_like_every_other_field(client, tmp_path):
    """The endpoint documents "a key the payload does not carry keeps its
    current value"; name was read straight out of the payload, so omitting it
    raised a KeyError that surfaced as a 500 whose detail was the word
    "name"."""
    _directory_album(client, tmp_path, "namekeep")

    response = client.post(
        "/update_album/", json={"key": "namekeep", "min_search_score": 0.3}
    )
    assert response.status_code == 200
    album = get_config_manager().get_album("namekeep")
    assert album.name == "Namekeep"
    assert album.min_search_score == pytest.approx(0.3)


@pytest.mark.parametrize(
    "payload",
    [
        {"key": "ghost", "name": "Ghost"},
        {"key": "ghost"},
        {
            "key": "ghost",
            "name": "Ghost",
            "image_paths": ["/tmp/ghost"],
            "index": "/tmp/ghost/i.npz",
        },
    ],
    ids=["partial", "key-only", "complete"],
)
def test_updating_a_missing_album_is_always_a_404(client, payload):
    """It used to depend on the payload: a complete one reached the failed
    write and got a 404, a partial one died in create_album and got a 500.
    There is nothing to patch either way."""
    response = client.post("/update_album/", json=payload)
    assert response.status_code == 404
    assert get_config_manager().get_album("ghost") is None


def test_the_token_cache_is_invalidated_only_once_the_change_is_stored(
    client, monkeypatch
):
    """Order matters: the cache key is (url, username), so the password is
    not part of it.

    Invalidating before the write leaves a window in which any request that
    reads the album — an index scan, a board delete — logs in with the *old*
    password and re-caches a token that then outlives the change by up to a
    day, which is exactly what this invalidation exists to prevent.
    """
    from photomap.backend import invokeai_client
    from photomap.backend.routers import album as album_router

    assert client.post("/add_album/", json=_board_album_payload()).status_code == 201
    try:
        order = []

        def record_invalidate():
            order.append("invalidate")

        real_update = album_router.config_manager.update_album

        def record_update(album):
            order.append("write")
            return real_update(album)

        monkeypatch.setattr(
            invokeai_client, "_invalidate_token_cache", record_invalidate
        )
        monkeypatch.setattr(album_router.config_manager, "update_album", record_update)

        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "invokeai_password": None,
            },
        )
        assert response.status_code == 200
        assert order == ["write", "invalidate"]
    finally:
        client.delete("/delete_album/board_album")


def test_the_token_cache_is_left_alone_when_credentials_did_not_change(
    client, monkeypatch
):
    """Every album edit would otherwise force a fresh login on the next
    InvokeAI call, for a rename."""
    from photomap.backend import invokeai_client

    assert client.post("/add_album/", json=_board_album_payload()).status_code == 201
    try:
        calls = []
        monkeypatch.setattr(
            invokeai_client, "_invalidate_token_cache", lambda: calls.append(1)
        )

        response = client.post(
            "/update_album/", json={"key": "board_album", "name": "Renamed"}
        )
        assert response.status_code == 200
        assert calls == []
    finally:
        client.delete("/delete_album/board_album")


@pytest.mark.parametrize(
    "paths_for",
    [
        lambda root: list(reversed(_derived_board_paths(root))),
        lambda root: _derived_board_paths(root)[:1],
        lambda root: _derived_board_paths(root)[1:],
    ],
    ids=["reordered", "images-only", "videos-only"],
)
def test_echoing_part_of_a_board_albums_paths_is_not_a_change(client, paths_for):
    """The guard asks whether the caller is requesting a *change*.

    Order carries no meaning here, and the derived list has grown — board
    albums gained an ``outputs/videos`` directory — so a client holding a
    snapshot from before that sends one path where the album now has two.
    Neither is asking for anything, and both used to be refused.
    """
    assert client.post("/add_album/", json=_board_album_payload()).status_code == 201
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "image_paths": paths_for("/srv/invokeai"),
            },
        )
        assert response.status_code == 200, response.text
        # Still derived from the root, whatever the caller echoed.
        assert get_config_manager().get_album("board_album").image_paths == (
            _derived_board_paths("/srv/invokeai")
        )
    finally:
        client.delete("/delete_album/board_album")


def test_a_board_album_still_refuses_a_directory_it_does_not_derive(client):
    """The tolerance above must not become "anything goes": a genuinely new
    directory is still refused out loud rather than silently ignored."""
    assert client.post("/add_album/", json=_board_album_payload()).status_code == 201
    try:
        response = client.post(
            "/update_album/",
            json={
                "key": "board_album",
                "name": "Board Album",
                "image_paths": _derived_board_paths("/srv/invokeai") + ["/srv/elsewhere"],
            },
        )
        assert response.status_code == 400
        assert "InvokeAI root" in response.json()["detail"]
    finally:
        client.delete("/delete_album/board_album")
