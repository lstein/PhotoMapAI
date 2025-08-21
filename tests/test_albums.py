"""
test_albums.py
Tests for the albums functionality of the PhotoMap application.
"""
from fixtures import client
from pathlib import Path
from photomap.backend.config import create_album, get_config_manager, Album

def test_config():
    manager = get_config_manager()
    print(manager.get_albums())
    assert manager is not None
    assert manager.validate_config() is True
    assert manager.has_albums() is False
    assert manager.is_first_run() is True
    assert manager.get_albums() == {}

def test_add_delete_album():
    manager = get_config_manager()
    album = create_album('test_album',
                         'Test Album',
                         image_paths=['./tests/test_images'],
                         index='./tests/test_images/embeddings.npz',
                         umap_eps=0.1,
                         description='A test album',
                         )
    manager.add_album(album)
    try:
        assert manager.has_albums() is True
        assert album.key in manager.get_albums()
        assert Path(album.index).resolve().as_posix() == Path('./tests/test_images', 'embeddings.npz').resolve().as_posix()
        assert Path('./tests/test_images').resolve().as_posix() in [Path(x).resolve().as_posix() for x in album.image_paths]
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
    new_album = create_album('test_album',
                 'Test Album',
                 image_paths=['./tests/test_images'],
                 index='./tests/test_images/embeddings.npz',
                 umap_eps=0.1,
                 description='A test album',
                 )
    response = client.post("/add_album", json=new_album.model_dump())
    assert response.status_code == 201
    assert response.json() == {"success": True, "message": "Album 'test_album' added successfully"}
 
    # Check if the album is now available
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 1
    assert albums[0]['name'] == 'Test Album'
    album = Album.from_dict(data=albums[0], key=albums[0]['key'])
    assert album.key == 'test_album'
    assert album.name == 'Test Album'
    assert [Path(x).resolve().as_posix() for x in album.image_paths] == [Path('./tests/test_images').resolve().as_posix()]
    assert Path(album.index).resolve().as_posix() == Path('./tests/test_images', 'embeddings.npz').resolve().as_posix()
    assert album.umap_eps == 0.1
    assert album.description == 'A test album'

    # Check that we can update the album
    updated_album = album.model_dump()
    updated_album['name'] = 'Updated Test Album'
    response = client.post("/update_album", json=updated_album)
    assert response.status_code == 200
    assert response.json() == {"success": True, "message": "Album 'test_album' updated successfully"}

    # Check that the album was updated
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 1
    assert albums[0]['name'] == 'Updated Test Album'

    # Check the EPS get/set functionality
    from photomap.backend.routers.album import UmapEpsSetRequest  # delay import to avoid early initialization of config manager
    response = client.post("/set_umap_eps", json=UmapEpsSetRequest(eps=0.50, album=album.key).model_dump())
    assert response.status_code == 200
    assert response.json() == {"success": True, "eps": 0.50}
    response = client.post("/get_umap_eps", json={"album": album.key})
    assert response.status_code == 200
    assert response.json() == {"success": True, "eps": 0.50}

    # Check that we can delete the album
    response = client.delete(f"/delete_album/{album.key}")
    assert response.status_code == 200
    assert response.json() == {"success": True, "message": "Album 'test_album' deleted successfully"}

    # Check that the album is no longer available
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 0

