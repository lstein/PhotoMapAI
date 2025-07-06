#!/usr/bin/env python3
# filepath: /home/lstein/Projects/ImageMatch/src/find_all_black.py

import sys
from pathlib import Path
from PIL import Image

def is_all_black(image_path):
    """
    Returns True if the image is all black (all RGB channels are 0 for all pixels).
    """
    try:
        with Image.open(image_path) as img:
            img = img.convert("RGB")
            extrema = img.getextrema()  # [(min, max), (min, max), (min, max)]
            return all(min == 0 and max == 0 for min, max in extrema)
    except Exception:
        return False  # Skip unreadable files

def find_all_black_images(root_dir):
    root = Path(root_dir)
    for path in root.rglob("*.png"):
        if is_all_black(path):
            print(path)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <root_directory>")
        sys.exit(1)
    find_all_black_images(sys.argv[1])