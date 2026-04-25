"""Image-extension allowlist on the file-serving endpoints.

``add_album`` accepts arbitrary absolute ``image_paths``; without an
extension guard a caller could point an album at, say, ``/etc`` and
then ``GET /images/<key>/passwd`` to read any file the server user can
open.  These tests lock down both ``serve_image`` and
``get_image_by_name`` so only files with a known image suffix can be
served.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


def _add_album(client: TestClient, key: str, image_path: Path, index_path: Path) -> None:
    """Create an album pointing at an arbitrary directory (no indexing)."""
    response = client.post(
        "/add_album/",
        json={
            "key": key,
            "name": "chain",
            "image_paths": [image_path.as_posix()],
            "index": index_path.as_posix(),
            "umap_eps": 0.1,
            "description": "",
        },
    )
    assert response.status_code == 201, response.text


def test_serve_image_rejects_non_image_extension(client, tmp_path):
    """The add_album → serve_image arbitrary-file-read chain is closed."""
    secret_dir = tmp_path / "secrets"
    secret_dir.mkdir()
    secret_file = secret_dir / "passwd"
    secret_file.write_text("root:x:0:0:/root:/bin/bash\n")

    try:
        _add_album(
            client,
            "chain_album",
            secret_dir,
            tmp_path / "chain.npz",
        )

        # Even though the file exists and is inside the configured album
        # path, its extension is not in the allowlist — so the request is
        # refused rather than the raw file being returned.
        response = client.get("/images/chain_album/passwd")
        assert response.status_code == 403, response.text
        assert "unsupported" in response.json()["detail"].lower()

        # And a file with a disallowed ``.txt`` extension is refused even
        # when the path looks innocent.
        (secret_dir / "notes.txt").write_text("nothing interesting")
        response = client.get("/images/chain_album/notes.txt")
        assert response.status_code == 403
    finally:
        client.delete("/delete_album/chain_album")


def test_image_by_name_rejects_non_image_extension(client, tmp_path):
    """Defense-in-depth: ``get_image_by_name`` also refuses non-image suffixes."""
    secret_dir = tmp_path / "secrets2"
    secret_dir.mkdir()
    (secret_dir / "passwd").write_text("fake")
    try:
        _add_album(
            client, "name_album", secret_dir, tmp_path / "name.npz"
        )
        response = client.get("/image_by_name/name_album/passwd")
        assert response.status_code == 403
    finally:
        client.delete("/delete_album/name_album")
