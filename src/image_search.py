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

def get_image_files_from_directory(
    directory, exts={".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"}
):
    """
    Recursively collect all image files from a directory.
    """
    image_files = []
    for root, _, files in os.walk(directory):
        for file in files:
            if os.path.splitext(file)[1].lower() in exts:
                image_files.append(os.path.join(root, file))
    return image_files


def index_images(image_paths_or_dir: list[Path] | Path, output_file="clip_image_embeddings.npz"):
    """
    Index images using CLIP and save their embeddings.

    Args:
        image_paths_or_dir (list of str or str): List of image paths or a directory path.
        output_file (str): File to save the embeddings and filenames.
    """
    # Accept either a directory or a list of image paths
    if isinstance(image_paths_or_dir, Path) and image_paths_or_dir.is_dir():
        image_paths = get_image_files_from_directory(image_paths_or_dir)
    elif (
        isinstance(image_paths_or_dir, list)
        and len(image_paths_or_dir) == 1
        and image_paths_or_dir[0]
    ):
        image_paths = get_image_files_from_directory(image_paths_or_dir[0])
    else:
        image_paths = image_paths_or_dir

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
            filenames.append(image_path)
        except Exception as e:
            print(f"Error processing {image_path}: {e}")

    embeddings = np.array(embeddings)
    filenames = np.array(filenames)

    # Save embeddings and filenames
    np.savez(output_file, embeddings=embeddings, filenames=filenames)
    print(f"Indexed {len(embeddings)} images and saved to {output_file}")


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