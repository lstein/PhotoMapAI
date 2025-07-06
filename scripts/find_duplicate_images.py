#!/usr/bin/env python3
# filepath: /home/lstein/Projects/ImageMatch/src/find_all_black.py

import os
import sys
import hashlib
import xxhash
from tqdm import tqdm

def find_duplicate_images(root_dir):
    """
    Finds and prints groups of duplicate image files in the directory tree.
    For each hash, prints the hash and all filepaths with that hash (if more than one).
    Shows a tqdm progress bar.
    """
    exts = {'.png', '.PNG', '.jpg', '.JPG', '.jpeg', '.JPEG'}
    hashes = {}

    # First, collect all candidate file paths
    file_paths = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            ext = os.path.splitext(fname)[1]
            if ext in exts:
                file_paths.append(os.path.join(dirpath, fname))

    # Now process with progress bar
    for fpath in tqdm(file_paths, desc="Hashing images"):
        try:
            with open(fpath, 'rb') as f:
                file_hash = xxhash.xxh64(f.read()).hexdigest()
            hashes.setdefault(file_hash, []).append(fpath)
        except Exception:
            continue  # Skip unreadable files

    for file_hash, paths in sorted(hashes.items()):
        if len(paths) > 1:
            print(file_hash)
            for p in sorted(paths):
                print(p)
            print()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <root_directory>")
        sys.exit(1)
    find_duplicate_images(sys.argv[1])