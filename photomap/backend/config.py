# photomap/backend/config.py
"""
Configuration management for PhotoMap backend.
This module handles loading, saving, and managing photo album configurations.
It uses a YAML file to store album details and provides methods to manipulate albums.
"""
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from platformdirs import user_config_dir
from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger(__name__)


class Album(BaseModel):
    """Represents a photo album configuration."""

    key: str = Field(..., description="Unique album identifier")
    name: str = Field(..., description="Display name for the album")
    image_paths: List[str] = Field(
        ..., min_length=1, description="List of paths containing images"
    )
    index: str = Field(..., description="Path to the embeddings index file")
    umap_eps: float = Field(default=0.2, description="UMAP epsilon parameter")
    description: str = Field(default="", description="Album description")

    @field_validator("image_paths")
    @classmethod
    def expand_and_validate_image_paths(cls, v: List[str]) -> List[str]:
        """Expand ~ and warn if image paths do not exist."""
        expanded = [str(Path(path).expanduser()) for path in v]
        for path in expanded:
            if not Path(path).exists():
                print(f"Warning: Image path does not exist: {path}")
        return expanded

    @field_validator("index")
    @classmethod
    def validate_index_path(cls, v: str) -> str:
        """Validate index path format."""
        index_path = Path(v).expanduser()
        if not index_path.suffix == ".npz":
            raise ValueError("Index file must have .npz extension")
        return index_path.as_posix()

    def to_dict(self) -> Dict[str, Any]:
        """Convert album to dictionary format for YAML."""
        return {
            "name": self.name,
            "image_paths": self.image_paths,
            "index": self.index,
            "umap_eps": self.umap_eps,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, key: str, data: Dict[str, Any]) -> "Album":
        """Create Album from dictionary."""
        return cls(
            key=key,
            name=data.get("name", key.capitalize()),
            image_paths=data.get("image_paths", []),
            index=data["index"],
            umap_eps=data.get("umap_eps", 0.07),
            description=data.get("description", ""),
        )


class Config(BaseModel):
    """Main configuration model."""

    config_version: str = Field("1.0.0", description="Configuration format version")
    albums: Dict[str, Album] = Field(
        default_factory=dict, description="Album configurations"
    )
    locationiq_api_key: Optional[str] = Field(
        default=None, description="LocationIQ API key for map services"
    )

    @field_validator("config_version")
    @classmethod
    def validate_version(cls, v: str) -> str:
        """Validate configuration version format."""
        try:
            # Simple version validation - should be in format x.y.z
            parts = v.split(".")
            if len(parts) != 3 or not all(part.isdigit() for part in parts):
                raise ValueError("Version must be in format x.y.z")
        except Exception:
            raise ValueError("Invalid version format")
        return v

    @model_validator(mode="after")
    def validate_albums(self) -> "Config":
        """Validate albums configuration."""
        if not self.albums:
            print("Warning: No albums configured")
        return self

    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary format for YAML."""
        return {
            "config_version": self.config_version,
            "albums": {key: album.to_dict() for key, album in self.albums.items()},
            "locationiq_api_key": self.locationiq_api_key,
        }


class ConfigManager:
    """Manages PhotoMap configuration file with Pydantic validation."""

    def __init__(self, config_path: Optional[Path] = None):
        """Initialize configuration manager.

        Args:
            config_path: Optional custom path to config file. If None, uses platform default.
        """
        self.config_path = config_path or self._get_default_config_path()
        self._config: Optional[Config] = None

    def _get_default_config_path(self) -> Path:
        """Get platform-specific default configuration file path."""
        # Try environment variable first
        if "PHOTOMAP_CONFIG" in os.environ:
            return Path(os.environ["PHOTOMAP_CONFIG"])

        # Use platformdirs for cross-platform config directory
        config_dir = Path(user_config_dir("photomap", "photomap"))
        config_dir.mkdir(parents=True, exist_ok=True)
        return config_dir / "config.yaml"

    def get_locationiq_api_key(self) -> Optional[str]:
        """Get the LocationIQ API key."""
        if os.environ.get(
            "PHOTOMAP_ALBUM_LOCKED"
        ):  # In locked-down environments, do not leak the locationIQ key
            return
        config = self.load_config()
        return config.locationiq_api_key

    def set_locationiq_api_key(self, api_key: Optional[str]) -> None:
        """Set the LocationIQ API key.

        Args:
            api_key: API key string or None to remove
        """
        if os.environ.get(
            "PHOTOMAP_ALBUM_LOCKED"
        ):  # In locked-down environments, do not allow changing the locationIQ key
            raise PermissionError("Album configuration is locked.")
        config = self.load_config()
        # Strip whitespace and treat empty strings as None
        config.locationiq_api_key = (
            api_key.strip() if api_key and api_key.strip() else None
        )
        self._config = config
        self.save_config()
        # Clear cache after saving to ensure fresh reads
        self._config = None

    def load_config(self) -> Config:
        """Load configuration from YAML file."""
        if self._config is None:
            if not self.config_path.exists():
                self._config = Config(
                    config_version="1.0.0",
                    albums={},
                    locationiq_api_key=None,
                )
            else:
                try:
                    with open(self.config_path, "r") as f:
                        config_data = yaml.safe_load(f)

                    # Convert album dictionaries to Album objects
                    albums = {}
                    for key, album_data in config_data.get("albums", {}).items():
                        albums[key] = Album.from_dict(key, album_data)

                    self._config = Config(
                        config_version=config_data.get("config_version", "1.0.0"),
                        albums=albums,
                        locationiq_api_key=config_data.get("locationiq_api_key"),
                    )

                except Exception as e:
                    raise RuntimeError(
                        f"Failed to load configuration from {self.config_path}: {e}"
                    )

        return self._config

    def save_config(self):
        """Save current configuration to file."""
        if self._config is None:
            raise RuntimeError("No configuration loaded")

        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)

            with open(self.config_path, "w") as f:
                yaml.safe_dump(
                    self._config.to_dict(), f, default_flow_style=False, indent=2
                )
        except Exception as e:
            raise RuntimeError(
                f"Failed to save configuration to {self.config_path}: {e}"
            )

    def get_albums(self) -> Dict[str, Album]:
        """Get all albums."""
        config = self.load_config()
        return config.albums.copy()

    def get_album(self, key: str) -> Optional[Album]:
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
        config = self.load_config()

        if key not in config.albums:
            return False

        del config.albums[key]
        self._config = config
        self.save_config()
        self._config = None  # Clear cache to ensure fresh reads
        return True

    def get_photo_albums_dict(self) -> Dict[str, str]:
        """Get albums in the old PHOTO_ALBUMS format for backward compatibility.

        Returns:
            Dictionary mapping album keys to their first image path
        """
        albums = self.get_albums()
        return {
            key: album.image_paths[0] if album.image_paths else ""
            for key, album in albums.items()
        }

    def find_image_in_album(self, album_key: str, relative_path: str) -> Optional[Path]:
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

    def get_relative_path(self, full_path: str, album_key: str) -> Optional[str]:
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
    image_paths: List[str],
    index: str,
    umap_eps: float,
    description: str = "",
) -> Album:
    """Create a new Album instance with validation.

    Args:
        key: Unique album identifier
        name: Display name for the album
        image_paths: List of paths containing images
        index: Path to the embeddings index file
        umap_eps: UMAP epsilon parameter
        description: Album description

    Returns:
        Validated Album instance
    """
    # expand ~ in paths and resolve
    image_paths = [str(Path(x).expanduser().resolve()) for x in image_paths]
    index = str(Path(index).expanduser().resolve())
    return Album(
        key=key,
        name=name,
        image_paths=image_paths,
        index=index,
        umap_eps=umap_eps,
        description=description,
    )


@lru_cache(maxsize=1)
def get_config_manager(config_path: Optional[Path] = None) -> ConfigManager:
    """Get a singleton instance of ConfigManager."""
    return ConfigManager(config_path=config_path)
