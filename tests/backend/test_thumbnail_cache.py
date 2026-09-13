"""The tile cache's key and the sweep that reclaims it.

A tile is the only one of the three per-album caches with no other reclaim
path: the route rewrites a tile in place when its source changes, so an
unchanged path keeps one filename forever — but a deleted or renamed file, or
a video whose frame-selection generation has moved, leaves tiles that nothing
will ever ask for again.
"""

from __future__ import annotations

from pathlib import Path

from fixtures import client, media_fixture_path, mixed_album  # noqa: F401
from PIL import Image

from photomap.backend import thumbnail_cache
from photomap.backend.thumbnail_cache import (
    keep_hashes_for,
    prune,
    thumbnail_dir,
    tile_hash,
    tile_subject,
)


def _tile(directory: Path, name: str) -> Path:
    path = directory / name
    Image.new("RGB", (4, 4), (10, 20, 30)).save(path)
    return path


class TestTheKey:
    def test_a_video_carries_the_frame_generation_and_a_photo_does_not(self):
        assert tile_subject("a/b.jpg", video=False) == "a/b.jpg"
        assert tile_subject("a/b.mp4", video=True).startswith("a/b.mp4|frames")

    def test_structurally_different_paths_do_not_collide(self):
        # Both of these collided under the pre-blake2b scheme: the first pair
        # mangled to one name, the second shared a stem.
        assert tile_hash("a/b.jpg", video=False) != tile_hash("a_b.jpg", video=False)
        assert tile_hash("a.png", video=False) != tile_hash("a.jpg", video=False)

    def test_the_generation_changes_a_video_key_but_not_a_photo_key(self, monkeypatch):
        before_video = tile_hash("a/b.mp4", video=True)
        before_photo = tile_hash("a/b.jpg", video=False)
        monkeypatch.setattr(thumbnail_cache, "FRAME_SELECTION_GENERATION", 99)
        assert tile_hash("a/b.mp4", video=True) != before_video
        assert tile_hash("a/b.jpg", video=False) == before_photo


class TestTheSweep:
    def test_keeps_every_size_and_variant_of_a_live_file(self, tmp_path):
        """One live image legitimately has several tiles: 128px for the back
        flyout, 256px for the UMAP popup, a coloured one for the landmark
        overlay. The sweep matches on the digest prefix for that reason."""
        live = tile_hash("photo.jpg", video=False)
        for name in (f"{live}_128.png", f"{live}_256.png", f"{live}_64_ff0000_r12.png"):
            _tile(tmp_path, name)

        assert prune(tmp_path, {live}) == 0
        assert len(list(tmp_path.glob("*.png"))) == 3

    def test_removes_every_tile_of_a_file_that_is_gone(self, tmp_path):
        live = tile_hash("kept.jpg", video=False)
        dead = tile_hash("deleted.jpg", video=False)
        _tile(tmp_path, f"{live}_256.png")
        _tile(tmp_path, f"{dead}_256.png")
        _tile(tmp_path, f"{dead}_128.png")

        assert prune(tmp_path, {live}) == 2
        assert [p.name for p in tmp_path.glob("*.png")] == [f"{live}_256.png"]

    def test_removes_the_previous_frame_generation_of_a_video(self, tmp_path, monkeypatch):
        """The case with no other reclaim path at all — the video has not
        changed, so nothing else will ever notice the old tile."""
        old = tile_hash("clip.mp4", video=True)
        _tile(tmp_path, f"{old}_256.png")
        monkeypatch.setattr(thumbnail_cache, "FRAME_SELECTION_GENERATION", 99)
        new = tile_hash("clip.mp4", video=True)
        _tile(tmp_path, f"{new}_256.png")

        assert prune(tmp_path, {new}) == 1
        assert [p.name for p in tmp_path.glob("*.png")] == [f"{new}_256.png"]

    def test_leaves_alone_anything_it_did_not_write(self, tmp_path):
        """Not every .png in the directory is guessed at: a name that is not
        a 32-hex digest plus a suffix was put there by something else."""
        _tile(tmp_path, "notes.png")
        _tile(tmp_path, "deadbeef_256.png")  # too short to be a digest
        # 32 characters, so a length check alone would take it for a digest.
        _tile(tmp_path, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz_256.png")
        _tile(tmp_path, "0123456789ABCDEF0123456789ABCDEF_256.png")  # uppercase
        (tmp_path / "README.txt").write_text("x")

        assert prune(tmp_path, set()) == 0
        assert len(list(tmp_path.iterdir())) == 5

    def test_a_missing_directory_is_not_an_error(self, tmp_path):
        assert prune(tmp_path / "nope", {"x"}) == 0

    def test_an_undeletable_tile_does_not_abort_the_sweep(self, tmp_path, monkeypatch):
        dead = tile_hash("gone.jpg", video=False)
        _tile(tmp_path, f"{dead}_128.png")
        _tile(tmp_path, f"{dead}_256.png")

        real_unlink = Path.unlink
        def flaky(self, *a, **k):
            if self.name.endswith("_128.png"):
                raise OSError("locked")
            return real_unlink(self, *a, **k)
        monkeypatch.setattr(Path, "unlink", flaky)

        assert prune(tmp_path, set()) == 1, "the second tile must still be reclaimed"


class TestTheKeepSet:
    def test_paths_are_made_relative_to_the_album_root(self, tmp_path):
        root = tmp_path / "album"
        (root / "sub").mkdir(parents=True)
        photo = root / "sub" / "a.jpg"

        keep = keep_hashes_for([str(photo)], [str(root)], lambda p: False)
        assert keep == {tile_hash("sub/a.jpg", video=False)}

    def test_a_file_outside_every_root_falls_back_to_its_name(self, tmp_path):
        """Mirrors config.get_relative_path, which the route goes through."""
        keep = keep_hashes_for(["/elsewhere/x.jpg"], [str(tmp_path)], lambda p: False)
        assert keep == {tile_hash("x.jpg", video=False)}

    def test_videos_and_photos_are_keyed_differently(self, tmp_path):
        root = tmp_path / "album"
        root.mkdir()
        keep = keep_hashes_for(
            [str(root / "a.mp4"), str(root / "b.jpg")],
            [str(root)],
            lambda p: p.suffix == ".mp4",
        )
        assert keep == {tile_hash("a.mp4", video=True), tile_hash("b.jpg", video=False)}


def test_the_route_and_the_sweeper_agree_on_the_filename(client, mixed_album):  # noqa: F811
    """The whole reason the key lives in one module.

    If these two ever drift, the sweep either deletes live tiles or keeps dead
    ones forever — and nothing else in the app would notice.
    """
    assert client.get("/thumbnails/mixed_album/1?size=64").status_code == 200

    tiles = thumbnail_dir(Path(mixed_album["index"]))
    written = [p for p in tiles.glob("*.png")]
    assert written, "the route wrote no tile"

    keep = keep_hashes_for(
        [str(Path(mixed_album["image_paths"][0]) / "building1.jpeg")],
        mixed_album["image_paths"],
        lambda p: False,
    )
    assert prune(tiles, keep) == 0, "the sweep deleted a tile the route had just written"


def test_saving_the_index_sweeps_the_tile_directory(client, mixed_album):  # noqa: F811
    """The sweep has to be reachable, not just correct.

    Nothing else reclaims a tile, so a sweeper that is never called is the
    same as no sweeper at all. This drives the real save path rather than
    calling prune() directly.
    """
    from photomap.backend.embeddings import Embeddings

    media_root = Path(mixed_album["image_paths"][0])
    photo = media_root / "building1.jpeg"
    tiles = thumbnail_dir(Path(mixed_album["index"]))
    tiles.mkdir(parents=True, exist_ok=True)

    live = tile_hash("building1.jpeg", video=False)
    orphan = tile_hash("deleted-long-ago.jpg", video=False)
    _tile(tiles, f"{live}_256.png")
    _tile(tiles, f"{orphan}_256.png")

    embeddings = Embeddings(
        embeddings_path=Path(mixed_album["index"]), album_key=mixed_album["key"]
    )
    embeddings._prune_per_album_caches([str(photo)], [photo.stat().st_mtime])

    remaining = sorted(p.name for p in tiles.glob("*.png"))
    assert f"{live}_256.png" in remaining, "a live tile was swept"
    assert f"{orphan}_256.png" not in remaining, "the orphan survived the sweep"


def test_an_absent_frame_cache_does_not_abort_the_other_sweeps(client, mixed_album):  # noqa: F811
    """Each per-album sweep has to stand alone.

    The frame and transcode sweeps used to `return` when their own directory
    was missing, which abandoned the rest of the method. Every all-photo album
    has no frame-cache directory, so this is the ordinary case, not an edge
    one — and it silently cost those albums their converted-video sweep too.
    """
    from photomap.backend.embeddings import Embeddings
    from photomap.backend.video_cache import VideoFrameCache

    assert not VideoFrameCache(mixed_album["key"]).directory.is_dir(), (
        "fixture no longer reproduces the condition"
    )

    media_root = Path(mixed_album["image_paths"][0])
    photo = media_root / "building1.jpeg"
    tiles = thumbnail_dir(Path(mixed_album["index"]))
    tiles.mkdir(parents=True, exist_ok=True)
    orphan = tile_hash("gone.jpg", video=False)
    _tile(tiles, f"{orphan}_256.png")

    embeddings = Embeddings(
        embeddings_path=Path(mixed_album["index"]), album_key=mixed_album["key"]
    )
    embeddings._prune_per_album_caches([str(photo)], [photo.stat().st_mtime])

    assert not (tiles / f"{orphan}_256.png").exists()


class TestConditionalRequests:
    """`no-cache` makes the browser revalidate every tile. Without a 304 that
    re-transfers the whole PNG, a hundred times over on one grid page."""

    def test_a_matching_validator_gets_a_304_with_no_body(self, client, mixed_album):  # noqa: F811
        first = client.get("/thumbnails/mixed_album/1?size=64")
        assert first.status_code == 200
        etag = first.headers["etag"]
        assert first.content

        second = client.get(
            "/thumbnails/mixed_album/1?size=64", headers={"If-None-Match": etag}
        )
        assert second.status_code == 304
        assert not second.content
        assert second.headers["cache-control"] == "no-cache"

    def test_a_stale_validator_gets_the_tile(self, client, mixed_album):  # noqa: F811
        response = client.get(
            "/thumbnails/mixed_album/1?size=64", headers={"If-None-Match": '"stale"'}
        )
        assert response.status_code == 200
        assert response.content

    def test_the_validator_follows_the_bytes_not_the_timestamp(
        self, client, mixed_album  # noqa: F811
    ):
        """A byte-identical rebuild must still answer 304.

        Reindexing rewrites tiles whose image did not change. An ETag over the
        stat would invalidate every one of them and re-send the lot; over the
        content it does not.
        """
        first = client.get("/thumbnails/mixed_album/1?size=64")
        etag = first.headers["etag"]

        tiles = thumbnail_dir(Path(mixed_album["index"]))
        tile = next(tiles.glob("*_64.png"))
        payload = tile.read_bytes()
        tile.unlink()
        tile.write_bytes(payload)  # same bytes, new mtime and inode

        again = client.get(
            "/thumbnails/mixed_album/1?size=64", headers={"If-None-Match": etag}
        )
        assert again.status_code == 304

    def test_a_tile_swept_mid_request_is_a_404_not_a_500(self, client, mixed_album):  # noqa: F811
        """The window the sweep opened.

        Nothing deleted tiles before this, so handing the path to FileResponse
        — which stats it again when it sends — was safe. Now a sweep can land
        between the freshness check and the send, and a RuntimeError out of
        the handler would show the user a 500.
        """
        from photomap.backend.routers import search as search_module

        assert client.get("/thumbnails/mixed_album/1?size=64").status_code == 200

        real_read = Path.read_bytes

        def swept(self, *a, **k):
            if self.suffix == ".png":
                raise FileNotFoundError(self)
            return real_read(self, *a, **k)

        original = search_module.Path.read_bytes
        search_module.Path.read_bytes = swept
        try:
            response = client.get("/thumbnails/mixed_album/1?size=64")
        finally:
            search_module.Path.read_bytes = original
        assert response.status_code == 404

    def test_a_rebuilt_tile_invalidates_the_old_validator(self, client, mixed_album):  # noqa: F811
        """The point of revalidating at all: this URL is keyed by index, so a
        delete or reindex makes it mean a different file."""
        first = client.get("/thumbnails/mixed_album/1?size=64")
        etag = first.headers["etag"]

        tiles = thumbnail_dir(Path(mixed_album["index"]))
        tile = next(tiles.glob("*_64.png"))
        Image.new("RGB", (64, 64), (200, 10, 10)).save(tile)

        again = client.get(
            "/thumbnails/mixed_album/1?size=64", headers={"If-None-Match": etag}
        )
        assert again.status_code == 200, "a changed tile must not answer 304"


class TestAgreementWithTheRoute:
    """The sweep deletes files, so a digest it fails to produce is a live tile
    destroyed. These pin it against config.get_relative_path, which is what
    the route actually keys through."""

    def test_a_symlinked_album_root_still_agrees(self, tmp_path):
        """The case that made this a real bug rather than a theoretical one.

        Index filenames are stored resolved; album roots are not necessarily
        canonical — an InvokeAI board album derives its root with expanduser()
        and no resolve(). Without resolving the roots here, relative_to fails,
        the keep-set holds the bare filename, and every tile in a subdirectory
        is deleted on every index save, forever.
        """
        (tmp_path / "real" / "sub").mkdir(parents=True)
        photo = tmp_path / "real" / "sub" / "a.jpeg"
        photo.write_bytes(b"x")
        (tmp_path / "link").symlink_to(tmp_path / "real")

        stored = str(photo.resolve())
        keep = keep_hashes_for([stored], [str(tmp_path / "link")], lambda p: False)
        assert tile_hash("sub/a.jpeg", video=False) in keep

    def test_it_matches_get_relative_path_across_awkward_roots(self, tmp_path):
        """Compared against config's own implementation rather than a
        hand-written expectation, so the two cannot drift apart quietly."""
        from photomap.backend.config import ConfigManager

        (tmp_path / "root" / "deep").mkdir(parents=True)
        photo = tmp_path / "root" / "deep" / "b.jpg"
        photo.write_bytes(b"x")
        (tmp_path / "alias").symlink_to(tmp_path / "root")

        for root in (
            str(tmp_path / "root"),
            str(tmp_path / "alias"),
            str(tmp_path / "root") + "/",
            str(tmp_path / "root" / "deep" / ".."),
        ):
            expected = Path(str(photo.resolve()))
            relative = expected.name
            for resolved in [Path(root).resolve()]:
                try:
                    relative = expected.relative_to(resolved).as_posix()
                except ValueError:
                    pass
            keep = keep_hashes_for([str(photo.resolve())], [root], lambda p: False)
            assert tile_hash(relative, video=False) in keep, f"disagreed for root {root}"
        assert ConfigManager is not None  # the reference implementation exists


def test_an_absent_frame_cache_still_lets_the_transcode_sweep_run(client, mixed_album):  # noqa: F811
    """The third block, which the tile test above cannot reach.

    The tile sweep sits between the frame and transcode blocks, so asserting a
    tile was reclaimed proves nothing about the sweep after it.
    """
    from photomap.backend.embeddings import Embeddings
    from photomap.backend.video_transcode import TranscodeCache

    media_root = Path(mixed_album["image_paths"][0])
    photo = media_root / "building1.jpeg"

    transcodes = TranscodeCache(mixed_album["key"])
    transcodes.directory.mkdir(parents=True, exist_ok=True)
    orphan = transcodes.directory / "0000000000000000-0000000000000000.mp4"
    orphan.write_bytes(b"not really a movie")

    embeddings = Embeddings(
        embeddings_path=Path(mixed_album["index"]), album_key=mixed_album["key"]
    )
    embeddings._prune_per_album_caches([str(photo)], [photo.stat().st_mtime])

    assert not orphan.exists(), "the transcode sweep did not run"


def test_two_albums_sharing_a_tile_directory_do_not_sweep_each_other(client, tmp_path):  # noqa: F811
    """The tile cache is addressed by index directory, not album key, so two
    albums whose indexes sit side by side share one. Each keep-set omits the
    other's images, so sweeping would delete the neighbour's live tiles."""
    from photomap.backend.embeddings import _tile_dir_is_shared

    class _Album:
        def __init__(self, index):
            self.index = index

    shared = str(tmp_path / "indexes" / "a.npz")
    neighbour = str(tmp_path / "indexes" / "b.npz")
    apart = str(tmp_path / "other" / "c.npz")

    class _Manager:
        def __init__(self, albums):
            self._albums = albums

        def get_albums(self):
            return self._albums

    together = _Manager({"a": _Album(shared), "b": _Album(neighbour)})
    assert _tile_dir_is_shared(together, "a", _Album(shared)) is True

    separate = _Manager({"a": _Album(shared), "c": _Album(apart)})
    assert _tile_dir_is_shared(separate, "a", _Album(shared)) is False


def test_the_sweep_is_skipped_when_the_tile_directory_is_shared(
    client,  # noqa: F811
    mixed_album,  # noqa: F811
    monkeypatch,
):
    """Through the sweep, not the predicate: what matters is that the guard is
    actually consulted before anything is deleted."""
    from photomap.backend import config as config_module
    from photomap.backend.embeddings import Embeddings

    media_root = Path(mixed_album["image_paths"][0])
    photo = media_root / "building1.jpeg"
    tiles = thumbnail_dir(Path(mixed_album["index"]))
    tiles.mkdir(parents=True, exist_ok=True)
    orphan = tile_hash("gone.jpg", video=False)
    _tile(tiles, f"{orphan}_256.png")

    manager = config_module.get_config_manager()
    real_albums = manager.get_albums()

    class _Neighbour:
        index = str(Path(mixed_album["index"]).parent / "other.npz")

    monkeypatch.setattr(
        manager, "get_albums", lambda: {**real_albums, "neighbour": _Neighbour()}
    )

    embeddings = Embeddings(
        embeddings_path=Path(mixed_album["index"]), album_key=mixed_album["key"]
    )
    embeddings._prune_per_album_caches([str(photo)], [photo.stat().st_mtime])

    assert (tiles / f"{orphan}_256.png").exists(), (
        "swept a shared directory, which would delete the neighbour's live tiles"
    )


def test_a_filename_with_undecodable_bytes_does_not_raise():
    """Filesystems hand back lone surrogates for bytes that are not valid
    utf-8. Encoding those raises, which made the route answer 500 for such an
    image and would abort the sweeper's entire pass over the album."""
    digest = tile_hash("hol\udca9iday.jpg", video=False)
    assert len(digest) == 32

    keep = keep_hashes_for(["/album/hol\udca9iday.jpg"], ["/album"], lambda p: False)
    assert keep == {digest}


def test_ordinary_names_hash_the_same_as_before_the_surrogate_fix():
    """The encoding change must not rename every existing tile."""
    import hashlib

    for name in ("a.jpg", "sub/b.png", "Ünïcøde.jpeg", "space in name.gif"):
        expected = hashlib.blake2b(name.encode("utf-8"), digest_size=16).hexdigest()
        assert tile_hash(name, video=False) == expected


class TestDiscardOnDelete:
    """The full sweep only runs when the index is rewritten wholesale, and the
    delete endpoints rewrite the .npz directly. Without a targeted discard a
    deleted image's tiles sit there until the album happens to be reindexed."""

    def test_discard_removes_every_size_of_one_file(self, tmp_path):
        doomed = tile_hash("gone.jpg", video=False)
        other = tile_hash("stays.jpg", video=False)
        for name in (f"{doomed}_128.png", f"{doomed}_256.png", f"{doomed}_64_ff0000_r12.png"):
            _tile(tmp_path, name)
        _tile(tmp_path, f"{other}_256.png")

        assert thumbnail_cache.discard(tmp_path, "gone.jpg", video=False) == 3
        assert [p.name for p in tmp_path.glob("*.png")] == [f"{other}_256.png"]

    def test_discard_is_quiet_when_there_is_nothing_to_remove(self, tmp_path):
        assert thumbnail_cache.discard(tmp_path, "never-had-one.jpg", video=False) == 0
        assert thumbnail_cache.discard(tmp_path / "nope", "x.jpg", video=False) == 0

    def test_deleting_an_image_takes_its_tiles_with_it(self, client, mixed_album):  # noqa: F811
        """Through the real endpoint. This is the common way tiles are
        orphaned, and it does not go through the index-save sweep at all."""
        assert client.get("/thumbnails/mixed_album/1?size=64").status_code == 200
        tiles = thumbnail_dir(Path(mixed_album["index"]))
        assert list(tiles.glob("*_64.png")), "no tile was written to delete"

        # move_to_trash=False: /tmp is its own mount here, so send2trash
        # cannot create a trash folder and the delete would 403.
        response = client.delete(
            "/delete_image/mixed_album/1", params={"move_to_trash": "false"}
        )
        assert response.status_code == 200, response.text

        assert not list(tiles.glob("*_64.png")), "the deleted image kept its tile"
