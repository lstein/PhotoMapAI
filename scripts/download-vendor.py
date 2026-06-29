#!/usr/bin/env python3
"""Download vendor JS/CSS files for offline use.

Run this script once to populate photomap/frontend/static/vendor/ with the
bundled versions of Swiper and Plotly. After running, commit the generated
files so the app works without an internet connection.

Usage:
    python scripts/download-vendor.py
"""

import urllib.request
from pathlib import Path

VENDOR_DIR = Path(__file__).parent.parent / "photomap" / "frontend" / "static" / "vendor"

VENDOR_FILES = [
    (
        "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css",
        "swiper-bundle.min.css",
    ),
    (
        "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js",
        "swiper-bundle.min.js",
    ),
    (
        "https://cdn.plot.ly/plotly-3.0.1.min.js",
        "plotly.min.js",
    ),
]


def main() -> None:
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    for url, filename in VENDOR_FILES:
        dest = VENDOR_DIR / filename
        print(f"Downloading {filename} ...", end=" ", flush=True)
        urllib.request.urlretrieve(url, dest)
        size_kb = dest.stat().st_size / 1024
        print(f"{size_kb:.1f} KB")
    print("Done — vendor assets ready.")


if __name__ == "__main__":
    main()
