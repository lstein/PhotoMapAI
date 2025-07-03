'''
image_search.py

Implement CLIP indexing and searching for images using the CLIP model.
This script provides functionality to index images from a directory or a list of image paths,
and to search for similar images using a query image. It uses the CLIP model from Hugging Face's Transformers library
for image embeddings and similarity calculations.
'''
from pathlib import Path

import os
import clip
import numpy as np
import torch
from PIL import Image
from tqdm import tqdm  
from sklearn.neighbors import NearestNeighbors
import networkx as nx

from typing import Optional

MINIMUM_IMAGE_SIZE = 100 * 1024  # Minimum image size in bytes (100K)

def get_image_files_from_directory(
    directory, exts={".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}
) -> list[Path]:
    """
    Recursively collect all image files from a directory.
    """
    image_files = []
    for root, _, files in os.walk(directory):
        for file in files:
            # Check if the file has a valid image extension
            # and that it's length is > MINIMUM_IMAGE_SIZE (i.e. not a thumbnail) 
            if os.path.splitext(file)[1].lower() in exts and os.path.getsize(Path(root, file)) > MINIMUM_IMAGE_SIZE:
                image_files.append(Path(root, file).resolve())
    return image_files

def get_image_files(image_paths_or_dir: list[Path] | Path) -> list[Path]:
    """
    Get a list of image file paths from a directory or a list of image paths.

    Args:
        image_paths_or_dir (list of str or str): List of image paths or a directory path.

    Returns:
        list of Path: List of image file paths.
    """
    if isinstance(image_paths_or_dir, Path):
        # If it's a single Path object, treat it as a directory
        return get_image_files_from_directory(image_paths_or_dir)
    elif isinstance(image_paths_or_dir, list):
        # If it's a list, filter out non-image files
        return [Path(p).resolve() for p in image_paths_or_dir if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}]
    else:
        raise ValueError("Input must be a Path object or a list of Paths.")

def index_images(image_paths_or_dir: list[Path] | Path, 
                 output_file: Optional[str]="clip_image_embeddings.npz") -> tuple[np.ndarray, np.ndarray, list[Path]]:
    """
    Index images using CLIP and save their embeddings.

    Args:
        image_paths_or_dir (list of str or str): List of image paths or a directory path.
        output_file (str): File to save the embeddings and filenames.
    """
    # Accept either a directory or a list of image paths
    image_paths = get_image_files(image_paths_or_dir)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, preprocess = clip.load("ViT-B/32", device=device)

    embeddings = []
    filenames = []
    bad_files = []  # List to store files that failed to process

    # Ensure image_paths is a list of paths (strings)
    if isinstance(image_paths, Path):
        image_paths = [image_paths]

    for image_path in tqdm(image_paths, desc="Indexing images"):
        try:
            image = (
                preprocess(Image.open(image_path).convert("RGB"))
                .unsqueeze(0)  # type: ignore
                .to(device)
            )
            with torch.no_grad():
                embedding = model.encode_image(image).cpu().numpy().flatten()
            embeddings.append(embedding)
            filenames.append(image_path.resolve().as_posix())  # Store the full path as a string
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            # add failed image to a list for debugging
            bad_files.append(image_path)

    embeddings = np.array(embeddings)
    filenames = np.array(filenames)

    # Save embeddings and filenames
    if output_file:
        np.savez(output_file, embeddings=embeddings, filenames=filenames)
        print(f"Indexed {len(embeddings)} images and saved to {output_file}")

    return embeddings, filenames, bad_files

def update_embeddings(
    image_paths_or_dir: list[Path] | Path, embeddings_file="clip_image_embeddings.npz"
) -> tuple[np.ndarray, np.ndarray, list[Path]]:
    """
    Update existing embeddings with new images.

    Args:
        image_paths_or_dir (list of str or str): List of image paths or a directory path.
        embeddings_file (str): File containing existing embeddings and filenames.
    """
    # Load existing embeddings and filenames
    data = np.load(embeddings_file, allow_pickle=True)
    existing_embeddings = data["embeddings"]  # shape: (N, 512)
    existing_filenames = data["filenames"]  # shape: (N,)

    # Get the image paths in the provided paths or directory, and identify the paths not already in existing_filenames
    image_path_set = set(get_image_files(image_paths_or_dir))
    existing_filenames_set = set(Path(p) for p in existing_filenames)
    new_image_paths = image_path_set - existing_filenames_set
    
    # find images that have been indexed but no longer exist
    missing_image_paths = existing_filenames_set - image_path_set

    if missing_image_paths:
        # remove missing images from existing embeddings
        print(f"Removing {len(missing_image_paths)} missing images from existing embeddings.")
        existing_embeddings = np.array([
            emb for emb, fname in zip(existing_embeddings, existing_filenames)
            if Path(fname) not in missing_image_paths
        ])
        existing_filenames = np.array([
            fname for fname in existing_filenames
            if Path(fname) not in missing_image_paths
        ])

    if not new_image_paths:
        print("No new images to index. Existing embeddings are up-to-date.")
        np.savez(embeddings_file, embeddings=existing_embeddings, filenames=existing_filenames)
        return existing_embeddings, existing_filenames, []

    # Index new images
    new_embeddings, new_filenames, bad_files = index_images(list(new_image_paths), output_file=None)

    if new_embeddings.shape[0] == 0:
        print("No new images were indexed (possibly all failed to process).")
        np.savez(embeddings_file, embeddings=existing_embeddings, filenames=existing_filenames)
        return existing_embeddings, existing_filenames, bad_files

    # Combine existing and new embeddings
    updated_embeddings = np.vstack((existing_embeddings, new_embeddings))
    updated_filenames = np.concatenate((existing_filenames, new_filenames))

    # Save updated embeddings and filenames
    np.savez(embeddings_file, embeddings=updated_embeddings, filenames=updated_filenames)
    print(f"Updated embeddings saved to {embeddings_file}")

    return updated_embeddings, updated_filenames, bad_files

def search_images(
    query_image_path: Path, embeddings_file="clip_image_embeddings.npz", top_k=5
):
    """
    Search for similar images using a query image.

    Args:
        query_image_path (str): Path to the query image.
        embeddings_file (str): File containing indexed embeddings and filenames.
        top_k (int): Number of top similar images to return.
    """
    # Load the saved embeddings and filenames
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]  # shape: (N, 512)
    filenames = data["filenames"]  # shape: (N,)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, preprocess = clip.load("ViT-B/32", device=device)

    # Load and preprocess the query image
    query_image = (
        preprocess(Image.open(query_image_path).convert("RGB")).unsqueeze(0).to(device)  # type: ignore
    )

    # Encode the query image
    with torch.no_grad():
        query_embedding = model.encode_image(query_image).cpu().numpy().flatten()

    # Normalize embeddings for cosine similarity
    def normalize(x):
        return x / np.linalg.norm(x, axis=-1, keepdims=True)

    embeddings_norm = normalize(embeddings)
    query_embedding_norm = normalize(query_embedding)

    # Compute cosine similarity
    similarities = embeddings_norm @ query_embedding_norm

    # Get top K most similar images
    top_indices = similarities.argsort()[-top_k:][::-1]

    return filenames[top_indices], similarities[top_indices]


def search_images_by_text(
    text_query: str, embeddings_file="clip_image_embeddings.npz", top_k=5
):
    """
    Search for similar images using a natural language text query.

    Args:
        text_query (str): The text query to search for.
        embeddings_file (str): File containing indexed embeddings and filenames.
        top_k (int): Number of top similar images to return.
    """
    # Load the saved embeddings and filenames
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]  # shape: (N, 512)
    filenames = data["filenames"]  # shape: (N,)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model, preprocess = clip.load("ViT-B/32", device=device)

    # Encode the text query
    with torch.no_grad():
        text_tokens = clip.tokenize([text_query]).to(device)
        text_embedding = model.encode_text(text_tokens).cpu().numpy().flatten()

    # Normalize embeddings for cosine similarity
    def normalize(x):
        return x / np.linalg.norm(x, axis=-1, keepdims=True)

    embeddings_norm = normalize(embeddings)
    text_embedding_norm = normalize(text_embedding)

    # Compute cosine similarity
    similarities = embeddings_norm @ text_embedding_norm

    # Get top K most similar images
    top_indices = similarities.argsort()[-top_k:][::-1]

    return filenames[top_indices], similarities[top_indices]

def find_similar_images_by_embedding(embeddings_file, similarity_threshold=0.98):
    """
    Find and print pairs of images with cosine similarity above the threshold.
    """
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]
    filenames = data["filenames"]

    # Normalize embeddings
    norm_embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)

    # Compute cosine similarity matrix
    sim_matrix = np.dot(norm_embeddings, norm_embeddings.T)

    n = len(filenames)
    reported = set()
    for i in range(n):
        for j in range(i + 1, n):
            if sim_matrix[i, j] >= similarity_threshold:
                pair = tuple(sorted((filenames[i], filenames[j])))
                if pair not in reported:
                    print(f"{sim_matrix[i, j]:.4f}")
                    print(filenames[i])
                    print(filenames[j])
                    print()
                    reported.add(pair)

def find_similar_images_fast(embeddings_file, similarity_threshold=0.98):
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]
    filenames = data["filenames"]

    # Normalize embeddings
    norm_embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)

    # Use NearestNeighbors with cosine metric (1 - cosine similarity)
    nn = NearestNeighbors(metric='cosine', algorithm='brute')
    nn.fit(norm_embeddings)
    # radius = 1 - similarity_threshold (since cosine distance = 1 - cosine similarity)
    radius = 1 - similarity_threshold
    distances, indices = nn.radius_neighbors(norm_embeddings, radius=radius)

    reported = set()
    for i, (dists, nbrs) in enumerate(zip(distances, indices)):
        for dist, j in zip(dists, nbrs):
            if i < j:  # avoid duplicates and self-match
                sim = 1 - dist
                pair = tuple(sorted((filenames[i], filenames[j])))
                if pair not in reported:
                    print(f"{sim:.4f}")
                    print(filenames[i])
                    print(filenames[j])
                    print()
                    reported.add(pair)

def find_similar_images_gpu(embeddings_file, similarity_threshold=0.98):
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]
    filenames = data["filenames"]

    # Move to GPU
    device = "cuda" if torch.cuda.is_available() else "cpu"
    emb = torch.tensor(embeddings, dtype=torch.float32, device=device)
    emb = torch.nn.functional.normalize(emb, dim=1)

    # Compute cosine similarity matrix on GPU
    sim_matrix = emb @ emb.T

    n = len(filenames)
    reported = set()
    sim_matrix = sim_matrix.cpu().numpy()
    for i in range(n):
        for j in range(i + 1, n):
            if sim_matrix[i, j] >= similarity_threshold:
                pair = tuple(sorted((filenames[i], filenames[j])))
                if pair not in reported:
                    print(f"{sim_matrix[i, j]:.4f}")
                    print(filenames[i])
                    print(filenames[j])
                    print()
                    reported.add(pair)

def find_duplicate_clusters(embeddings_file, similarity_threshold=0.99):
    data = np.load(embeddings_file, allow_pickle=True)
    embeddings = data["embeddings"]
    filenames = data["filenames"]

    # Normalize embeddings
    norm_embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)

    # Use NearestNeighbors with cosine metric
    nn = NearestNeighbors(metric='cosine', algorithm='brute')
    nn.fit(norm_embeddings)
    radius = 1 - similarity_threshold
    distances, indices = nn.radius_neighbors(norm_embeddings, radius=radius)

    # Build the graph
    G = nx.Graph()
    for i, nbrs in enumerate(indices):
        for j in nbrs:
            if i < j:  # avoid self and duplicate edges
                G.add_edge(filenames[i], filenames[j])

    # Find clusters (connected components)
    clusters = list(nx.connected_components(G))
    for idx, cluster in enumerate(clusters, 1):
        print(f"Cluster {idx}:")
        for fname in sorted(cluster):
            print(fname)
        print()