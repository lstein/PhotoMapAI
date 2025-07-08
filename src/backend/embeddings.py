"""
embeddings.py

Implement CLIP indexing and searching for images using the CLIP model.
This script provides functionality to index images from a directory or a list of image paths,
and to search for similar images using a query image. It uses the CLIP model from Hugging Face's Transformers library
for image embeddings and similarity calculations.
"""

import os
import clip
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from tqdm import tqdm
from sklearn.neighbors import NearestNeighbors
import networkx as nx

from typing import Optional, Set
from pathlib import Path
from pydantic import BaseModel


class Embeddings(BaseModel):
    """
    A class to handle image embeddings using CLIP.
    This class provides methods to index images, update embeddings, and search for similar images.
    """

    embeddings_path: Path = Path("clip_image_embeddings.npz")
    minimum_image_size: int = 100 * 1024  # Minimum image size in bytes (100K)

    def get_image_files_from_directory(
        self,
        directory: Path,
        exts: Set[str] = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"},
    ) -> list[Path]:
        """
        Recursively collect all image files from a directory.
        """
        image_files = []
        for root, _, files in os.walk(directory):
            for file in [Path(x) for x in files]:
                # Check if the file has a valid image extension
                # and that it's length is > minimum_image_size (i.e. not a thumbnail)
                if (
                    file.suffix.lower() in exts
                    and os.path.getsize(Path(root, file)) > self.minimum_image_size
                ):
                    image_files.append(Path(root, file).resolve())
        return image_files

    def get_image_files(self,
                        image_paths_or_dir: list[Path] | Path,
                        exts: Set[str] = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"},
                        ) -> list[Path]:
        """
        Get a list of image file paths from a directory or a list of image paths.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.

        Returns:
            list of Path: List of image file paths.
        """
        if isinstance(image_paths_or_dir, Path):
            # If it's a single Path object, treat it as a directory
            images = self.get_image_files_from_directory(image_paths_or_dir)
        elif isinstance(image_paths_or_dir, list):
            images = []
            for p in image_paths_or_dir:
                if p.is_dir():
                    images.extend(self.get_image_files_from_directory(p, exts))
                elif p.suffix.lower() in exts:
                    images.append(p)
        else:
            raise ValueError("Input must be a Path object or a list of Paths.")
        return images

    def create_index(
        self,
        image_paths_or_dir: list[Path] | Path,
        create_index: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, list[Path]]:
        """
        Index images using CLIP and save their embeddings.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            output_file (str): File to save the embeddings and filenames.
        """
        # Accept either a directory or a list of image paths
        image_paths = self.get_image_files(image_paths_or_dir)

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
                pil_image = Image.open(image_path).convert("RGB")
                pil_image = ImageOps.exif_transpose(
                    pil_image
                )  # Handle EXIF orientation
                image = preprocess(pil_image).unsqueeze(0).to(device)  # type: ignore
                with torch.no_grad():
                    embedding = model.encode_image(image).cpu().numpy().flatten()
                embeddings.append(embedding)
                filenames.append(
                    image_path.resolve().as_posix()
                )  # Store the full path as a string
            except Exception as e:
                print(f"Error processing {image_path}: {e}")
                # add failed image to a list for debugging
                bad_files.append(image_path)

        embeddings = np.array(embeddings)  # shape: (N, 512)
        filenames = np.array(filenames)  # shape: (N,)

        # Save embeddings and filenames if requested
        if create_index:
            np.savez(self.embeddings_path, embeddings=embeddings, filenames=filenames)
            print(
                f"Indexed {len(embeddings)} images and saved to {self.embeddings_path}"
            )

        return embeddings, filenames, bad_files

    def update_index(
        self, image_paths_or_dir: list[Path] | Path
    ) -> tuple[np.ndarray, np.ndarray, list[Path]]:
        """
        Update existing embeddings with new images.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            embeddings_file (str): File containing existing embeddings and filenames.
        """
        assert (
            self.embeddings_path.exists()
        ), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."

        # Load existing embeddings and filenames
        data = np.load(self.embeddings_path, allow_pickle=True)
        existing_embeddings = data["embeddings"]  # shape: (N, 512)
        existing_filenames = data["filenames"]  # shape: (N,)

        # Get the image paths in the provided paths or directory, and identify the paths not already in existing_filenames
        image_path_set = set(self.get_image_files(image_paths_or_dir))
        existing_filenames_set = set(Path(p) for p in existing_filenames)
        new_image_paths = image_path_set - existing_filenames_set

        # find images that have been indexed but no longer exist
        missing_image_paths = existing_filenames_set - image_path_set

        if missing_image_paths:
            # remove missing images from existing embeddings
            print(
                f"Removing {len(missing_image_paths)} missing images from existing embeddings."
            )
            existing_embeddings = np.array(
                [
                    emb
                    for emb, fname in zip(existing_embeddings, existing_filenames)
                    if Path(fname) not in missing_image_paths
                ]
            )
            existing_filenames = np.array(
                [
                    fname
                    for fname in existing_filenames
                    if Path(fname) not in missing_image_paths
                ]
            )

        if not new_image_paths:
            print("No new images to index. Existing embeddings are up-to-date.")
            np.savez(
                self.embeddings_path,
                embeddings=existing_embeddings,
                filenames=existing_filenames,
            )
            return existing_embeddings, existing_filenames, []

        # Index new images
        new_embeddings, new_filenames, bad_files = self.create_index(
            list(new_image_paths), create_index=False
        )

        if new_embeddings.shape[0] == 0:
            print("No new images were indexed (possibly all failed to process).")
            np.savez(
                self.embeddings_path,
                embeddings=existing_embeddings,
                filenames=existing_filenames,
            )
            return existing_embeddings, existing_filenames, bad_files

        # After removing missing images and before vstack:
        if existing_embeddings.size == 0:
            existing_embeddings = np.empty((0, new_embeddings.shape[1]), dtype=new_embeddings.dtype)

        # Combine existing and new embeddings
        updated_embeddings = np.vstack((existing_embeddings, new_embeddings))
        updated_filenames = np.concatenate((existing_filenames, new_filenames))

        # Save updated embeddings and filenames
        np.savez(
            self.embeddings_path,
            embeddings=updated_embeddings,
            filenames=updated_filenames,
        )
        print(f"Updated embeddings saved to {self.embeddings_path}")

        return updated_embeddings, updated_filenames, bad_files

    def search_images_by_similarity(
        self,
        query_image_path: Path,
        top_k: int = 5,
        minimum_score: Optional[float] = 0.6,
    ):
        """
        Search for similar images using a query image.

        Args:
            query_image_path (str): Path to the query image.
            top_k (int): Number of top similar images to return.
            minimum_score (float, optional): Minimum similarity score to consider.

        Returns:
            tuple: (filenames, similarities)
        """
        # Load the saved embeddings and filenames
        data = np.load(self.embeddings_path, allow_pickle=True)
        embeddings = data["embeddings"]  # shape: (N, 512)
        filenames = data["filenames"]  # shape: (N,)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        # Load and preprocess the query image
        pil_image = Image.open(query_image_path).convert("RGB")
        pil_image = ImageOps.exif_transpose(pil_image)
        query_image = preprocess(pil_image).unsqueeze(0).to(device)  # type: ignore

        # Encode the query image
        with torch.no_grad():
            query_embedding = model.encode_image(query_image).squeeze(
                0
            )  # shape: (512,)

        # Before normalization, convert to torch tensor
        embeddings_tensor = torch.tensor(embeddings, dtype=torch.float32, device=device)

        # Normalize embeddings and query embedding
        norm_embeddings = F.normalize(embeddings_tensor, dim=-1).to(torch.float32)
        query_embedding_norm = F.normalize(query_embedding, dim=-1).to(torch.float32)

        # Compute cosine similarity
        similarities = (
            (norm_embeddings @ query_embedding_norm).cpu().numpy()
        )  # shape: (N,)

        # Get top K most similar images
        top_indices = similarities.argsort()[-top_k:][::-1]
        if minimum_score is not None:
            # Filter results based on the minimum score
            mask = similarities[top_indices] >= minimum_score
            top_indices = top_indices[mask]
            if len(top_indices) == 0:
                return [], []

        return filenames[top_indices], similarities[top_indices]

    def search_images_by_text(
        self,
        text_query: str,
        top_k: int = 5,
        minimum_score: float = 0.2,
    ):
        """
        Search for similar images using a natural language text query.

        Args:
            text_query (str): The text query to search for.
            top_k (int): Number of top similar images to return.
            minimum_score (float): Minimum similarity score to consider.

        Returns:
            tuple: (filenames, similarities)
        """
        # Load the saved embeddings and filenames
        data = np.load(self.embeddings_path, allow_pickle=True)
        embeddings = data["embeddings"]  # shape: (N, 512)
        filenames = data["filenames"]  # shape: (N,)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        # Encode the text query
        with torch.no_grad():
            text_tokens = clip.tokenize([text_query]).to(device)
            text_embedding = model.encode_text(text_tokens).squeeze(0)  # shape: (512,)

        # Before normalization, convert to torch tensor
        embeddings_tensor = torch.tensor(embeddings, dtype=torch.float32, device=device)

        # Normalize the embeddings
        norm_embeddings = F.normalize(embeddings_tensor, dim=-1).to(torch.float32)
        text_embedding_norm = F.normalize(text_embedding, dim=-1).to(torch.float32)

        # Compute cosine similarity
        similarities = (
            (norm_embeddings @ text_embedding_norm).cpu().numpy()
        )  # shape: (N,)

        # Get top K most similar images
        top_indices = similarities.argsort()[-top_k:][::-1]
        if minimum_score is not None:
            # Filter results based on the minimum score
            top_indices = [i for i in top_indices if similarities[i] >= minimum_score]
            if len(top_indices) == 0:
                return [], []

        return filenames[top_indices], similarities[top_indices]

    def find_duplicate_clusters(self, similarity_threshold=0.995):
        """
        Find clusters of similar images based on cosine similarity.
        Args:
            similarity_threshold (float): Threshold for considering images as similar.
        """
        data = np.load(self.embeddings_path, allow_pickle=True)
        embeddings = data["embeddings"]
        filenames = data["filenames"]

        # Normalize embeddings
        norm_embeddings = embeddings / np.linalg.norm(
            embeddings, axis=-1, keepdims=True
        )
        assert isinstance(
            norm_embeddings, np.ndarray
        ), "Normalization failed, expected np.ndarray"

        # Use NearestNeighbors with cosine metric
        nn = NearestNeighbors(metric="cosine", algorithm="brute")
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
