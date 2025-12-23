#!/usr/bin/env python
# image indexing and retrieval using CLIP

import os
import sys
from pathlib import Path

from .embeddings import Embeddings

def do_index():
    import argparse

    parser = argparse.ArgumentParser(description="Index and search images using CLIP.")
    parser.add_argument(
        "--embeddings",
        type=str,
        default="clip_image_embeddings.npz",
        help="Output file for indexed embeddings.",
    )
    parser.add_argument(
        '--print_bad_files',
        action='store_true',
        help="Print the list of files that failed to process during indexing.",
    )

    # Additional arguments are specify the image files or directories to Index.
    parser.add_argument(
        "image_paths",
        nargs="+",
        type=Path,
        help="Paths to images or a directory to index. If a directory is provided, all images in that directory will be indexed.",
    )

    args = parser.parse_args()
    embeddings = Embeddings(embeddings_path=args.embeddings)

    # If a single argument is given and it's a directory, treat as directory
    if len(args.image_paths) == 1 and os.path.isdir(args.image_paths[0]):
        index_results = embeddings.create_index(args.image_paths[0])
    else:
        index_results = embeddings.create_index(args.image_paths)
    if args.print_bad_files and index_results.bad_files:
        print("Failed to process the following files:")
        for f in index_results.bad_files:
            print(f)

def do_update_images():
    import argparse

    parser = argparse.ArgumentParser(description="Update the CLIP search index.")
    parser.add_argument(
        "--embeddings",
        type=str,
        default="clip_image_embeddings.npz",
        help="Output file for indexed embeddings.",
    )
    parser.add_argument(
        '--print_bad_files',
        action='store_true',
        help="Print the list of files that failed to process during indexing.",
    )
    # Additional arguments are specify the image files or directories to Index.
    parser.add_argument(
        "image_paths",
        nargs="+",
        type=Path,
        help="Paths to images or a directory to index. If a directory is provided, all images in that directory will be indexed.",
    )  

    args = parser.parse_args()
    # raise an exception of args.embeddings does not exist
    if not os.path.exists(args.embeddings):
        raise FileNotFoundError(f"Embeddings file '{args.embeddings}' does not exist. Please index images first.")  

    embeddings = Embeddings(embeddings_path=args.embeddings)

    # If a single argument is given and it's a directory, treat as directory
    if len(args.image_paths) == 1 and os.path.isdir(args.image_paths[0]):
       index_results = embeddings.update_index(args.image_paths[0])
    else:
        index_results = embeddings.update_index(args.image_paths)
    if args.print_bad_files and index_results.bad_files:
        print("Failed to process the following files:")
        for f in index_results.bad_files:
            print(f)

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
    embeddings = Embeddings(embeddings_path=args.embeddings)

    results, scores = embeddings.search_images_by_text_and_image(query_image_path=args.search, 
                                                                 top_k=args.top_k)
    print("Top similar images:")
    for filename, score in zip(results, scores):
        print(f"{filename}: {score:.4f}")


def do_text_search():
    import argparse

    parser = argparse.ArgumentParser(description="Search images using CLIP and a text query.")
    parser.add_argument("query", 
                        type=str, 
                        help="Text query for searching images.")
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
    embeddings = Embeddings(embeddings_path=args.embeddings)

    results, scores = embeddings.search_images_by_text_and_image(positive_query=args.query, 
                                                                 top_k=args.top_k)
    print("Top similar images for query:")
    for filename, score in zip(results, scores):
        print(f"{filename}: {score:.4f}")

def do_duplicate_search():
    import argparse

    parser = argparse.ArgumentParser(description="Find duplicate images in a directory.")
    parser.add_argument(
        "embeddings",
        type=str,
        default="clip_image_embeddings.npz",
        help="File containing indexed embeddings and filenames.",
    )

    args = parser.parse_args()
    embeddings = Embeddings(embeddings_path=args.embeddings)

    # find_similar_images_fast(args.embeddings)
    embeddings.find_duplicate_clusters()

def main():
    prog = Path(sys.argv[0]).name
    if prog == "index_images":
        do_index()
    elif prog == "search_images":
        do_search()
    elif prog == "search_text":
        do_text_search()
    elif prog == "update_images"    :
        do_update_images()
    elif prog == "find_duplicate_images":
        do_duplicate_search()

    else:
        print("Usage: index_images, search_images, or search_text")
        print(
            "Run 'index_images --help', 'search_images --help', or 'search_text --help' for more information."
        )


if __name__ == "__main__":
    main()
