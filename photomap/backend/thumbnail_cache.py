"""The reduced tiles served by ``/thumbnails``, and the sweep that reclaims them.

A tile is a shrunk copy of an image — or, for a video, of the still extracted
from it — cached beside the album's index. Its filename is a digest of the
image's album-relative path plus the size (and, for the UMAP landmark overlay,
a colour and corner radius), so one source file can have several live tiles.

The same directory holds the *display copies* ``/images/`` serves in place of
a TIFF or HEIC the browser cannot render: one screen-sized JPEG (or WebP, when
the image has transparency) per source file, named with the same digest so the
sweep and the per-file discard cover them without a second keep-set.

The key logic lives here rather than in the route because the sweeper has to
compute exactly the same digest the route does. Two copies of that rule would
drift the first time either changed, and the failure would be silent: the
sweeper would delete live tiles, or keep dead ones forever.
"""

import hashlib
import logging
import re
import time
from pathlib import Path

from .video import FRAME_SELECTION_GENERATION

logger = logging.getLogger("photomap")

THUMBNAIL_DIRNAME = "thumbnails"

# Exactly the names the routes write, with the tile_hash digest (blake2b-128,
# lowercase) captured: PNG tiles "<digest>_<size>[_<colour>_r<radius>].png",
# display copies "<digest>_display_<album tag>_<stamp>.<jpg|webp>", and the
# temporaries a display copy is written through. Anything else was not written
# by this code and is left alone rather than guessed at — this code deletes
# files, and a directory beside a custom index path may hold the user's own
# hash-named photos.
_OWNED_NAME_RE = re.compile(
    r"(?P<digest>[0-9a-f]{32})"
    r"(?:_\d+(?:_[0-9A-Fa-f,]+_r\d+)?\.png"
    r"|_display_[0-9a-f]{8}_[0-9a-f]{12}\.(?:jpg|webp)"
    r"|_display_[0-9a-f]{8}\.[^/]+\.tmp)"
)


def _owned_digest(name: str) -> str | None:
    match = _OWNED_NAME_RE.fullmatch(name)
    return match["digest"] if match else None

# A temporary is only ever live for the length of one conversion. One older
# than this belongs to a writer that crashed or was killed, and is swept even
# when its source image still exists.
_STALE_TMP_SECONDS = 3600.0


def thumbnail_dir(index_path: Path | str) -> Path:
    """The tile directory for an album with its index at ``index_path``."""
    return Path(index_path).parent / THUMBNAIL_DIRNAME


def tile_subject(relative_path: str, *, video: bool) -> str:
    """The string a tile's filename digests.

    A video's tile is built from its extracted still rather than from pixels
    of its own, so it also has to be invalidated when a new release picks a
    *different* frame out of the same unchanged file — the freshness check in
    the route compares the tile against the video's own mtime, which does not
    move when that happens.
    """
    if video:
        return f"{relative_path}|frames{FRAME_SELECTION_GENERATION}"
    return relative_path


def tile_hash(relative_path: str, *, video: bool) -> str:
    """The filename prefix shared by every tile of one source file.

    Hashes the whole relative path, extension included, so structurally
    different paths cannot collapse onto one filename: ``/a/b.jpg`` and
    ``/a_b.jpg`` mangled to the same name under the old scheme, and ``a.png``
    collided with ``a.jpg`` on stem alone. Both were observable cache
    poisoning. blake2b-128 makes a collision effectively impossible.
    """
    subject = tile_subject(relative_path, video=video)
    # surrogateescape, not plain utf-8: a filename whose bytes are not valid
    # utf-8 reaches Python as lone surrogates, and encoding those raises. The
    # route hashed the same way and so answered 500 for any such image; the
    # sweeper would abort its whole pass. Normal names encode identically, so
    # no existing tile changes its name.
    return hashlib.blake2b(
        subject.encode("utf-8", "surrogateescape"), digest_size=16
    ).hexdigest()


def display_copy_stem(directory: Path, relative_path: str, album_key: str) -> Path:
    """The common prefix of every display copy of one TIFF/HEIC in one album.

    The route appends a stamp of the source's mtime and size and a format
    suffix (``.jpg``, or ``.webp`` for an image with transparency). Keyed with
    :func:`tile_hash` so :func:`prune` and :func:`discard` reclaim it along
    with the file's tiles — a separate digest would need its own keep-set,
    and the sweep would delete every display copy if the two ever disagreed.

    The album key rides along because the directory is addressed by index
    location, not album: two albums whose index files sit side by side share
    it, and camera filenames collide routinely, so without it one album's
    ``IMG_0001.tif`` would be shown in place of the other's.
    """
    album_tag = hashlib.blake2b(album_key.encode("utf-8", "surrogateescape"), digest_size=4).hexdigest()
    return directory / f"{tile_hash(relative_path, video=False)}_display_{album_tag}"


def prune(directory: Path, keep_hashes: set[str]) -> int:
    """Delete every tile whose source file is no longer in ``keep_hashes``.

    Matches on the digest prefix, not the whole filename, because the size,
    colour and radius that follow it are per-request: one live image can have
    a 128px tile for the back flyout, a 256px one for the UMAP popup and a
    coloured one for the landmark overlay, and all three are legitimate.

    This is the only thing that reclaims a tile. The freshness check in the
    route rewrites a tile in place when its source changes, so an unchanged
    path keeps one filename forever — but a *deleted* file, a renamed one, or
    a video whose frame-selection generation has moved leaves its tiles with
    no path that will ever ask for them again.

    Returns the number removed. Failures only waste disk, so they are logged
    rather than raised.
    """
    if not directory.is_dir():
        return 0
    try:
        entries = list(directory.iterdir())
    except OSError as e:
        logger.warning(f"Could not sweep the thumbnail cache {directory}: {e}")
        return 0

    removed = 0
    now = time.time()
    for entry in entries:
        digest = _owned_digest(entry.name)
        if digest is None:
            continue
        if digest in keep_hashes and not _is_abandoned_tmp(entry, now):
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError as e:
            logger.debug(f"Could not remove stale tile {entry}: {e}")
    return removed


def discard(directory: Path, relative_path: str, *, video: bool) -> int:
    """Remove every tile of one source file, whatever size or colour, and its
    display copy.

    The counterpart to :func:`prune` for a single deletion. The full sweep
    only runs when the index is rewritten wholesale, and the delete endpoints
    rewrite the .npz directly rather than going through that path — so
    without this, deleting an image left its tiles behind until the next time
    the album was reindexed, which may be never.

    Returns the number removed. Failures only waste disk, so they are logged.
    """
    if not directory.is_dir():
        return 0
    digest = tile_hash(relative_path, video=video)
    removed = 0
    for entry in directory.glob(f"{digest}_*"):
        if _owned_digest(entry.name) != digest:
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError as e:
            logger.debug(f"Could not remove tile {entry}: {e}")
    return removed


def _is_abandoned_tmp(entry: Path, now: float) -> bool:
    if entry.suffix != ".tmp":
        return False
    try:
        return now - entry.stat().st_mtime > _STALE_TMP_SECONDS
    except OSError:
        return False


def keep_hashes_for(filenames, image_roots, is_video) -> set[str]:
    """Every tile digest the album's current contents can legitimately ask for.

    Mirrors ``config.get_relative_path``, which is what the route keys tiles
    through, and must agree with it exactly: a digest this function fails to
    produce is a live tile the sweep deletes. That means resolving the roots
    (config does) and *not* resolving the file (config does not — and the
    index stores resolved paths already), and falling back to the bare
    filename for a file under no root, as config does.

    The roots are resolved once here rather than per call as config does it:
    that is one filesystem round trip per root per image on an album that can
    hold six figures of them, which is the only reason this is not simply a
    call to ``get_relative_path``.

    Getting the resolve wrong is not a near miss. An album root that is a
    symlink — every InvokeAI board album whose root traverses one — put every
    subdirectory's tiles outside the keep set, so the sweep deleted all of
    them on every index save, forever.
    """
    roots = [Path(root).resolve() for root in image_roots]
    keep: set[str] = set()
    for name in filenames:
        path = Path(str(name))
        relative = path.name  # what get_relative_path falls back to
        for root in roots:
            try:
                relative = path.relative_to(root).as_posix()
                break
            except ValueError:
                continue
        keep.add(tile_hash(relative, video=is_video(path)))
    return keep
