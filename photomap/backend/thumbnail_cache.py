"""The reduced tiles served by ``/thumbnails``, and the sweep that reclaims them.

A tile is a shrunk copy of an image — or, for a video, of the still extracted
from it — cached beside the album's index. Its filename is a digest of the
image's album-relative path plus the size (and, for the UMAP landmark overlay,
a colour and corner radius), so one source file can have several live tiles.

The key logic lives here rather than in the route because the sweeper has to
compute exactly the same digest the route does. Two copies of that rule would
drift the first time either changed, and the failure would be silent: the
sweeper would delete live tiles, or keep dead ones forever.
"""

import hashlib
import logging
import re
from pathlib import Path

from .video import FRAME_SELECTION_GENERATION

logger = logging.getLogger("photomap")

THUMBNAIL_DIRNAME = "thumbnails"

# What tile_hash emits: blake2b-128, rendered lowercase.
_DIGEST_RE = re.compile(r"[0-9a-f]{32}")


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
    for entry in entries:
        if entry.suffix != ".png":
            continue
        # "<32 lowercase hex digits>_<size>[...]"; anything else was not
        # written by the route and is left alone rather than guessed at. The
        # hex check is part of that promise: a 32-character stem is not
        # necessarily a digest, and this code deletes files.
        digest = entry.stem.split("_", 1)[0]
        if not _DIGEST_RE.fullmatch(digest) or digest in keep_hashes:
            continue
        try:
            entry.unlink()
            removed += 1
        except OSError as e:
            logger.debug(f"Could not remove stale tile {entry}: {e}")
    return removed


def discard(directory: Path, relative_path: str, *, video: bool) -> int:
    """Remove every tile of one source file, whatever size or colour.

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
    for entry in directory.glob(f"{digest}_*.png"):
        try:
            entry.unlink()
            removed += 1
        except OSError as e:
            logger.debug(f"Could not remove tile {entry}: {e}")
    return removed


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
