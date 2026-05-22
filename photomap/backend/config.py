# photomap/backend/config.py
"""
Configuration management for PhotoMap backend.
This module handles loading, saving, and managing photo album configurations.
It uses a YAML file to store album details and provides methods to manipulate albums.
"""
import logging
import os
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from platformdirs import user_config_dir
from pydantic import BaseModel, Field, field_validator, model_validator

from .encoders import DEFAULT_ENCODER_SPEC, LEGACY_ENCODER_SPEC
from .util import atomic_write_text

logger = logging.getLogger(__name__)


class Album(BaseModel):
    """Represents a photo album configuration."""

    key: str = Field(..., description="Unique album identifier")
    name: str = Field(..., description="Display name for the album")
    image_paths: list[str] = Field(
        ..., min_length=1, description="List of paths containing images"
    )
    index: str = Field(..., description="Path to the embeddings index file")
    umap_eps: float = Field(default=0.2, description="UMAP epsilon parameter")
    description: str = Field(default="", description="Album description")
    encoder_spec: str = Field(
        default=DEFAULT_ENCODER_SPEC,
        description=(
            "Image/text encoder spec. Format: '<backend>:<model>'. "
            "Examples: 'openai-clip:ViT-B/32' (default, legacy), "
            "'open-clip:ViT-L-14/dfn2b', 'siglip:google/siglip2-large-patch16-256'. "
            "Changing this requires re-indexing the album."
        ),
    )
    # Per-album search controls. min_search_score defaults to None so a
    # validator can resolve it from the encoder (0.005 for SigLIP's compressed
    # cosine band, 0.2 for CLIP-style backends) at construction time.
    min_search_score: float | None = Field(
        default=None,
        description="Minimum similarity score below which results are filtered out.",
    )
    max_search_results: int = Field(
        default=100,
        description="Maximum number of search results to return.",
    )
    use_query_optimization: bool = Field(
        default=True,
        description=(
            "SigLIP only: ensemble text queries across modality templates. "
            "Ignored by CLIP/OpenCLIP."
        ),
    )
    min_image_dimension: int = Field(
        default=256,
        ge=1,
        description=(
            "Minimum image dimension (in pixels) for an image to be indexed. "
            "An image is kept only if both its width and height are >= this "
            "value. Filters out thumbnails and tiny images that contribute "
            "little to semantic search."
        ),
    )

    @model_validator(mode="after")
    def _resolve_min_search_score(self) -> "Album":
        if self.min_search_score is None:
            self.min_search_score = (
                0.005 if self.encoder_spec.startswith("siglip:") else 0.2
            )
        return self

    @field_validator("image_paths")
    @classmethod
    def expand_and_validate_image_paths(cls, v: list[str]) -> list[str]:
        """Expand ~ and warn if image paths do not exist."""
        expanded = [str(Path(path).expanduser()) for path in v]
        for path in expanded:
            if not Path(path).exists():
                logger.warning(f"Image path does not exist: {path}")
        return expanded

    @field_validator("index")
    @classmethod
    def validate_index_path(cls, v: str) -> str:
        """Validate index path format."""
        index_path = Path(v).expanduser()
        if not index_path.suffix == ".npz":
            raise ValueError("Index file must have .npz extension")
        return index_path.as_posix()

    def to_dict(self) -> dict[str, Any]:
        """Convert album to dictionary format for YAML."""
        return {
            "name": self.name,
            "image_paths": self.image_paths,
            "index": self.index,
            "umap_eps": self.umap_eps,
            "description": self.description,
            "encoder_spec": self.encoder_spec,
            "min_search_score": self.min_search_score,
            "max_search_results": self.max_search_results,
            "use_query_optimization": self.use_query_optimization,
            "min_image_dimension": self.min_image_dimension,
        }

    @classmethod
    def from_dict(cls, key: str, data: dict[str, Any]) -> "Album":
        """Create Album from dictionary."""
        return cls(
            key=key,
            name=data.get("name", key.capitalize()),
            image_paths=data.get("image_paths", []),
            index=data["index"],
            umap_eps=data.get("umap_eps", 0.07),
            description=data.get("description", ""),
            # Legacy YAML albums predate the encoder_spec field; their indexes
            # were built with the original CLIP, so fall back to that to stay
            # cache-compatible. New albums get DEFAULT_ENCODER_SPEC via the
            # Album field default when the frontend creates them.
            encoder_spec=data.get("encoder_spec", LEGACY_ENCODER_SPEC),
            min_search_score=data.get("min_search_score"),
            max_search_results=data.get("max_search_results", 100),
            use_query_optimization=data.get("use_query_optimization", True),
            min_image_dimension=data.get("min_image_dimension", 256),
        )


class Config(BaseModel):
    """Main configuration model."""

    config_version: str = Field("1.0.0", description="Configuration format version")
    albums: dict[str, Album] = Field(
        default_factory=dict, description="Album configurations"
    )
    locationiq_api_key: str | None = Field(
        default=None, description="LocationIQ API key for map services"
    )
    invokeai_url: str | None = Field(
        default=None,
        description="Base URL of a running InvokeAI backend, e.g. http://localhost:9090",
    )
    invokeai_username: str | None = Field(
        default=None,
        description="Username for authenticating against InvokeAI (future use)",
    )
    invokeai_password: str | None = Field(
        default=None,
        description="Password for authenticating against InvokeAI (future use)",
    )
    invokeai_board_id: str | None = Field(
        default=None,
        description=(
            "ID of the InvokeAI board that reference-image uploads should be "
            "placed in. None means Uncategorized."
        ),
    )
    encoder_idle_timeout_seconds: float = Field(
        default=30.0,
        description=(
            "Seconds of search inactivity before the cached encoder is moved "
            "from GPU VRAM to system RAM. Reload from RAM on the next query is "
            "fast (no disk/network fetch). Set to 0 to disable offloading."
        ),
    )

    @field_validator("encoder_idle_timeout_seconds")
    @classmethod
    def validate_encoder_idle_timeout_seconds(cls, v: float) -> float:
        if v < 0:
            raise ValueError("encoder_idle_timeout_seconds must be >= 0")
        return float(v)

    @field_validator("config_version")
    @classmethod
    def validate_version(cls, v: str) -> str:
        """Validate configuration version format."""
        try:
            # Simple version validation - should be in format x.y.z
            parts = v.split(".")
            if len(parts) != 3 or not all(part.isdigit() for part in parts):
                raise ValueError("Version must be in format x.y.z")
        except Exception as e:
            raise ValueError("Invalid version format") from e
        return v

    @model_validator(mode="after")
    def validate_albums(self) -> "Config":
        """Validate albums configuration."""
        if not self.albums:
            print("Warning: No albums configured")
        return self

    def to_dict(self) -> dict[str, Any]:
        """Convert config to dictionary format for YAML."""
        return {
            "config_version": self.config_version,
            "albums": {key: album.to_dict() for key, album in self.albums.items()},
            "locationiq_api_key": self.locationiq_api_key,
            "invokeai_url": self.invokeai_url,
            "invokeai_username": self.invokeai_username,
            "invokeai_password": self.invokeai_password,
            "invokeai_board_id": self.invokeai_board_id,
            "encoder_idle_timeout_seconds": self.encoder_idle_timeout_seconds,
        }


class ConfigManager:
    """Manages PhotoMap configuration file with Pydantic validation."""

    def __init__(self, config_path: Path | None = None):
        """Initialize configuration manager.

        Args:
            config_path: Optional custom path to config file. If None, uses platform default.
        """
        self.config_path = config_path or self._get_default_config_path()
        self._config: Config | None = None
        # Re-entrant so a mutator can call load_config() and save_config()
        # inside the same critical section. Without this lock, two concurrent
        # API requests can clobber each other's writes when both read-modify-
        # write the YAML config.
        self._lock = threading.RLock()

    def _get_default_config_path(self) -> Path:
        """Get platform-specific default configuration file path."""
        # Try environment variable first
        if "PHOTOMAP_CONFIG" in os.environ:
            return Path(os.environ["PHOTOMAP_CONFIG"])

        # Use platformdirs for cross-platform config directory
        config_dir = Path(user_config_dir("photomap", "photomap"))
        config_dir.mkdir(parents=True, exist_ok=True)
        return config_dir / "config.yaml"

    def get_locationiq_api_key(self) -> str | None:
        """Get the LocationIQ API key."""
        if os.environ.get(
            "PHOTOMAP_ALBUM_LOCKED"
        ):  # In locked-down environments, do not leak the locationIQ key
            return
        config = self.load_config()
        return config.locationiq_api_key

    def set_locationiq_api_key(self, api_key: str | None) -> None:
        """Set the LocationIQ API key.

        Args:
            api_key: API key string or None to remove
        """
        if os.environ.get(
            "PHOTOMAP_ALBUM_LOCKED"
        ):  # In locked-down environments, do not allow changing the locationIQ key
            raise PermissionError("Album configuration is locked.")
        with self._lock:
            config = self.load_config()
            # Strip whitespace and treat empty strings as None
            config.locationiq_api_key = (
                api_key.strip() if api_key and api_key.strip() else None
            )
            self._config = config
            self.save_config()
            # Clear cache after saving to ensure fresh reads
            self._config = None

    def get_invokeai_settings(self) -> dict[str, str | None]:
        """Return the configured InvokeAI connection settings."""
        config = self.load_config()
        return {
            "url": config.invokeai_url,
            "username": config.invokeai_username,
            "password": config.invokeai_password,
            "board_id": config.invokeai_board_id,
        }

    def set_invokeai_settings(
        self,
        url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        board_id: str | None = None,
    ) -> None:
        """Update the InvokeAI connection settings.

        Empty strings are normalized to None so that the fields can be cleared.
        """

        def _clean(value: str | None) -> str | None:
            if value is None:
                return None
            value = value.strip()
            return value or None

        with self._lock:
            config = self.load_config()
            config.invokeai_url = _clean(url)
            config.invokeai_username = _clean(username)
            config.invokeai_password = _clean(password)
            config.invokeai_board_id = _clean(board_id)
            self._config = config
            self.save_config()
            self._config = None

    def load_config(self) -> Config:
        """Load configuration from YAML file."""
        with self._lock:
            if self._config is None:
                if not self.config_path.exists():
                    self._config = Config(
                        config_version="1.0.0",
                        albums={},
                        locationiq_api_key=None,
                    )
                else:
                    try:
                        with open(self.config_path) as f:
                            config_data = yaml.safe_load(f)

                        # Convert album dictionaries to Album objects
                        albums = {}
                        for key, album_data in config_data.get("albums", {}).items():
                            albums[key] = Album.from_dict(key, album_data)

                        extra: dict[str, Any] = {}
                        if "encoder_idle_timeout_seconds" in config_data:
                            extra["encoder_idle_timeout_seconds"] = config_data[
                                "encoder_idle_timeout_seconds"
                            ]
                        self._config = Config(
                            config_version=config_data.get("config_version", "1.0.0"),
                            albums=albums,
                            locationiq_api_key=config_data.get("locationiq_api_key"),
                            invokeai_url=config_data.get("invokeai_url"),
                            invokeai_username=config_data.get("invokeai_username"),
                            invokeai_password=config_data.get("invokeai_password"),
                            invokeai_board_id=config_data.get("invokeai_board_id"),
                            **extra,
                        )

                    except Exception as e:
                        raise RuntimeError(
                            f"Failed to load configuration from {self.config_path}: {e}"
                        ) from e

            return self._config

    def save_config(self):
        """Save current configuration to file."""
        with self._lock:
            if self._config is None:
                raise RuntimeError("No configuration loaded")

            try:
                payload = yaml.safe_dump(
                    self._config.to_dict(), default_flow_style=False, indent=2
                )
                atomic_write_text(self.config_path, payload)
            except Exception as e:
                raise RuntimeError(
                    f"Failed to save configuration to {self.config_path}: {e}"
                ) from e

    def get_albums(self) -> dict[str, Album]:
        """Get all albums."""
        config = self.load_config()
        return config.albums.copy()

    def get_album(self, key: str) -> Album | None:
        """Get a specific album by key."""
        albums = self.get_albums()
        return albums.get(key)

    def add_album(self, album: Album) -> bool:
        """Add a new album.

        Args:
            album: Album object to add

        Returns:
            True if added successfully, False if key already exists
        """
        with self._lock:
            config = self.load_config()

            if album.key in config.albums:
                return False

            config.albums[album.key] = album
            self._config = config
            self.save_config()
            self._config = None  # Clear cache to ensure fresh reads
            return True

    def update_album(self, album: Album) -> bool:
        """Update an existing album.

        Args:
            album: Album object with updated data

        Returns:
            True if updated successfully, False if key doesn't exist
        """
        with self._lock:
            config = self.load_config()

            if album.key not in config.albums:
                return False

            config.albums[album.key] = album
            self._config = config
            self.save_config()
            self._config = None  # Clear cache to ensure fresh reads
            return True

    def delete_album(self, key: str) -> bool:
        """Delete an album by key.

        Args:
            key: Album key to delete

        Returns:
            True if deleted successfully, False if key doesn't exist
        """
        with self._lock:
            config = self.load_config()

            if key not in config.albums:
                return False

            del config.albums[key]
            self._config = config
            self.save_config()
            self._config = None  # Clear cache to ensure fresh reads
            return True

    def get_photo_albums_dict(self) -> dict[str, str]:
        """Get albums in the old PHOTO_ALBUMS format for backward compatibility.

        Returns:
            Dictionary mapping album keys to their first image path
        """
        albums = self.get_albums()
        return {
            key: album.image_paths[0] if album.image_paths else ""
            for key, album in albums.items()
        }

    def find_image_in_album(self, album_key: str, relative_path: str) -> Path | None:
        """Find the full path of an image in any of the album's image paths.

        Args:
            album_key: Album key
            relative_path: Relative path to the image

        Returns:
            Full path to the image if found, None otherwise
        """
        album = self.get_album(album_key)
        if not album:
            return None

        for image_path in album.image_paths:
            full_path = Path(image_path) / relative_path
            if full_path.exists():
                return full_path

        # If not found, return path from first directory (for error handling)
        if album.image_paths:
            return Path(album.image_paths[0]) / relative_path
        return None

    def get_relative_path(self, full_path: str, album_key: str) -> str | None:
        """Get relative path of image within album's image paths.

        Args:
            full_path: Full path to the image
            album_key: Album key

        Returns:
            Relative path if found, None otherwise
        """
        album = self.get_album(album_key)
        if not album:
            return None

        fp = Path(full_path)
        for image_path in [Path(x).resolve() for x in album.image_paths]:
            try:
                return fp.relative_to(image_path).as_posix()
            except ValueError:
                continue

        # If not found in any path, return the filename
        return fp.name

    def validate_config(self) -> bool:
        """Validate the current configuration.

        Returns:
            True if configuration is valid
        """
        try:
            self.load_config()
            return True
        except Exception as e:
            print(f"Configuration validation failed: {e}")
            return False

    def has_albums(self) -> bool:
        """Check if any albums are configured.

        Returns:
            True if at least one album exists, False otherwise
        """
        config = self.load_config()
        return len(config.albums) > 0

    def is_first_run(self) -> bool:
        """Check if this is the first run (no config file and no albums).

        Returns:
            True if this appears to be the first run
        """
        return not self.config_path.exists() or not self.has_albums()

    def reload_config(self) -> Config:
        """Force reload configuration from file, clearing any cached data.

        Returns:
            Freshly loaded Config object
        """
        self._config = None  # Clear the cache
        return self.load_config()  # This will now re-read from file


# Convenience functions for creating albums
def create_album(
    key: str,
    name: str,
    image_paths: list[str],
    index: str,
    umap_eps: float,
    description: str = "",
    encoder_spec: str | None = None,
    min_search_score: float | None = None,
    max_search_results: int | None = None,
    use_query_optimization: bool | None = None,
    min_image_dimension: int | None = None,
) -> Album:
    """Create a new Album instance with validation.

    Each optional parameter falls through to the Album default when omitted,
    so existing callers don't have to thread every field.
    """
    image_paths = [str(Path(x).expanduser().resolve()) for x in image_paths]
    index = str(Path(index).expanduser().resolve())
    fields: dict[str, object] = {
        "key": key,
        "name": name,
        "image_paths": image_paths,
        "index": index,
        "umap_eps": umap_eps,
        "description": description,
    }
    if encoder_spec is not None:
        fields["encoder_spec"] = encoder_spec
    if min_search_score is not None:
        fields["min_search_score"] = min_search_score
    if max_search_results is not None:
        fields["max_search_results"] = max_search_results
    if use_query_optimization is not None:
        fields["use_query_optimization"] = use_query_optimization
    if min_image_dimension is not None:
        fields["min_image_dimension"] = min_image_dimension
    return Album(**fields)


@lru_cache(maxsize=1)
def get_config_manager(config_path: Path | None = None) -> ConfigManager:
    """Get a singleton instance of ConfigManager."""
    return ConfigManager(config_path=config_path)
