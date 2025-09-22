"""
embeddings.py

Implement CLIP indexing and searching for images using the CLIP model.
This script provides functionality to index images from a directory or a list of image paths,
and to search for similar images using a query image. It uses the CLIP model from Hugging Face's Transformers library
for image embeddings and similarity calculations.
"""

import asyncio
import functools
import logging
import os
import warnings
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, ClassVar, Dict, Generator, Optional, Set

import clip
import networkx as nx
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from pydantic import BaseModel
from sklearn.neighbors import NearestNeighbors
from tqdm import tqdm
from umap import UMAP

from .metadata_extraction import MetadataExtractor
from .metadata_formatting import format_metadata
from .metadata_modules import SlideSummary
from .progress import progress_tracker

logger = logging.getLogger(__name__)
register_heif_opener()  # Register HEIF opener for PIL
SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".gif",
    ".webp",
    ".tiff",
    ".heif",
    ".heic",
}


class IndexResult(BaseModel):
    """
    Result of an indexing operation.
    Contains the embeddings, filenames, modification times, metadata, and any bad files encountered.
    """

    model_config = {"arbitrary_types_allowed": True}

    embeddings: np.ndarray
    umap_embeddings: Optional[np.ndarray] = None  # UMAP embeddings, if created
    filenames: np.ndarray
    modification_times: np.ndarray
    metadata: np.ndarray
    bad_files: list[Path] = []


class Embeddings(BaseModel):
    """
    A class to handle image embeddings using CLIP.
    This class provides methods to index images, update embeddings, and search for similar images.
    """

    minimum_image_size: ClassVar[int] = 100 * 1024  # Minimum image size in bytes (100K)

    embeddings_path: Path = Path("clip_image_embeddings.npz")

    def get_image_files_from_directory(
        self,
        directory: Path,
        exts: Set[str] = SUPPORTED_EXTENSIONS,
        progress_callback: Optional[Callable] = None,
        update_interval: int = 100,
    ) -> list[Path]:
        """
        Recursively collect all image files from a directory.

        Args:
            directory: Directory to scan
            exts: File extensions to include
            progress_callback: Optional callback function(count, message) for progress updates
            update_interval: How often to call progress_callback (every N files found)
        """
        logger.info(f"Scanning directory {directory} for image files...")
        image_files = []
        files_checked = 0

        for root, dirs, files in os.walk(directory):
            # Remove 'photomap_index' from dirs so os.walk skips it and its subdirs
            dirs[:] = [d for d in dirs if d != "photomap_index"]
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
                    progress_callback(
                        len(image_files),
                        f"Traversing image files... {len(image_files)} found",
                    )

        # Final update with total count
        if progress_callback:
            progress_callback(
                len(image_files),
                f"File traversal complete - {len(image_files)} images found",
            )

        return image_files

    def get_image_files(
        self,
        image_paths_or_dir: list[Path] | Path,
        exts: Set[str] = SUPPORTED_EXTENSIONS,
        progress_callback: Optional[Callable] = None,
    ) -> list[Path]:
        """
        Get a list of image file paths from a directory or a list of image paths.

        Args:
            image_paths_or_dir (list of str or str): List of image paths or a directory path.
            progress_callback: Optional callback function for progress updates

        Returns:
            list of Path: List of image file paths.
        """
        logger.info("get_image_files called with progress_callback")
        if isinstance(image_paths_or_dir, Path):
            # If it's a single Path object, treat it as a directory
            images = self.get_image_files_from_directory(
                image_paths_or_dir, exts, progress_callback
            )
        elif isinstance(image_paths_or_dir, list):
            images = []
            for p in image_paths_or_dir:
                if p.is_dir():
                    images.extend(
                        self.get_image_files_from_directory(p, exts, progress_callback)
                    )
                elif p.suffix.lower() in exts:
                    images.append(p)
        else:
            raise ValueError("Input must be a Path object or a list of Paths.")
        return images

    def _get_modification_time(self, metadata: dict) -> Optional[float]:
        """
        Extract the modification time from image metadata.
        If no valid EXIF date is found, use the file's last modified time.
        """
        # Check for common EXIF date fields
        date_fields = ["DateTimeOriginal", "DateTimeDigitized", "DateTime"]
        for field in date_fields:
            if field in metadata:
                date_str = metadata[field]
                try:
                    # EXIF date format is "YYYY:MM:DD HH:MM:SS"
                    dt = datetime.strptime(date_str, "%Y:%m:%d %H:%M:%S")
                    return dt.timestamp()
                except ValueError:
                    logger.warning(f"Invalid {field} format: {date_str}")
                    continue

        # No usable EXIF date found, so return None
        return None

    def _process_single_image(
        self, image_path: Path, model, preprocess, device: str
    ) -> tuple[Optional[np.ndarray], Optional[float], Optional[dict]]:
        """
        Process a single image and return its embedding, modification time, and metadata.

        Returns:
            tuple: (embedding, modification_time, metadata) or (None, None, None) if failed
        """
        try:
            pil_image = Image.open(image_path)
            pil_image = ImageOps.exif_transpose(pil_image)
            pil_image = pil_image.convert("RGB")

            # Get file metadata
            metadata = self.extract_image_metadata(pil_image)

            # Try to get the image creation/modification time from EXIF data
            modification_time = self._get_modification_time(metadata)
            if modification_time is None:
                modification_time = image_path.stat().st_mtime

            # Create the CLIP embedding
            image = preprocess(pil_image).unsqueeze(0).to(device)
            with torch.no_grad():
                embedding = model.encode_image(image).cpu().numpy().flatten()

            return embedding, modification_time, metadata
        except Exception as e:
            logger.error(f"Error processing {image_path}: {e}")
            return None, None, None

    def _process_images_batch(
        self, image_paths: list[Path], progress_callback: Optional[Callable] = None
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

        umap_embeddings = self.create_umap_index(
            np.array(embeddings) if embeddings else np.empty((0, 512))
        )

        return IndexResult(
            embeddings=np.array(embeddings) if embeddings else np.empty((0, 512)),
            filenames=np.array(filenames),
            modification_times=np.array(modification_times),
            metadata=np.array(metadatas, dtype=object),
            umap_embeddings=umap_embeddings,
            bad_files=bad_files,
        )

    async def _process_images_batch_async(
        self, image_paths: list[Path], album_key: str, yield_interval: int = 10
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
            bad_files=bad_files,
        )

    def _save_embeddings(self, index_result: IndexResult) -> None:
        """Save embeddings to disk and clear cache."""
        # Ensure directory exists
        logger.info(f"Saving embeddings to {self.embeddings_path}")
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
        progress_callback: Optional[Callable] = None,
    ) -> tuple[set[Path], set[Path]]:
        """Determine which images are new and which are missing."""
        image_path_set = set(
            self.get_image_files(
                image_paths_or_dir, progress_callback=progress_callback
            )
        )
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
        existing_metadatas: np.ndarray,
    ) -> IndexResult:
        """Remove missing images from existing arrays."""
        if not missing_image_paths:
            return IndexResult(
                embeddings=existing_embeddings,
                filenames=existing_filenames,
                modification_times=existing_modtimes,
                metadata=existing_metadatas,
                bad_files=[],
            )

        logger.warning(
            f"Removing {len(missing_image_paths)} missing images from existing embeddings."
        )

        # Convert missing paths to strings for comparison
        missing_image_strings = {path.as_posix() for path in missing_image_paths}

        # Create mask for images that still exist (NOT in missing set)
        mask = np.array(
            [fname not in missing_image_strings for fname in existing_filenames]
        )

        # Debug output
        removed_count = len(existing_filenames) - np.sum(mask)
        logger.info(f"Filtered {removed_count} missing images from index")

        return IndexResult(
            embeddings=existing_embeddings[mask],
            filenames=existing_filenames[mask],
            modification_times=existing_modtimes[mask],
            metadata=existing_metadatas[mask],
            bad_files=[],
        )

    def _combine_index_results(
        self, existing_result: IndexResult, new_result: IndexResult
    ) -> IndexResult:
        """Combine existing and new IndexResults."""
        # Handle empty existing embeddings
        if existing_result.embeddings.size == 0:
            existing_embeddings = np.empty(
                (0, new_result.embeddings.shape[1]), dtype=new_result.embeddings.dtype
            )
        else:
            existing_embeddings = existing_result.embeddings

        return IndexResult(
            embeddings=np.vstack((existing_embeddings, new_result.embeddings)),
            filenames=np.concatenate((existing_result.filenames, new_result.filenames)),
            modification_times=np.concatenate(
                (existing_result.modification_times, new_result.modification_times)
            ),
            metadata=np.concatenate((existing_result.metadata, new_result.metadata)),
            bad_files=existing_result.bad_files + new_result.bad_files,
        )

    def create_index(
        self,
        image_paths_or_dir: list[Path] | Path,
        create_index: bool = True,
    ) -> IndexResult:
        """Index images using CLIP and save their embeddings."""
        image_paths = self.get_image_files(image_paths_or_dir)
        total_images = len(image_paths)
        progress_callback = tqdm_progress_callback(total_images)

        logger.info(f"Creating index {self.embeddings_path}...")
        self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
        result = self._process_images_batch(
            image_paths, progress_callback=progress_callback
        )

        if create_index:
            self._save_embeddings(result)
            logger.info(
                f"Indexed {len(result.embeddings)} images and saved to {self.embeddings_path}"
            )
            result.umap_embeddings = self.create_umap_index(result.embeddings)
            logger.info(
                f"Created UMAP index with shape: {result.umap_embeddings.shape}"
            )

        return result

    async def create_index_async(
        self,
        image_paths_or_dir: list[Path] | Path,
        album_key: str,
        create_index: bool = True,
    ) -> Optional[IndexResult]:
        """Asynchronously index images using CLIP with progress tracking."""
        logger.info("Starting asynchronous indexing operation")
        progress_tracker.start_operation(album_key, 0, "scanning")

        def traversal_callback(count, message):
            progress_tracker.update_total_images(album_key, max(count, 0))
            progress_tracker.update_progress(album_key, count, message)

        # Offload the blocking traversal to a thread
        image_paths = await asyncio.to_thread(
            self.get_image_files,
            image_paths_or_dir,
            progress_callback=traversal_callback,
        )
        total_images = len(image_paths)
        logger.info(f"Found {total_images} image files in {image_paths_or_dir}")
        if total_images == 0:
            progress_tracker.set_error(
                album_key, "No image files found in album directory(ies)"
            )
            return

        progress_tracker.start_operation(album_key, total_images, "indexing")

        try:
            self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
            result = await self._process_images_batch_async(image_paths, album_key)
            progress_tracker.update_progress(
                album_key, total_images, "Saving index file"
            )
            if create_index:
                self._save_embeddings(result)
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

        progress_tracker.start_operation(album_key, total_images, "mapping")
        try:
            umap_embeddings = await asyncio.to_thread(
                self.create_umap_index, result.embeddings
            )
            result.umap_embeddings = umap_embeddings
            progress_tracker.complete_operation(
                album_key, "Indexing completed successfully"
            )
            return result
        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def update_index(
        self, image_paths_or_dir: list[Path] | Path
    ) -> Optional[IndexResult]:
        """Update existing embeddings with new images."""
        assert (
            self.embeddings_path.exists()
        ), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."

        try:
            # Load existing data
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]
            existing_filenames = data["filenames"]
            existing_modtimes = data["modification_times"]
            existing_metadatas = data["metadata"]

            # Identify new and missing images
            logger.info(f"Scanning for new images in {image_paths_or_dir}...")
            new_image_paths, missing_image_paths = self._get_new_and_missing_images(
                image_paths_or_dir,
                existing_filenames,
            )

            # Filter out missing images
            filtered_existing = self._filter_missing_images(
                missing_image_paths,
                existing_embeddings,
                existing_filenames,
                existing_modtimes,
                existing_metadatas,
            )

            if len(filtered_existing.filenames) == 0 and len(new_image_paths) == 0:
                logger.warning(
                    "No images found in album directory(ies). Exiting update."
                )
                return

            # Update progress tracker with actual count
            total_new_images = len(new_image_paths)
            logger.info(
                f"Found {total_new_images} new images to index, {len(missing_image_paths)} missing. Beginning indexing..."
            )

            # Process new images
            new_result = self._process_images_batch(list(new_image_paths))

            new_files_indexed = new_result.embeddings.shape[0]
            old_files_removed = len(missing_image_paths)
            logger.info(
                f"New files indexed: {new_files_indexed}, Old files removed: {old_files_removed}"
            )

            # If no new embeddings were created, return existing data
            if new_files_indexed == 0 and old_files_removed == 0:
                logger.info(
                    "No new images needed to be indexed. Will not regenerate umap"
                )
                return IndexResult(
                    embeddings=filtered_existing.embeddings,
                    filenames=filtered_existing.filenames,
                    modification_times=filtered_existing.modification_times,
                    metadata=filtered_existing.metadata,
                    umap_embeddings=self.umap_embeddings,
                    bad_files=new_result.bad_files,
                )

            # Final progress update
            logger.info(f"Indexing completed successfully. Saving updated index...")

            # Combine and save
            combined_result = self._combine_index_results(filtered_existing, new_result)
            self._save_embeddings(combined_result)

            # Rebuild the umap index
            combined_result.umap_embeddings = self.umap_embeddings
            assert new_result.umap_embeddings is not None
            logger.info(
                f"UMAP index created with shape: {new_result.umap_embeddings.shape}"
            )

            return combined_result

        except Exception as e:
            logger.error(f"Failed to update index: {e}")
            raise

    async def update_index_async(
        self, image_paths_or_dir: list[Path] | Path, album_key: str
    ) -> Optional[IndexResult]:
        """Asynchronously update existing embeddings with new images."""
        assert (
            self.embeddings_path.exists()
        ), f"Embeddings file {self.embeddings_path} does not exist. Please create an index first."

        try:
            # Load existing data
            data = np.load(self.embeddings_path, allow_pickle=True)
            existing_embeddings = data["embeddings"]
            existing_filenames = data["filenames"]
            existing_modtimes = data["modification_times"]
            existing_metadatas = data["metadata"]

            # Start scanning phase
            progress_tracker.start_operation(album_key, 0, "scanning")

            # Create progress callback for file traversal
            def traversal_callback(count, message):
                # Update the total as we discover more files
                progress_tracker.update_total_images(album_key, max(count, 0))
                progress_tracker.update_progress(album_key, count, message)

            # Identify new and missing images with progress feedback
            new_image_paths, missing_image_paths = await asyncio.to_thread(
                self._get_new_and_missing_images,
                image_paths_or_dir,
                existing_filenames,
                progress_callback=traversal_callback,
            )

            # Filter out missing images
            filtered_existing = self._filter_missing_images(
                missing_image_paths,
                existing_embeddings,
                existing_filenames,
                existing_modtimes,
                existing_metadatas,
            )

            if len(filtered_existing.filenames) == 0 and len(new_image_paths) == 0:
                progress_tracker.set_error(
                    album_key, "No images found in album directory(ies)"
                )
                return

            # Update progress tracker with actual count
            total_new_images = len(new_image_paths)
            progress_tracker.start_operation(album_key, total_new_images, "indexing")

            # Process new images
            new_result = await self._process_images_batch_async(
                list(new_image_paths), album_key
            )

            new_files_indexed = new_result.embeddings.shape[0]
            old_files_removed = len(missing_image_paths)
            logger.info(
                f"New files indexed: {new_files_indexed}, Old files removed: {old_files_removed}"
            )

            # If no new embeddings were created, return existing data
            if new_files_indexed == 0 and old_files_removed == 0:
                logger.info(
                    "No new images needed to be indexed. Will not regenerate umap"
                )
                progress_tracker.complete_operation(
                    album_key, "No new images needed to be indexed"
                )
                return IndexResult(
                    embeddings=filtered_existing.embeddings,
                    filenames=filtered_existing.filenames,
                    modification_times=filtered_existing.modification_times,
                    metadata=filtered_existing.metadata,
                    umap_embeddings=self.umap_embeddings,
                    bad_files=new_result.bad_files,
                )

            # Final progress update
            progress_tracker.update_progress(
                album_key, total_new_images, "Saving updated index"
            )

            # Combine and save
            combined_result = self._combine_index_results(filtered_existing, new_result)
            self._save_embeddings(combined_result)

            # Rebuild the umap index
            progress_tracker.start_operation(album_key, total_new_images, "mapping")
            new_result.umap_embeddings = await asyncio.to_thread(
                lambda: self.umap_embeddings
            )

            # Mark as completed
            progress_tracker.complete_operation(
                album_key,
                f"Successfully indexed {len(new_result.embeddings)} new images",
            )

            return combined_result

        except Exception as e:
            progress_tracker.set_error(album_key, str(e))
            raise

    def create_umap_index(self, embeddings: np.ndarray) -> np.ndarray:
        """
        Create a UMAP index for the embeddings.

        Args:
            embeddings (np.ndarray): The image embeddings to create UMAP index for.
        Returns:
            np.ndarray: The UMAP embeddings.
        """
        if embeddings.size == 0:
            logger.info("No embeddings provided for UMAP index creation.")
            return np.empty((0, 2))

        # hide warnings from UMAP about TBB version
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore")
            # TO DO: Allow these constants to be configurable.
            n_neighbors = min(15, len(embeddings) - 1) if len(embeddings) > 1 else 1
            umap_model = UMAP(
                n_neighbors=n_neighbors, n_components=2, min_dist=0.05, metric="cosine"
            )
            try:
                umap_embeddings = umap_model.fit_transform(embeddings)
            except Exception as e:
                logger.error(f"UMAP fitting failed: {e}")
                return np.empty((0, 2))

        cache_file = self.embeddings_path.parent / "umap.npz"
        umap_embeddings = np.asarray(umap_embeddings)
        np.savez(cache_file, umap=umap_embeddings)
        logger.info(f"UMAP embeddings shape: {umap_embeddings.shape}")
        return umap_embeddings

    @property
    def umap_embeddings(self) -> np.ndarray:
        """
        Load UMAP embeddings from disk.

        Returns:
            np.ndarray: The UMAP embeddings.
        """
        cache_file = self.embeddings_path.parent / "umap.npz"
        if (
            not cache_file.exists()
            or cache_file.stat().st_mtime < self.embeddings_path.stat().st_mtime
        ):  # If UMAP index does not exist or is outdated, create it
            embeddings = self.open_cached_embeddings(self.embeddings_path)["embeddings"]
            logger.info(f"Creating UMAP index for {embeddings.shape[0]} embeddings")
            return self.create_umap_index(embeddings)
        data = np.load(cache_file, allow_pickle=True)
        return data["umap"]

    @property
    def indexes(self) -> Dict[str, np.ndarray]:
        """
        Load all indexes from the embeddings file.

        Returns:
            Dict[str, np.ndarray]: Dictionary containing all indexes.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        return data

    # Main search entry point.
    def search_images_by_text_and_image(
        self,
        query_image_data: Optional[Image.Image] = None,
        positive_query: Optional[str] = "",
        negative_query: Optional[str] = None,
        image_weight: float = 0.5,
        positive_weight: float = 0.5,
        negative_weight: float = 0.5,
        top_k: int = 5,
        minimum_score: float = 0.2,
    ) -> tuple[list[int], list[float]]:
        """
        Search for images similar to a query image and a positive/negative text prompt, with separate weights.
        Any of the queries can be None; if so, their corresponding weight is set to zero and they are not used.
        Args:
            query_image_data (Image or None): PIL Image data for the query image.
            positive_query (str or None): Positive text prompt.
            negative_query (str or None): Negative text prompt.
            image_weight (float): Weight for image embedding.
            positive_weight (float): Weight for positive text embedding.
            negative_weight (float): Weight for negative text embedding (should be positive; will be subtracted).
            top_k (int): Number of top results.
            minimum_score (float): Minimum similarity score.
        Returns:
            tuple: (indexes, similarities)
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        embeddings = data["embeddings"]
        filenames = data["filenames"]
        filename_map = data["filename_map"]

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, preprocess = clip.load("ViT-B/32", device=device)

        # Handle None queries: set weight to zero and skip embedding
        if query_image_data is None:
            image_weight = 0.0
            image_embedding = None
        else:
            pil_image = ImageOps.exif_transpose(query_image_data)
            pil_image = pil_image.convert("RGB")
            image_tensor: torch.Tensor = preprocess(pil_image)  # type: ignore
            image_tensor = image_tensor.unsqueeze(0).to(device)
            with torch.no_grad():
                image_embedding = model.encode_image(image_tensor).squeeze(0)

        if not positive_query:
            positive_weight = 0.0
            pos_emb = None
        else:
            tokens = clip.tokenize([positive_query]).to(device)
            with torch.no_grad():
                pos_emb = model.encode_text(tokens).squeeze(0)

        if not negative_query:
            negative_weight = 0.0
            neg_emb = None
        else:
            tokens = clip.tokenize([negative_query]).to(device)
            with torch.no_grad():
                neg_emb = model.encode_text(tokens).squeeze(0)

        # If all weights are zero, return empty result
        if image_weight == 0.0 and positive_weight == 0.0 and negative_weight == 0.0:
            return [], []

        # Weighted combination: image + positive - negative
        combined_embedding = None
        if image_weight > 0.0 and image_embedding is not None:
            combined_embedding = image_weight * image_embedding
        if positive_weight > 0.0 and pos_emb is not None:
            if combined_embedding is None:
                combined_embedding = positive_weight * pos_emb
            else:
                combined_embedding += positive_weight * pos_emb
        if negative_weight > 0.0 and neg_emb is not None:
            if combined_embedding is None:
                combined_embedding = -negative_weight * neg_emb
            else:
                combined_embedding -= negative_weight * neg_emb

        # Normalize
        embeddings_tensor = torch.tensor(embeddings, dtype=torch.float32, device=device)
        norm_embeddings = F.normalize(embeddings_tensor, dim=-1).to(torch.float32)
        assert combined_embedding is not None
        combined_embedding_norm = F.normalize(combined_embedding, dim=-1).to(
            torch.float32
        )

        # Similarity
        similarities = (norm_embeddings @ combined_embedding_norm).cpu().numpy()
        top_indices = similarities.argsort()[-top_k:][::-1]
        top_indices = [i for i in top_indices if similarities[i] >= minimum_score]
        if not top_indices:
            return [], []

        # Translate from filename array indices to sorted filename top_indices
        global_indices = [int(filename_map[filenames[i]]) for i in top_indices]
        return global_indices, similarities[top_indices].tolist()

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

    def get_image_path(self, index: int) -> Path:
        """
        Get the image path for a given index in the embeddings file.
        Args:
            index (int): Index of the image to retrieve.
        Returns: Path to the image file.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        sorted_filenames = data["sorted_filenames"]
        if index < 0 or index >= len(sorted_filenames):
            raise IndexError(f"Index {index} out of bounds for embeddings file.")
        return Path(sorted_filenames[index])

    def retrieve_image(
        self,
        index: int = 0,
    ) -> SlideSummary:
        """
        Retrieve the next image in the sequence or a random image if requested.
        Args:
            index (int): Index of the image to retrieve.
            Returns:
                SlideSummary: Path and description of the requested image.
        """
        data = self.open_cached_embeddings(self.embeddings_path)
        sorted_filenames = data["sorted_filenames"]
        sorted_metadata = data["sorted_metadata"]
        if index < 0 or index >= len(sorted_filenames):
            raise IndexError(f"Index {index} out of bounds for embeddings file.")

        return format_metadata(
            Path(sorted_filenames[index]),
            sorted_metadata[index],
            index,
            len(sorted_filenames),
        )

    def remove_image_from_embeddings(self, index: int) -> None:
        """
        Remove an image from the embeddings file.
        """
        try:
            # Use optimized version for O(1) lookup
            data = self.open_cached_embeddings(self.embeddings_path)

            # Load the raw data for modification
            sorted_filenames = data["sorted_filenames"]
            filenames = data["filenames"]
            embeddings = data["embeddings"]
            modtimes = data["modification_times"]
            metadata = data["metadata"]

            current_filename = sorted_filenames[index]

            # Find the index in the original (unsorted) arrays
            original_idx = np.where(filenames == current_filename)[0][0]

            # Remove from all arrays
            filenames = np.delete(filenames, original_idx)
            embeddings = np.delete(embeddings, original_idx, axis=0)
            modtimes = np.delete(modtimes, original_idx)
            metadata = np.delete(metadata, original_idx)

            # Save updated data
            self.embeddings_path.parent.mkdir(parents=True, exist_ok=True)
            np.savez(
                self.embeddings_path,
                embeddings=embeddings,
                filenames=filenames,
                modification_times=modtimes,
                metadata=metadata,
            )
        except Exception as e:
            logger.error(e)
            raise

        # Clear the LRU cache since the file has changed
        self.open_cached_embeddings.cache_clear()

    # This is not used in the current implementation, but can be useful for testing.
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
            yield format_metadata(image_path, metadata[idx], int(idx), len(filenames))

    @staticmethod
    @functools.lru_cache(maxsize=3)
    def open_cached_embeddings(embeddings_path: Path) -> Dict[str, Any]:
        """
        Open embeddings with pre-computed lookup structures.
        """
        embeddings_path = Path(embeddings_path)
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
            "sorted_modification_times": modtimes[sorted_indices],
            "sorted_filenames": sorted_filenames,
            "sorted_metadata": data["metadata"][sorted_indices],
            "filename_map": filename_map,
        }

    @staticmethod
    def extract_image_metadata(pil_image: Image.Image) -> dict:
        """Extract metadata from an image using the dedicated extractor."""
        return MetadataExtractor.extract_image_metadata(pil_image)


def tqdm_progress_callback(total_images):
    """Returns a callback function for tqdm progress reporting."""
    pbar = tqdm(total=total_images, desc="Indexing images", unit="img")

    def callback(count, total_images, message):
        pbar.n = count
        pbar.set_description(message)
        pbar.refresh()
        if count >= total_images:
            pbar.close()

    return callback


def print_cuda_message():
    """Print a message about CUDA availability."""
    if torch.cuda.is_available():
        logger.info("CUDA detected. Using GPU acceleration for indexing.")
    else:
        logger.info("CUDA not detected. Using CPU for indexing.")


print_cuda_message()
