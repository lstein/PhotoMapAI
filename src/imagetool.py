#!/usr/bin/env python
# image indexing and retrieval using CLIP

import os
import sys
from pathlib import Path

from image_search import index_images, search_images

def do_index():
    import argparse

    parser = argparse.ArgumentParser(description="Index and search images using CLIP.")
    parser.add_argument(
        "--index", nargs="+", 
        type=Path,
        help="Paths to images or a directory to index."
    )
    parser.add_argument(
        "--embeddings",
        type=str,
        default="clip_image_embeddings.npz",
        help="Output file for indexed embeddings.",
    )
    parser.add_argument(
        "--top_k", type=int, default=5, help="Number of top similar images to return."
    )
    # Additional arguments are specify the image files or directories to Index.
    parser.add_argument(
        "image_paths",
        nargs="+",
        type=Path,
        help="Paths to images or a directory to index. If a directory is provided, all images in that directory will be indexed.",
    )

    args = parser.parse_args()
    # If a single argument is given and it's a directory, treat as directory
    if len(args.image_paths) == 1 and os.path.isdir(args.image_paths[0]):
        index_images(args.image_paths[0], args.embeddings)
    else:
        index_images(args.image_paths, args.embeddings)


def do_search():
    import argparse

    parser = argparse.ArgumentParser(description="Search images using CLIP.")
    parser.add_argument("search", 
                        type=Path, 
                        help="Path to query image for searching.")
    parser.add_argument(
        "--embeddings",
        type=str,
        default="clip_image_embeddings.npz",
        help="File containing indexed embeddings and filenames.",
    )
    parser.add_argument(
        "--top_k", type=int, default=5, help="Number of top similar images to return."
    )

    args = parser.parse_args()

    results, scores = search_images(args.search, args.embeddings, args.top_k)
    print("Top similar images:")
    for filename, score in zip(results, scores):
        print(f"{filename}: {score:.4f}")


def main():
    if Path(sys.argv[0]).name == "index_images":
        do_index()
    elif Path(sys.argv[0]).name == "search_images":
        do_search()
    else:
        print("Usage: index_images or search_images")
        print(
            "Run 'index_images --help' or 'search_images --help' for more information."
        )


if __name__ == "__main__":
    main()
