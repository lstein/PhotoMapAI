"""Per-device UI preferences, persisted server-side and keyed by an opaque cookie.

Lives in a JSON file (sibling to the YAML album config) because preferences
mutate constantly, scale per-device, and have different versioning concerns
from album data. The cookie itself is set in
``photomap.backend.routers.preferences``; this module is storage-only.
"""
from __future__ import annotations

import logging
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from .config import get_config_manager
from .util import atomic_write_text

logger = logging.getLogger(__name__)


class _CamelModel(BaseModel):
    """Wire format is camelCase to match state.js field names."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class UserPreferences(_CamelModel):
    """Mirrors the PERSISTED_SETTINGS registry in static/javascript/state.js.

    Defaults track the in-memory defaults declared on ``state`` so a fresh
    device returning a default record produces the same UI as before
    server-side prefs existed.
    """

    # Slideshow / navigation
    current_delay: int = Field(default=5, ge=1, le=3600)
    mode: Literal["chronological", "random"] = "chronological"
    wrap_navigation: bool = False

    # Chrome / layout
    show_control_panel_text: bool = True
    grid_view_active: bool = False
    grid_thumb_size_factor: float = Field(default=1.0, gt=0.0, le=4.0)

    # Deletion
    suppress_delete_confirm: bool = False
    move_to_trash: bool = True

    # UMAP
    umap_show_landmarks: bool = True
    umap_show_hover_thumbnails: bool = True
    umap_exit_fullscreen_on_selection: bool = True
    umap_click_selects_cluster: bool = True
    umap_controls_visible: bool = True

    # Metadata drawer / cluster labels
    show_metadata_fields: bool = True
    autotagging_enabled: bool = False

    # Dataset Curator panel. Ranges mirror the HTML input min/max attrs in
    # templates/modules/curation.html — the frontend clamps too, but server
    # validation defends against a stale tab posting an out-of-range value
    # after a future HTML change tightens the bounds.
    curation_target_count: int = Field(default=80, ge=10, le=1000)
    curation_iterations: int = Field(default=20, ge=1, le=30)
    curation_method: Literal["fps", "kmeans"] = "fps"
    curation_exclude_threshold: int = Field(default=90, ge=1, le=100)

    # Stragglers currently in localStorage
    album: str | None = None
    curation_export_path: str | None = None

    # Server-stamped; lets the frontend reconcile a stale localStorage cache.
    updated_at: float = 0.0


class _PreferencesStore(BaseModel):
    """On-disk shape: ``{device_id: UserPreferences}``."""

    version: int = 1
    devices: dict[str, UserPreferences] = Field(default_factory=dict)


class PreferencesManager:
    """Read/modify ``preferences.json`` with re-entrant locking."""

    def __init__(self, path: Path | None = None):
        self.path = path or self._default_path()
        self._store: _PreferencesStore | None = None
        # Re-entrant so a single caller can hold the lock across a
        # load → mutate → save sequence without deadlocking itself.
        self._lock = threading.RLock()

    @staticmethod
    def _default_path() -> Path:
        # Sit next to whatever config.yaml ConfigManager resolved — this means
        # tests that set PHOTOMAP_CONFIG automatically isolate preferences.json
        # without needing a second env var.
        config_path = get_config_manager().config_path
        return config_path.parent / "preferences.json"

    def _load(self) -> _PreferencesStore:
        with self._lock:
            if self._store is None:
                if self.path.exists():
                    try:
                        self._store = _PreferencesStore.model_validate_json(
                            self.path.read_text()
                        )
                    except (ValidationError, ValueError) as e:
                        # Corrupt or schema-mismatched file: log and start
                        # fresh rather than 500'ing every API call. The next
                        # save will overwrite it.
                        logger.warning(
                            f"Could not parse preferences file {self.path}: {e}. "
                            "Starting with empty preferences."
                        )
                        self._store = _PreferencesStore()
                else:
                    self._store = _PreferencesStore()
            return self._store

    def _flush(self) -> None:
        # Caller holds self._lock.
        assert self._store is not None
        atomic_write_text(self.path, self._store.model_dump_json(indent=2))

    def get(self, device_id: str) -> UserPreferences:
        """Return this device's preferences, or fresh defaults if unset."""
        with self._lock:
            return self._load().devices.get(device_id) or UserPreferences()

    def patch(self, device_id: str, partial: dict) -> UserPreferences:
        """Merge ``partial`` over the device's existing prefs and persist.

        ``partial`` keys may be either camelCase (wire format from the
        frontend) or snake_case — Pydantic's alias machinery accepts both.
        Unknown keys are dropped via ``extra="ignore"``. Range/Literal
        violations on known keys raise ``ValidationError``, which the router
        layer translates to 422.
        """
        with self._lock:
            store = self._load()
            current = store.devices.get(device_id, UserPreferences())
            # Dump current as a plain dict (snake_case), then layer the
            # partial on top. by_alias=False so the merge keyspace stays
            # consistent regardless of which casing the partial uses, since
            # model_validate will accept either.
            merged_dict = {**current.model_dump(), **partial}
            merged = UserPreferences.model_validate(merged_dict)
            merged.updated_at = time.time()
            store.devices[device_id] = merged
            self._flush()
            return merged

    def replace(self, device_id: str, prefs: UserPreferences) -> UserPreferences:
        """Overwrite the device's record with ``prefs`` (used by PUT)."""
        with self._lock:
            store = self._load()
            prefs.updated_at = time.time()
            store.devices[device_id] = prefs
            self._flush()
            return prefs

    def forget(self, device_id: str) -> bool:
        """Drop this device's record. Returns True if there was one."""
        with self._lock:
            store = self._load()
            removed = store.devices.pop(device_id, None) is not None
            if removed:
                self._flush()
            return removed

    def reload(self) -> None:
        """Drop the in-memory cache so the next read goes back to disk.

        Used by tests that mutate the on-disk file directly.
        """
        with self._lock:
            self._store = None


@lru_cache(maxsize=1)
def get_preferences_manager() -> PreferencesManager:
    """Singleton accessor mirroring ``get_config_manager``."""
    return PreferencesManager()
