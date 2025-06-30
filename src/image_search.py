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

from typing import Optional

def get_image_files_from_directory(
    directory, exts={".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}
) -> list[Path]:
    """
    Recursively collect all image files from a directory.
    """
    image_files = []
    for root, _, files in os.walk(directory):
        for file in files:
            if os.path.splitext(file)[1].lower() in exts:
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
                 output_file: Optional[str]="clip_image_embeddings.npz") -> tuple[np.ndarray, np.ndarray]:
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

    embeddings = np.array(embeddings)
    filenames = np.array(filenames)

    # Save embeddings and filenames
    if output_file:
        np.savez(output_file, embeddings=embeddings, filenames=filenames)
        print(f"Indexed {len(embeddings)} images and saved to {output_file}")

    return embeddings, filenames

def update_embeddings(
    image_paths_or_dir: list[Path] | Path, embeddings_file="clip_image_embeddings.npz"
) -> tuple[np.ndarray, np.ndarray]:
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
    if not new_image_paths:
        print("No new images to index. Existing embeddings are up-to-date.")
        return  

    # Index new images
    new_embeddings, new_filenames = index_images(list(new_image_paths), output_file=None)

    # Combine existing and new embeddings
    updated_embeddings = np.vstack((existing_embeddings, new_embeddings))
    updated_filenames = np.concatenate((existing_filenames, new_filenames))

    # Save updated embeddings and filenames
    np.savez(embeddings_file, embeddings=updated_embeddings, filenames=updated_filenames)
    print(f"Updated embeddings saved to {embeddings_file}")

    return updated_embeddings, updated_filenames

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