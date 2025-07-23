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
import logging

from typing import Optional, Set, Dict, Callable, Generator
from pathlib import Path
from pydantic import BaseModel

from .metadata_formatting import format_metadata
from .metadata_modules import SlideSummary
from .metadata_extraction import MetadataExtractor
from .progress import progress_tracker

class IndexResult(BaseModel):
    """
    Result of an indexing operation.
    Contains the embeddings, filenames, modification times, metadata, and any bad files encountered.
    """
    model_config = {"arbitrary_types_allowed": True}
    
    embeddings: np.ndarray
    filenames: np.ndarray
    modification_times: np.ndarray
    metadata: np.ndarray
    bad_files: list[Path] = []


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
        progress_callback: Optional[Callable] = None,
        update_interval: int = 100
    ) -> list[Path]:
        """
        Recursively collect all image files from a directory.
        
        Args:
            directory: Directory to scan
            exts: File extensions to include
            progress_callback: Optional callback function(count, message) for progress updates
            update_interval: How often to call progress_callback (every N files found)
        """
        image_files = []
        files_checked = 0
        
        for root, _, files in os.walk(directory):
            for file in [Path(x) for x in files]:
                files_checked += 1
                
                # Check if the file has a valid image extension
                # and that it's length is > minimum_image_size (i.e. not a thumbnail)
                if (
                    file.suffix.lower() in exts
                    and os.path.getsize(Path(root, file)) > self.minimum_image_size
                ):
                    image_files.append(Path(root, file).resolve())
                
                # Provide progress updates at regular intervals
                if progress_callback and files_checked % update_interval == 0:
                    progress_callback(len(image_files), f"Traversing image files... {len(image_files)} found")
        
        # Final update with total count
        if progress_callback:
            progress_callback(len(image_files), f"File traversal complete - {len(image_files)} images found")
            
        return image_files

    def get_image_files(
        self,
        image_paths_or_dir: list[Path] | Path,
        exts: Set[str] = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"},
        progress_callback: Optional[Callable] = None
    ) -> list[Path]:
        """
        Get a list of image file paths from a directory or a list of image paths.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            progress_callback: Optional callback function for progress updates

        Returns:
            list of Path: List of image file paths.
        """
        if isinstance(image_paths_or_dir, Path):
            # If it's a single Path object, treat it as a directory
            images = self.get_image_files_from_directory(image_paths_or_dir, exts, progress_callback)
        elif isinstance(image_paths_or_dir, list):
            images = []
            for p in image_paths_or_dir:
                if p.is_dir():
                    images.extend(self.get_image_files_from_directory(p, exts, progress_callback))
                elif p.suffix.lower() in exts:
                    images.append(p)
        else:
            raise ValueError("Input must be a Path object or a list of Paths.")
        return images

    def _process_single_image(
        self, 
        image_path: Path, 
        model, 
        preprocess, 
        device: str
    ) -> tuple[Optional[np.ndarray], Optional[float], Optional[dict]]:
        """
        Process a single image and return its embedding, modification time, and metadata.
        
        Returns:
            tuple: (embedding, modification_time, metadata) or (None, None, None) if failed
        """
        try:
            pil_image = Image.open(image_path).convert("RGB")
            pil_image = ImageOps.exif_transpose(pil_image)

            # Get file metadata
            modification_time = image_path.stat().st_mtime
            metadata = self.extract_image_metadata(pil_image)

            # Create the CLIP embedding
            image = preprocess(pil_image).unsqueeze(0).to(device)
            with torch.no_grad():
                embedding = model.encode_image(image).cpu().numpy().flatten()
            
            return embedding, modification_time, metadata
        except Exception as e:
            print(f"Error processing {image_path}: {e}")
            return None, None, None

    def _process_images_batch(
        self,
        image_paths: list[Path],
        progress_callback: Optional[Callable] = None
    ) -> IndexResult:
        """
        Process a batch of images and return IndexResult.
        
        Args:
            image_paths: List of image paths to process
            progress_callback: Optional callback function(index, total, message) for progress updates
        """
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        embeddings = []
        filenames = []
        modification_times = []
        metadatas = []
        bad_files = []

        total_images = len(image_paths)
        
        for i, image_path in enumerate(image_paths):
            if progress_callback:
                progress_callback(i, total_images, f"Processing {image_path.name}")
            
            embedding, mod_time, metadata = self._process_single_image(
                image_path, model, preprocess, device
            )
            
            if embedding is not None:
                embeddings.append(embedding)
                filenames.append(image_path.resolve().as_posix())
                modification_times.append(mod_time)
                metadatas.append(metadata)
            else:
                bad_files.append(image_path)

        return IndexResult(
            embeddings=np.array(embeddings) if embeddings else np.empty((0, 512)),
            filenames=np.array(filenames),
            modification_times=np.array(modification_times),
            metadata=np.array(metadatas, dtype=object),
            bad_files=bad_files
        )

    async def _process_images_batch_async(
        self,
        image_paths: list[Path],
        album_key: str,
        yield_interval: int = 10
    ) -> IndexResult:
        """
        Async version of _process_images_batch with progress tracking.
        """
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        embeddings = []
        filenames = []
        modification_times = []
        metadatas = []
        bad_files = []

        total_images = len(image_paths)
        
        for i, image_path in enumerate(image_paths):
            # Update progress
            progress_tracker.update_progress(
                album_key, i, f"Processing {image_path.name}"
            )
            
            embedding, mod_time, metadata = self._process_single_image(
                image_path, model, preprocess, device
            )
            
            if embedding is not None:
                embeddings.append(embedding)
                filenames.append(image_path.resolve().as_posix())
                modification_times.append(mod_time)
                metadatas.append(metadata)
            else:
                bad_files.append(image_path)

            # Yield control periodically
            if i % yield_interval == 0:
                await asyncio.sleep(0.01)

        return IndexResult(
            embeddings=np.array(embeddings) if embeddings else np.empty((0, 512)),
            filenames=np.array(filenames),
            modification_times=np.array(modification_times),
            metadata=np.array(metadatas, dtype=object),
            bad_files=bad_files
        )

    def _save_embeddings(self, index_result: IndexResult) -> None:
        """Save embeddings to disk and clear cache."""
        # Ensure directory exists
        self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
        
        np.savez(
            self.embeddings_path,
            embeddings=index_result.embeddings,
            filenames=index_result.filenames,
            modification_times=index_result.modification_times,
            metadata=index_result.metadata,
        )
        
        # Clear cache after saving
        self.open_cached_embeddings.cache_clear()

    def _get_new_and_missing_images(
        self,
        image_paths_or_dir: list[Path] | Path,
        existing_filenames: np.ndarray,
        progress_callback: Optional[Callable] = None
    ) -> tuple[set[Path], set[Path]]:
        """Determine which images are new and which are missing."""
        image_path_set = set(self.get_image_files(image_paths_or_dir, progress_callback=progress_callback))
        existing_filenames_set = set(Path(p) for p in existing_filenames)
        
        new_image_paths = image_path_set - existing_filenames_set
        missing_image_paths = existing_filenames_set - image_path_set
        
        return new_image_paths, missing_image_paths

    def _filter_missing_images(
        self,
        missing_image_paths: set[Path],
        existing_embeddings: np.ndarray,
        existing_filenames: np.ndarray,
        existing_modtimes: np.ndarray,
        existing_metadatas: np.ndarray
    ) -> IndexResult:
        """Remove missing images from existing arrays."""
        if not missing_image_paths:
            return IndexResult(
                embeddings=existing_embeddings,
                filenames=existing_filenames,
                modification_times=existing_modtimes,
                metadata=existing_metadatas,
                bad_files=[]
            )
        
        print(f"Removing {len(missing_image_paths)} missing images from existing embeddings.")
        
        # Convert missing paths to strings for comparison
        missing_image_strings = {str(path) for path in missing_image_paths}
        
        # Create mask for images that still exist (NOT in missing set)
        mask = np.array([fname not in missing_image_strings for fname in existing_filenames])
        
        # Debug output
        removed_count = len(existing_filenames) - np.sum(mask)
        print(f"Actually removing {removed_count} images from index")
        
        return IndexResult(
            embeddings=existing_embeddings[mask],
            filenames=existing_filenames[mask],
            modification_times=existing_modtimes[mask],
            metadata=existing_metadatas[mask],
            bad_files=[]
        )

    def _combine_index_results(
        self,
        existing_result: IndexResult,
        new_result: IndexResult
    ) -> IndexResult:
        """Combine existing and new IndexResults."""
        # Handle empty existing embeddings
        if existing_result.embeddings.size == 0:
            existing_embeddings = np.empty((0, new_result.embeddings.shape[1]), dtype=new_result.embeddings.dtype)
        else:
            existing_embeddings = existing_result.embeddings
        
        return IndexResult(
            embeddings=np.vstack((existing_embeddings, new_result.embeddings)),
            filenames=np.concatenate((existing_result.filenames, new_result.filenames)),
            modification_times=np.concatenate((existing_result.modification_times, new_result.modification_times)),
            metadata=np.concatenate((existing_result.metadata, new_result.metadata)),
            bad_files=existing_result.bad_files + new_result.bad_files
        )

    def create_index(
        self,
        image_paths_or_dir: list[Path] | Path,
        create_index: bool = True,
    ) -> IndexResult:
        """Index images using CLIP and save their embeddings."""
        image_paths = self.get_image_files(image_paths_or_dir)
        
        result = self._process_images_batch(image_paths)
        
        if create_index:
            self._save_embeddings(result)
            print(f"Indexed {len(result.embeddings)} images and saved to {self.embeddings_path}")
        
        return result

    async def create_index_async(
        self,
        image_paths_or_dir: list[Path] | Path,
        album_key: str,
        create_index: bool = True,
    ) -> IndexResult:
        """Asynchronously index images using CLIP with progress tracking."""

        progress_tracker.start_operation(album_key, 1, "scanning")

        def traversal_callback(count, message):
            progress_tracker.update_total_images(album_key, max(count, 1))
            progress_tracker.update_progress(album_key, count, message)

        # Offload the blocking traversal to a thread
        image_paths = await asyncio.to_thread(
            self.get_image_files,
            image_paths_or_dir,
            {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tiff"},
            traversal_callback,
        )
        total_images = len(image_paths)

        progress_tracker.start_operation(album_key, total_images, "indexing")

        try:
            result = await self._process_images_batch_async(image_paths, album_key)
            progress_tracker.update_progress(album_key, total_images, "Saving index file")
            if create_index:
                self._save_embeddings(result)
            progress_tracker.complete_operation(album_key, "Indexing completed successfully")
            return result
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def update_index(self, image_paths_or_dir: list[Path] | Path) -> IndexResult:
        """Update existing embeddings with new images."""
        assert self.embeddings_path.exists(), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."
        
        try:
            # Load existing data
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]
            existing_filenames = data["filenames"]
            existing_modtimes = data["modification_times"]
            existing_metadatas = data["metadata"]
            
            # Identify new and missing images
            new_image_paths, missing_image_paths = self._get_new_and_missing_images(
                image_paths_or_dir, existing_filenames,
            )
            
            # Filter out missing images
            filtered_existing = self._filter_missing_images(
                missing_image_paths, existing_embeddings, existing_filenames, existing_modtimes, existing_metadatas
            )
            
            # If no new images, save filtered data and return
            if not new_image_paths:
                self._save_embeddings(filtered_existing)
                print("No new images found to index.")
                return filtered_existing
            
            # Process new images
            new_result = self._process_images_batch(list(new_image_paths))
            
            # If no new embeddings were created, return existing data
            if new_result.embeddings.shape[0] == 0:
                self._save_embeddings(filtered_existing)
                return IndexResult(
                    embeddings=filtered_existing.embeddings,
                    filenames=filtered_existing.filenames,
                    modification_times=filtered_existing.modification_times,
                    metadata=filtered_existing.metadata,
                    bad_files=new_result.bad_files
                )
            
            # Combine and save
            combined_result = self._combine_index_results(filtered_existing, new_result)
            self._save_embeddings(combined_result)
            
            return combined_result
            
        except Exception as e:
            raise

    async def update_index_async(
        self, 
        image_paths_or_dir: list[Path] | Path,
        album_key: str
    ) -> IndexResult:
        """Asynchronously update existing embeddings with new images."""
        assert self.embeddings_path.exists(), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."
        
        try:
            # Load existing data
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]
            existing_filenames = data["filenames"]
            existing_modtimes = data["modification_times"]
            existing_metadatas = data["metadata"]
            
            # Start scanning phase
            progress_tracker.start_operation(album_key, 1, "scanning")
            
            # Create progress callback for file traversal
            def traversal_callback(count, message):
                # Update the total as we discover more files
                progress_tracker.update_total_images(album_key, max(count, 1))
                progress_tracker.update_progress(album_key, count, message)
            
            # Identify new and missing images with progress feedback
            new_image_paths, missing_image_paths = await asyncio.to_thread(
                self._get_new_and_missing_images,
                image_paths_or_dir, 
                existing_filenames, 
                progress_callback=traversal_callback
            )

            # Filter out missing images
            filtered_existing = self._filter_missing_images(
                missing_image_paths, existing_embeddings, existing_filenames, existing_modtimes, existing_metadatas
            )
            
            # If no new images, return early
            if not new_image_paths:
                self._save_embeddings(filtered_existing)
                progress_tracker.complete_operation(album_key, "No new images found")
                return filtered_existing
            
            # Update progress tracker with actual count
            total_new_images = len(new_image_paths)
            progress_tracker.start_operation(album_key, total_new_images, "indexing")
            
            # Process new images
            new_result = await self._process_images_batch_async(list(new_image_paths), album_key)
            
            # Final progress update
            progress_tracker.update_progress(album_key, total_new_images, "Saving updated index")
            
            # If no new embeddings were created, return existing data
            if new_result.embeddings.shape[0] == 0:
                progress_tracker.complete_operation(album_key, "No new images were successfully indexed")
                return IndexResult(
                    embeddings=filtered_existing.embeddings,
                    filenames=filtered_existing.filenames,
                    modification_times=filtered_existing.modification_times,
                    metadata=filtered_existing.metadata,
                    bad_files=new_result.bad_files
                )
            
            # Combine and save
            combined_result = self._combine_index_results(filtered_existing, new_result)
            self._save_embeddings(combined_result)
            
            # Mark as completed
            progress_tracker.complete_operation(album_key, f"Successfully indexed {len(new_result.embeddings)} new images")
            
            return combined_result
            
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
