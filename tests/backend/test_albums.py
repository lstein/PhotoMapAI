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
    assert response.json() == {"success": True, "eps": 0.50}

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
    threshold than CLIP), CLIP-style albums default to 0.2.
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
        assert album.image_paths == [
            str(Path("/srv/invokeai") / "outputs" / "images")
        ]
        assert album.index == default_board_index_path("board_album").as_posix()
        assert album.invokeai_board_ids == ["b1", "none"]
        assert album.invokeai_password == "secret"
    finally:
        client.delete("/delete_album/board_album")


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
