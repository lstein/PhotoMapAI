"""Delete the static ffmpeg binary that imageio-ffmpeg bundles in its wheel.

That binary is a GPLv3 build, and publishing it inside a Docker image would
make the image a GPLv3 distribution with source obligations for the exact
build (see THIRD_PARTY_LICENSES.txt and docs/docker.md). The images therefore
ship without ffmpeg; PhotoMapAI skips videos with a warning when none is found,
and users who want video can add a distribution ffmpeg in a derived image.

Run in the same RUN step as ``pip install`` — deleting it in a later layer
would leave it in the earlier one. Fails the build if nothing was found, so a
change to imageio-ffmpeg's package layout can't silently put it back.
"""

import sys
from pathlib import Path

import imageio_ffmpeg

bin_dir = Path(imageio_ffmpeg.__file__).parent / "binaries"
binaries = [p for p in bin_dir.iterdir() if p.is_file() and p.name.startswith("ffmpeg")]
if not binaries:
    sys.exit(f"No bundled ffmpeg found in {bin_dir}; has imageio-ffmpeg's layout changed?")
for p in binaries:
    print(f"Removing bundled ffmpeg: {p}")
    p.unlink()
