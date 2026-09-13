"""Audit an album's thumbnail-tile cache. Read-only unless asked otherwise.

Every tile under ``<index dir>/thumbnails/`` falls into one of three buckets:

* **live** — the route would still serve it.
* **orphaned** — written by the current naming scheme, but its source file is
  gone, renamed, or is a video whose frame-selection generation has moved.
  This is what the sweep at index save reclaims, and what ``--prune`` does.
* **old scheme** — named before tiles were keyed by digest, when the filename
  was the image's path with the separators mangled. Nothing reclaims these:
  the sweep only deletes names it recognises as its own, deliberately, because
  it must never delete a file it did not write. ``--prune-legacy`` removes
  them, and is opt-in for that reason. On a long-lived library they are
  usually the bulk of the directory.

Reclaiming without reindexing: the sweep only runs when the index is written,
and an "Update" that finds no added or removed files is a true no-op, so an
album that has merely accumulated orphans cannot reach it short of adding or
deleting a file. ``--prune`` runs the same sweep directly.

The agreement check is the other half of this tool. The sweeper reproduces the
digest the route keys tiles by, rather than calling into the route, so that it
can resolve each album root once instead of once per image. If the two ever
disagree the sweep stops reclaiming dead tiles and starts deleting live ones —
so the check compares them on real files, and pruning refuses to run when it
fails.

Usage:
    python scripts/tile_audit.py                    # audit everything
    python scripts/tile_audit.py ALBUM_KEY          # audit one album
    python scripts/tile_audit.py --prune            # reclaim orphans
    python scripts/tile_audit.py --prune-legacy     # also reclaim old-scheme
"""



import re
import sys
from pathlib import Path

import numpy as np

from photomap.backend.config import get_config_manager
from photomap.backend.media_types import is_video
from photomap.backend.thumbnail_cache import (
    keep_hashes_for,
    prune,
    thumbnail_dir,
    tile_hash,
)

SAMPLE_SIZE = 5

# What tile_hash emits, and therefore what the sweep recognises as its own.
_DIGEST_RE = re.compile(r"[0-9a-f]{32}")


def _album_filenames(index_path: str) -> list[str] | None:
    try:
        with np.load(index_path, allow_pickle=True) as data:
            return [str(name) for name in data["filenames"]]
    except Exception as e:  # a half-written or absent index is not fatal here
        print(f"    could not read the index: {e}")
        return None


def _verdict(orphan_ratio: float) -> str:
    if orphan_ratio > 95:
        return "!! route and sweeper disagree — do not reindex until checked"
    if orphan_ratio > 40:
        return "?  high, but normal if never swept or the video generation moved"
    return "ok"


def _shared_tile_dirs(manager) -> set[Path]:
    """Tile directories more than one album writes into.

    The sweep skips these: each album's keep-set omits the other's images, so
    sweeping would delete the neighbour's live tiles.
    """
    seen: dict[Path, int] = {}
    for album in manager.get_albums().values():
        if album.index:
            directory = thumbnail_dir(Path(album.index))
            seen[directory] = seen.get(directory, 0) + 1
    return {directory for directory, count in seen.items() if count > 1}


def main(only: str | None, do_prune: bool, do_legacy: bool) -> int:
    manager = get_config_manager()
    total_tiles = total_orphans = total_bytes = 0
    total_legacy = total_legacy_bytes = 0
    disagreements = []
    shared = _shared_tile_dirs(manager)
    prunable: list[tuple[str, Path, set[str], list[Path]]] = []

    header = (
        f"{'album':22s} {'tiles':>8s} {'live':>8s} {'orphan':>8s} "
        f"{'oldname':>8s}  verdict"
    )
    print(header)
    print("-" * len(header))

    for key, album in manager.get_albums().items():
        if (only and key != only) or not album.index:
            continue
        tiles_dir = thumbnail_dir(Path(album.index))
        if not tiles_dir.is_dir():
            continue
        tiles = list(tiles_dir.glob("*.png"))
        if not tiles:
            continue

        filenames = _album_filenames(album.index)
        if filenames is None:
            continue

        keep = keep_hashes_for(filenames, album.image_paths, is_video)
        live, orphans, legacy = [], [], []
        for tile in tiles:
            digest = tile.stem.split("_", 1)[0]
            if not _DIGEST_RE.fullmatch(digest):
                legacy.append(tile)
            elif digest in keep:
                live.append(tile)
            else:
                orphans.append(tile)

        # Measured against the tiles the sweep can actually see: counting the
        # old-scheme files here would report a disagreement on every
        # long-lived album, where they are most of the directory.
        known = len(live) + len(orphans)
        ratio = 100.0 * len(orphans) / known if known else 0.0
        print(
            f"{key:22s} {len(tiles):>8,d} {len(live):>8,d} {len(orphans):>8,d} "
            f"{len(legacy):>8,d} {_verdict(ratio)}"
        )

        total_tiles += len(tiles)
        total_orphans += len(orphans)
        total_legacy += len(legacy)
        total_bytes += sum(t.stat().st_size for t in orphans)
        total_legacy_bytes += sum(t.stat().st_size for t in legacy)
        if tiles_dir not in shared:
            prunable.append((key, tiles_dir, keep, legacy))

        # The agreement check: the route's own digest for a real file has to
        # be in the keep set, or the sweep would delete that file's tiles.
        sample = filenames[:: max(1, len(filenames) // SAMPLE_SIZE)][:SAMPLE_SIZE]
        for name in sample:
            relative = manager.get_relative_path(name, key)
            if relative is None:
                continue
            if tile_hash(relative, video=is_video(Path(name))) not in keep:
                disagreements.append(key)
                break

    if not total_tiles:
        print("no tiles cached yet" + (f" for album '{only}'" if only else ""))
        return 0

    print(
        f"\n{total_tiles:,} tiles: {total_tiles - total_orphans - total_legacy:,} live, "
        f"{total_orphans:,} orphaned ({total_bytes / 1024 / 1024:.0f} MB), "
        f"{total_legacy:,} old-scheme ({total_legacy_bytes / 1024 / 1024:.0f} MB)"
    )
    if total_orphans:
        print("  orphans are reclaimed at the next index save, or now with --prune")
    if total_legacy:
        print("  old-scheme tiles are reclaimed by nothing; --prune-legacy removes them")

    if disagreements:
        print(
            "\n!! The route and the sweeper disagree for: "
            + ", ".join(sorted(set(disagreements)))
            + "\n   Live tiles would be deleted at the next index save. Do not"
            "\n   reindex these albums until the keep-set derivation is fixed."
        )
        return 1
    print("route and sweeper agree on every album sampled")

    if do_prune or do_legacy:
        print()
        reclaimed = 0
        for key, tiles_dir, keep, legacy in prunable:
            removed = prune(tiles_dir, keep) if do_prune else 0
            if do_legacy:
                for tile in legacy:
                    try:
                        tile.unlink()
                        removed += 1
                    except OSError as e:
                        print(f"    could not remove {tile.name}: {e}")
            if removed:
                print(f"  {key:22s} removed {removed:,}")
            reclaimed += removed
        if shared:
            print(f"  skipped {len(shared)} shared tile director(ies)")
        print(f"\nreclaimed {reclaimed:,} tiles")
    return 0


if __name__ == "__main__":
    flags = {"--prune", "--prune-legacy"}
    positional = [a for a in sys.argv[1:] if a not in flags]
    unknown = [a for a in sys.argv[1:] if a.startswith("-") and a not in flags]
    if unknown:
        print(f"unknown option(s): {' '.join(unknown)}\n\n{__doc__}")
        sys.exit(2)
    sys.exit(
        main(
            positional[0] if positional else None,
            "--prune" in sys.argv[1:] or "--prune-legacy" in sys.argv[1:],
            "--prune-legacy" in sys.argv[1:],
        )
    )
