#!/usr/bin/env python
# image indexing and retrieval using CLIP

import os
import sys
from pathlib import Path

from PIL import Image

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

    # ``search_images_by_text_and_image`` takes a *PIL Image*, not a path —
    # the prior ``query_image_path=`` kwarg name didn't exist on the
    # function and raised TypeError on every invocation. Open + decode here
    # so the CLI matches the function's actual signature.
    with Image.open(args.search) as query_image:
        results, scores = embeddings.search_images_by_text_and_image(
            query_image_data=query_image,
            top_k=args.top_k,
        )
    print("Top similar images:")
    for filename, score in zip(results, scores, strict=False):
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
    for filename, score in zip(results, scores, strict=False):
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


def do_rebuild_cluster_labels():
    import argparse

    parser = argparse.ArgumentParser(
        description="Pre-build the cluster label cache (and vocab embeddings) for an album.",
    )
    parser.add_argument(
        "--embeddings",
        type=str,
        required=True,
        help="Path to the album's .npz embeddings file.",
    )
    parser.add_argument(
        "--eps", type=float, default=0.07, help="DBSCAN eps (default: 0.07).",
    )
    parser.add_argument(
        "--min-samples", type=int, default=10, help="DBSCAN min_samples (default: 10).",
    )
    parser.add_argument(
        "--top-k", type=int, default=3,
        help="Number of candidate labels stored per cluster (default: 3).",
    )
    parser.add_argument(
        "--encoder-spec", type=str, default=None,
        help="Encoder spec override. Defaults to the spec stamped in the .npz, "
             "falling back to the legacy CLIP spec if unstamped.",
    )

    args = parser.parse_args()

    from .cluster_labels import get_or_build_cluster_labels
    from .embeddings import peek_encoder_spec
    from .encoders import LEGACY_ENCODER_SPEC

    embeddings_path = Path(args.embeddings)
    if not embeddings_path.exists():
        raise FileNotFoundError(f"Embeddings file {embeddings_path} does not exist.")

    if args.encoder_spec:
        spec = args.encoder_spec
    else:
        try:
            spec = peek_encoder_spec(embeddings_path)
        except Exception:
            spec = LEGACY_ENCODER_SPEC

    embeddings = Embeddings(embeddings_path=embeddings_path, encoder_spec=spec)

    print(f"Building cluster labels for {embeddings_path}")
    print(f"  encoder_spec: {spec}")
    print(f"  eps:          {args.eps}")
    print(f"  min_samples:  {args.min_samples}")

    labels = get_or_build_cluster_labels(
        embeddings,
        cluster_eps=args.eps,
        cluster_min_samples=args.min_samples,
        top_k=args.top_k,
    )

    print(f"Done — labels for {len(labels)} clusters.")
    for cid in sorted(labels.keys())[:5]:
        info = labels[cid]
        print(f"  cluster {cid}: {info['label']!r}  (score={info['score']:.3f})")
    if len(labels) > 5:
        print(f"  ... and {len(labels) - 5} more")


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
    elif prog == "rebuild_cluster_labels":
        do_rebuild_cluster_labels()

    else:
        print(
            "Usage: index_images, update_images, search_images, search_text, "
            "find_duplicate_images, or rebuild_cluster_labels"
        )
        print("Run any of the above with --help for more information.")


if __name__ == "__main__":
    main()
