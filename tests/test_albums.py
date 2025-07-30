"""
test_albums.py
Tests for the albums functionality of the Clipslide application.
"""
import os
import pytest
from fixtures import client

from clipslide.backend.config import create_album, get_config_manager, Album

def test_config():
    manager = get_config_manager()
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
    assert manager.has_albums() is True
    assert album.key in manager.get_albums()
    assert album.index == './tests/test_images/embeddings.npz'
    assert './tests/test_images' in album.image_paths
    manager.delete_album(album.key)
    assert album.key not in manager.get_albums()

def test_album_routes(client):
    response = client.get("/available_albums")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    albums = response.json()
    assert isinstance(albums, list)
    assert len(albums) == 0

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
    response = client.get("/available_albums")
    assert response.status_code == 200
    albums = response.json()
    assert len(albums) == 1
    print(albums)
    assert albums[0]['name'] == 'Test Album'
    album = Album.from_dict(data=albums[0], key=albums[0]['key'])
    assert album.key == 'test_album'
    assert album.name == 'Test Album'
    assert album.image_paths == ['./tests/test_images']
    assert album.index == './tests/test_images/embeddings.npz'
    assert album.umap_eps == 0.1
    assert album.description == 'A test album'   
