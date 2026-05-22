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
