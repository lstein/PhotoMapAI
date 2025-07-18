"""
embeddings.py

Implement CLIP indexing and searching for images using the CLIP model.
This script provides functionality to index images from a directory or a list of image paths,
and to search for similar images using a query image. It uses the CLIP model from Hugging Face's Transformers library
for image embeddings and similarity calculations.
"""

import os
import clip
import functools
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from tqdm import tqdm
from sklearn.neighbors import NearestNeighbors
import networkx as nx
import asyncio

from typing import Optional, Set, Dict, Tuple, Generator
from pathlib import Path
from pydantic import BaseModel

from .metadata_formatting import format_metadata
from .metadata_modules import SlideSummary
from .metadata_extraction import MetadataExtractor
from .progress import progress_tracker, IndexStatus


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

    def get_image_files(
        self,
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
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Path]]:
        """
        Index images using CLIP and save their embeddings.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            create_index (bool): Whether to save the index to disk.
        """
        # Accept either a directory or a list of image paths
        image_paths = self.get_image_files(image_paths_or_dir)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        embeddings = []
        filenames = []
        modification_times = []  # List to store file modification times
        metadatas = []  # List to store file metadata
        bad_files = []  # List to store files that failed to process

        # Ensure image_paths is a list of paths (strings)
        if isinstance(image_paths, Path):
            image_paths = [image_paths]

        for image_path in tqdm(image_paths, desc="Indexing images"):
            try:
                pil_image = Image.open(image_path).convert("RGB")
                # Handle EXIF orientation
                pil_image = ImageOps.exif_transpose(pil_image)

                # Get file metadata
                modification_time = image_path.stat().st_mtime
                metadata = self.extract_image_metadata(pil_image)

                # Create the CLIP embedding
                image = preprocess(pil_image).unsqueeze(0).to(device)  # type: ignore
                with torch.no_grad():
                    embedding = model.encode_image(image).cpu().numpy().flatten()
                embeddings.append(embedding)
                filenames.append(
                    image_path.resolve().as_posix()
                )  # Store the full path as a string
                modification_times.append(modification_time)
                metadatas.append(metadata)
            except Exception as e:
                print(f"Error processing {image_path}: {e}")
                # add failed image to a list for debugging
                bad_files.append(image_path)

        embeddings = np.array(embeddings)  # shape: (N, 512)
        filenames = np.array(filenames)  # shape: (N,)
        mod_times = np.array(modification_times)  # shape: (N,)
        metadatas = np.array(metadatas, dtype=object)  # shape: (N,)

        # Save embeddings and filenames if requested
        if create_index:
            np.savez(
                self.embeddings_path,
                embeddings=embeddings,
                filenames=filenames,
                modification_times=mod_times,
                metadata=metadatas,
            )

            # Clear cache after creating new index
            self.open_cached_embeddings.cache_clear()

            print(
                f"Indexed {len(embeddings)} images and saved to {self.embeddings_path}"
            )

        return embeddings, filenames, mod_times, metadatas, bad_files

    async def create_index_async(
        self,
        image_paths_or_dir: list[Path] | Path,
        album_key: str,
        create_index: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Path]]:
        """
        Asynchronously index images using CLIP with progress tracking.
        """
        # Accept either a directory or a list of image paths
        image_paths = self.get_image_files(image_paths_or_dir)
        total_images = len(image_paths)

        # Start progress tracking
        progress_tracker.start_operation(album_key, total_images, "indexing")

        try:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            model, preprocess = clip.load("ViT-B/32", device=device)

            embeddings = []
            filenames = []
            modification_times = []
            metadatas = []
            bad_files = []

            # Ensure image_paths is a list of paths
            if isinstance(image_paths, Path):
                image_paths = [image_paths]

            for i, image_path in enumerate(image_paths):
                try:
                    # Update progress
                    progress_tracker.update_progress(
                        album_key, i, f"Processing {image_path.name}"
                    )

                    pil_image = Image.open(image_path).convert("RGB")
                    pil_image = ImageOps.exif_transpose(pil_image)

                    # Get file metadata
                    modification_time = image_path.stat().st_mtime
                    metadata = self.extract_image_metadata(pil_image)

                    # Create the CLIP embedding
                    image = preprocess(pil_image).unsqueeze(0).to(device)
                    with torch.no_grad():
                        embedding = model.encode_image(image).cpu().numpy().flatten()

                    embeddings.append(embedding)
                    filenames.append(image_path.resolve().as_posix())
                    modification_times.append(modification_time)
                    metadatas.append(metadata)

                    # Yield control periodically to allow other async operations
                    if i % 10 == 0:  # Every 10 images
                        await asyncio.sleep(0.01)

                except Exception as e:
                    print(f"Error processing {image_path}: {e}")
                    bad_files.append(image_path)

            # Final progress update
            progress_tracker.update_progress(
                album_key, total_images, "Saving index file"
            )

            embeddings = np.array(embeddings)
            filenames = np.array(filenames)
            mod_times = np.array(modification_times)
            metadatas = np.array(metadatas, dtype=object)

            # Save embeddings and filenames if requested
            if create_index:
                # Ensure directory exists
                self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)

                np.savez(
                    self.embeddings_path,
                    embeddings=embeddings,
                    filenames=filenames,
                    modification_times=mod_times,
                    metadata=metadatas,
                )

                # Clear cache after creating new index
                self.open_cached_embeddings.cache_clear()

            # Mark as completed
            progress_tracker.update_progress(album_key, total_images, "Completed")

            return embeddings, filenames, mod_times, metadatas, bad_files

        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def update_index(
        self, image_paths_or_dir: list[Path] | Path
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Path]]:
        """
        Update existing embeddings with new images.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
        """
        assert (
            self.embeddings_path.exists()
        ), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."

        try:
            # Load existing embeddings and filenames
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]  # shape: (N, 512)
            existing_filenames = data["filenames"]  # shape: (N,)
            existing_modtimes = data["modification_times"]  # shape: (N,)
            existing_metadatas = data["metadata"]  # shape: (N,)

            image_path_set = set(self.get_image_files(image_paths_or_dir))
            existing_filenames_set = set(Path(p) for p in existing_filenames)
            new_image_paths = image_path_set - existing_filenames_set
            missing_image_paths = existing_filenames_set - image_path_set

            if missing_image_paths:
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
                np.savez(
                    self.embeddings_path,
                    embeddings=existing_embeddings,
                    filenames=existing_filenames,
                    modification_times=existing_modtimes,
                    metadata=existing_metadatas,
                )
                return (
                    existing_embeddings,
                    existing_filenames,
                    existing_modtimes,
                    existing_metadatas,
                    [],
                )

            # Index new images
            (
                new_embeddings,
                new_filenames,
                new_modification_times,
                new_metadatas,
                bad_files,
            ) = self.create_index(
                list(new_image_paths),
                create_index=False,
            )

            if new_embeddings.shape[0] == 0:
                np.savez(
                    self.embeddings_path,
                    embeddings=existing_embeddings,
                    filenames=existing_filenames,
                    modification_times=existing_modtimes,
                    metadata=existing_metadatas,
                )
                return (
                    existing_embeddings,
                    existing_filenames,
                    existing_modtimes,
                    existing_metadatas,
                    bad_files,
                )

            # Combine existing and new embeddings
            if existing_embeddings.size == 0:
                existing_embeddings = np.empty(
                    (0, new_embeddings.shape[1]), dtype=new_embeddings.dtype
                )

            updated_embeddings = np.vstack((existing_embeddings, new_embeddings))
            updated_filenames = np.concatenate((existing_filenames, new_filenames))
            updated_mod_times = np.concatenate(
                (existing_modtimes, new_modification_times)
            )
            updated_metadatas = np.concatenate((existing_metadatas, new_metadatas))

            # Save updated embeddings and filenames
            np.savez(
                self.embeddings_path,
                embeddings=updated_embeddings,
                filenames=updated_filenames,
                modification_times=updated_mod_times,
                metadata=updated_metadatas,
            )

            # Clear cache after updating embeddings
            self.open_cached_embeddings.cache_clear()

            return (
                updated_embeddings,
                updated_filenames,
                updated_mod_times,
                updated_metadatas,
                bad_files,
            )

        except Exception as e:
            raise

    async def update_index_async(
        self, 
        image_paths_or_dir: list[Path] | Path,
        album_key: str
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Path]]:
        """
        Asynchronously update existing embeddings with new images.
        """
        assert (
            self.embeddings_path.exists()
        ), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."

        try:
            # Load existing embeddings and filenames
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]
            existing_filenames = data["filenames"]
            existing_modtimes = data["modification_times"]
            existing_metadatas = data["metadata"]

            # Get the image paths and identify new ones
            progress_tracker.start_operation(album_key, 0, "scanning")
            
            image_path_set = set(self.get_image_files(image_paths_or_dir))
            existing_filenames_set = set(Path(p) for p in existing_filenames)
            new_image_paths = image_path_set - existing_filenames_set
            missing_image_paths = existing_filenames_set - image_path_set

            if missing_image_paths:
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
                progress_tracker.update_progress(album_key, 0, "No new images found")
                return (existing_embeddings, existing_filenames, existing_modtimes, existing_metadatas, [])

            # Update progress tracker with actual count
            total_new_images = len(new_image_paths)
            progress_tracker.start_operation(album_key, total_new_images, "indexing")

            # Index new images
            (new_embeddings, new_filenames, new_modification_times, new_metadatas, bad_files) = await self.create_index_async(
                list(new_image_paths), 
                album_key,
                create_index=False
            )

            if new_embeddings.shape[0] == 0:
                progress_tracker.update_progress(album_key, total_new_images, "No new images were successfully indexed")
                return (existing_embeddings, existing_filenames, existing_modtimes, existing_metadatas, bad_files)

            # Combine existing and new embeddings
            if existing_embeddings.size == 0:
                existing_embeddings = np.empty((0, new_embeddings.shape[1]), dtype=new_embeddings.dtype)

            updated_embeddings = np.vstack((existing_embeddings, new_embeddings))
            updated_filenames = np.concatenate((existing_filenames, new_filenames))
            updated_mod_times = np.concatenate((existing_modtimes, new_modification_times))
            updated_metadatas = np.concatenate((existing_metadatas, new_metadatas))

            # Save updated embeddings
            np.savez(
                self.embeddings_path,
                embeddings=updated_embeddings,
                filenames=updated_filenames,
                modification_times=updated_mod_times,
                metadata=updated_metadatas,
            )

            # Clear cache after updating embeddings
            self.open_cached_embeddings.cache_clear()

            return (updated_embeddings, updated_filenames, updated_mod_times, updated_metadatas, bad_files)
            
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

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
        # data = np.load(self.embeddings_path, allow_pickle=True)
        data = self.open_cached_embeddings(self.embeddings_path)
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
        # data = np.load(self.embeddings_path, allow_pickle=True)
        data = self.open_cached_embeddings(self.embeddings_path)
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

    @staticmethod
    @functools.lru_cache(maxsize=3)
    def open_cached_embeddings(embeddings_path: Path) -> Dict[str, any]:
        """
        Open embeddings with pre-computed lookup structures.
        """
        if not embeddings_path.exists():
            raise FileNotFoundError(
                f"Embeddings file {embeddings_path} does not exist."
            )

        data = np.load(embeddings_path, allow_pickle=True)

        # Pre-compute sorted order
        modtimes = data["modification_times"]
        sorted_indices = np.argsort(modtimes)

        # Create filename -> position mapping for O(1) lookup
        sorted_filenames = data["filenames"][sorted_indices]
        filename_map = {fname: idx for idx, fname in enumerate(sorted_filenames)}

        return {
            "filenames": data["filenames"],
            "metadata": data["metadata"],
            "embeddings": data["embeddings"],
            "modification_times": data["modification_times"],
            "sorted_filenames": sorted_filenames,
            "sorted_metadata": data["metadata"][sorted_indices],
            "filename_map": filename_map,
        }

    def retrieve_next_image(
        self, current_image: Optional[Path] = None, random: bool = False
    ) -> SlideSummary:
        """
        Retrieve the next image in the sequence or a random image if requested.
        Args:
            current_image (Path, optional): Path to the current image.
            random (bool): If True, return a random image instead of the next one.
            Returns:
                SlideSummary: Path and description o the next image.
        """
        data = self.open_cached_embeddings(self.embeddings_path)

        if random:
            filenames = data["filenames"]
            metadata = data["metadata"]
            idx = np.random.randint(len(filenames))
            return format_metadata(Path(filenames[idx]), metadata[idx])

        # Sequential mode with O(1) lookup
        sorted_filenames = data["sorted_filenames"]
        sorted_metadata = data["sorted_metadata"]
        filename_map = data["filename_map"]

        if not current_image:
            return format_metadata(Path(sorted_filenames[0]), sorted_metadata[0])

        current_filename = current_image.as_posix()
        if current_filename not in filename_map:
            raise ValueError(f"Current image {current_image} not found in embeddings.")

        current_idx = filename_map[current_filename]
        next_idx = (current_idx + 1) % len(sorted_filenames)

        return format_metadata(
            Path(sorted_filenames[next_idx]), sorted_metadata[next_idx]
        )

    def retrieve_image(self, current_image: Path) -> SlideSummary:
        """
        Retrieve the metadata for a specific image.
        Optimized version using O(1) lookup.

        Args:
            current_image (Path): Path to the image.

        Returns:
            SlideSummary:  Path and description of the image.
        """
        data = self.open_cached_embeddings(self.embeddings_path)

        # Use the pre-computed filename map for O(1) lookup
        filename_map = data["filename_map"]
        sorted_filenames = data["sorted_filenames"]
        sorted_metadata = data["sorted_metadata"]

        current_filename = current_image.as_posix()
        if current_filename not in filename_map:
            raise ValueError(f"Image {current_image} not found in embeddings.")

        # O(1) lookup instead of O(n) np.where search
        idx = filename_map[current_filename]
        return format_metadata(Path(sorted_filenames[idx]), sorted_metadata[idx])

    def remove_image_from_embeddings(self, image_path: Path):
        """
        Remove an image from the embeddings file.
        Optimized version with O(1) lookup and cache invalidation.
        """
        print(f"Removing {image_path} from embeddings.")

        # Use optimized version for O(1) lookup
        data = self.open_cached_embeddings(self.embeddings_path)

        # Load the raw data for modification
        filenames = data["filenames"]
        embeddings = data["embeddings"]
        modtimes = data["modification_times"]
        metadata = data["metadata"]

        current_filename = image_path.as_posix()
        if current_filename not in filenames:
            raise ValueError(f"Image {image_path} not found in embeddings.")

        # Find the index in the original (unsorted) arrays
        original_idx = np.where(filenames == current_filename)[0][0]

        # Remove from all arrays
        filenames = np.delete(filenames, original_idx)
        embeddings = np.delete(embeddings, original_idx, axis=0)
        modtimes = np.delete(modtimes, original_idx)
        metadata = np.delete(metadata, original_idx)

        # Save updated data
        np.savez(
            self.embeddings_path,
            embeddings=embeddings,
            filenames=filenames,
            modification_times=modtimes,
            metadata=metadata,
        )

        # Clear the LRU cache since the file has changed
        self.open_cached_embeddings.cache_clear()

    def iterate_images(
        self, random: bool = False
    ) -> Generator[SlideSummary, None, None]:
        """
        Iterate over images in the embeddings file.
        Yields:
            SlideSummary: Summary for each image.
        """
        # Use cached version instead of direct np.load
        data = self.open_cached_embeddings(self.embeddings_path)
        filenames = data["filenames"]
        metadata = data["metadata"]

        if random:
            indices = np.random.permutation(len(filenames))
        else:
            indices = np.arange(len(filenames))
        for idx in indices:
            image_path = Path(filenames[idx])
            yield format_metadata(image_path, metadata[idx])

    @staticmethod
    def extract_image_metadata(pil_image: Image.Image) -> dict:
        """Extract metadata from an image using the dedicated extractor."""
        return MetadataExtractor.extract_image_metadata(pil_image)
    