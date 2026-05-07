// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album-manager.js";
import { getIndexMetadata } from "./index.js";

// TO DO - CONVERT THIS INTO A CLASS
export const state = {
  single_swiper: null, // Will be initialized in swiper.js
  grid_swiper: null, // Will be initialized in grid-view.js
  gridViewActive: false, // Whether the grid view is active
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "chronological", // next slide selection when no search is active ("random", "chronological")
  highWaterMark: 20, // Maximum number of slides to load at once
  album: null, // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed (TO DO - REVISIT THIS)
  suppressDeleteConfirm: false, // Flag to suppress delete confirmation dialogs
  gridThumbSizeFactor: 1.0, // Scaling factor for grid thumbnails
  swiper: null, // backwards compatibility hack; contains the single_swiper.swiper instance
  albumLocked: false, // Whether album management is locked
  // Per-album search settings — values are loaded from the album's config on
  // album switch and persisted back via /update_album/ when the user edits
  // them in the search dialog. Initial values are placeholders before the
  // first album is loaded.
  minSearchScore: 0.2, // [0.0, 1.0]
  maxSearchResults: 100, // positive integer
  useQueryOptimization: true, // SigLIP-only; ignored by other encoders
  albumEncoderSpec: null, // mirrored from the active album's config
  // persisted UMAP settings
  umapShowLandmarks: true, // Show landmarks in UMAP
  umapShowHoverThumbnails: true, // Show hover thumbnails in UMAP
  umapExitFullscreenOnSelection: true, // Exit fullscreen when cluster is selected
  umapClickSelectsCluster: true, // Whether click selects cluster or single image
  umapControlsVisible: true, // Whether the UMAP controls panel is visible
};

document.addEventListener("DOMContentLoaded", async () => {
  await restoreFromLocalStorage();
  initializeFromServer();
  window.stateIsReady = true; // Flag for modules that may need to know if state is ready
  window.dispatchEvent(new Event("stateReady"));
});

// Initialize the state from the initial URL.
export function initializeFromServer() {
  if (window.slideshowConfig?.currentDelay > 0) {
    setDelay(window.slideshowConfig.currentDelay);
  }

  if (window.slideshowConfig?.mode !== null) {
    setMode(window.slideshowConfig.mode);
  }

  if (window.slideshowConfig?.album !== null) {
    setAlbum(window.slideshowConfig.album);
  }

  if (window.slideshowConfig?.albumLocked !== undefined) {
    state.albumLocked = window.slideshowConfig.albumLocked;
  }
}

// Restore state from local storage
export async function restoreFromLocalStorage() {
  const storedCurrentDelay = localStorage.getItem("currentDelay");
  if (storedCurrentDelay !== null) {
    state.currentDelay = parseInt(storedCurrentDelay, 10);
  }

  const storedMode = localStorage.getItem("mode");
  if (storedMode) {
    state.mode = storedMode;
  }

  const storedShowControlPanelText = localStorage.getItem("showControlPanelText");
  if (storedShowControlPanelText !== null) {
    state.showControlPanelText = storedShowControlPanelText === "true";
  } else {
    state.showControlPanelText = window.innerWidth >= 600; // Default to true on larger screens;
  }

  let storedAlbum = localStorage.getItem("album");
  const albumList = await albumManager.fetchAvailableAlbums();
  if (!albumList || albumList.length === 0) {
    return;
  } // No albums available, do not set album
  if (storedAlbum) {
    // check that this is a valid album
    const validAlbum = albumList.find((album) => album.key === storedAlbum);
    if (!validAlbum) {
      storedAlbum = null;
    }
  }
  state.album = storedAlbum || albumList[0].key;

  const storedGridViewActive = localStorage.getItem("gridViewActive");
  if (storedGridViewActive !== null) {
    state.gridViewActive = storedGridViewActive === "true";
  }

  const storedSuppressDeleteConfirm = localStorage.getItem("suppressDeleteConfirm");
  if (storedSuppressDeleteConfirm !== null) {
    state.suppressDeleteConfirm = storedSuppressDeleteConfirm === "true";
  }

  const storedGridThumbSizeFactor = localStorage.getItem("gridThumbSizeFactor");
  if (storedGridThumbSizeFactor !== null) {
    state.gridThumbSizeFactor = parseFloat(storedGridThumbSizeFactor);
  }

  const storedUmapShowLandmarks = localStorage.getItem("umapShowLandmarks");
  if (storedUmapShowLandmarks !== null) {
    state.umapShowLandmarks = storedUmapShowLandmarks === "true";
  }

  const storedUmapShowHoverThumbnails = localStorage.getItem("umapShowHoverThumbnails");
  if (storedUmapShowHoverThumbnails !== null) {
    state.umapShowHoverThumbnails = storedUmapShowHoverThumbnails === "true";
  }

  const storedUmapExitFullscreenOnSelection = localStorage.getItem("umapExitFullscreenOnSelection");
  if (storedUmapExitFullscreenOnSelection !== null) {
    state.umapExitFullscreenOnSelection = storedUmapExitFullscreenOnSelection === "true";
  }

  const storedUmapClickSelectsCluster = localStorage.getItem("umapClickSelectsCluster");
  if (storedUmapClickSelectsCluster !== null) {
    state.umapClickSelectsCluster = storedUmapClickSelectsCluster === "true";
  }

  const storedUmapControlsVisible = localStorage.getItem("umapControlsVisible");
  if (storedUmapControlsVisible !== null) {
    state.umapControlsVisible = storedUmapControlsVisible === "true";
  }
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
  localStorage.setItem("album", state.album);
  localStorage.setItem("showControlPanelText", state.showControlPanelText || "");
  localStorage.setItem("gridViewActive", state.gridViewActive ? "true" : "false");
  localStorage.setItem("suppressDeleteConfirm", state.suppressDeleteConfirm ? "true" : "false");
  localStorage.setItem("gridThumbSizeFactor", state.gridThumbSizeFactor);
  localStorage.setItem("umapShowLandmarks", state.umapShowLandmarks ? "true" : "false");
  localStorage.setItem("umapShowHoverThumbnails", state.umapShowHoverThumbnails ? "true" : "false");
  localStorage.setItem("umapExitFullscreenOnSelection", state.umapExitFullscreenOnSelection ? "true" : "false");
  localStorage.setItem("umapClickSelectsCluster", state.umapClickSelectsCluster ? "true" : "false");
  localStorage.setItem("umapControlsVisible", state.umapControlsVisible ? "true" : "false");
}

export async function setAlbum(newAlbumKey, force = false) {
  if (force || state.album !== newAlbumKey) {
    state.album = newAlbumKey;

    const metadata = await getIndexMetadata(state.album);

    state.dataChanged = true;
    saveSettingsToLocalStorage();

    // Reload per-album search settings (min score / max results /
    // SigLIP query optimization). Don't fail the album switch if this errors
    // — just keep the previous values and log.
    await applyAlbumSearchSettings(newAlbumKey).catch((err) =>
      console.warn("Failed to load per-album search settings:", err)
    );

    // dispatch an album changed event to system
    window.dispatchEvent(
      new CustomEvent("albumChanged", {
        detail: {
          album: newAlbumKey,
          totalImages: metadata.filename_count || 0, // Pass this to SlideStateManager
        },
      })
    );
  }
}

// Pulls per-album search settings from the backend and copies them into
// state. Called on every album switch so the search dialog always reflects
// the active album.
async function applyAlbumSearchSettings(albumKey) {
  const response = await fetch(`album/${encodeURIComponent(albumKey)}/`);
  if (!response.ok) {
    return;
  }
  const album = await response.json();
  if (typeof album.min_search_score === "number") {
    state.minSearchScore = album.min_search_score;
  }
  if (typeof album.max_search_results === "number") {
    state.maxSearchResults = album.max_search_results;
  }
  if (typeof album.use_query_optimization === "boolean") {
    state.useQueryOptimization = album.use_query_optimization;
  }
  if (typeof album.encoder_spec === "string") {
    state.albumEncoderSpec = album.encoder_spec;
  }
  // Notify listeners (the search dialog) that values changed.
  window.dispatchEvent(
    new CustomEvent("albumSearchSettingsLoaded", {
      detail: {
        encoder_spec: album.encoder_spec,
        min_search_score: album.min_search_score,
        max_search_results: album.max_search_results,
        use_query_optimization: album.use_query_optimization,
      },
    })
  );
}

// Persist the current state's per-album search settings back to the active
// album via /update_album/. Called from the search dialog onChange handlers.
// Errors are logged but not surfaced — the in-memory state stays correct
// even if the persistence write fails, and the next album switch will
// reload from the backend.
let _persistTimer = null;
export function persistCurrentAlbumSearchSettings() {
  if (!state.album) {
    return;
  }
  // Debounce so rapid edits (slider drags, keystrokes) collapse to one
  // network write at the end.
  if (_persistTimer) {
    clearTimeout(_persistTimer);
  }
  _persistTimer = setTimeout(async () => {
    _persistTimer = null;
    const albumKey = state.album;
    try {
      const response = await fetch(`album/${encodeURIComponent(albumKey)}/`);
      if (!response.ok) {
        return;
      }
      const album = await response.json();
      const payload = {
        ...album,
        min_search_score: state.minSearchScore,
        max_search_results: state.maxSearchResults,
        use_query_optimization: state.useQueryOptimization,
      };
      await fetch("update_album/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn("Failed to persist album search settings:", err);
    }
  }, 400);
}

export function setMode(newMode) {
  if (state.mode !== newMode) {
    state.mode = newMode;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { mode: newMode } }));
  }
}

export function setShowControlPanelText(showText) {
  if (state.showControlPanelText !== showText) {
    state.showControlPanelText = showText;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", {
        detail: { showControlPanelText: showText },
      })
    );
  }
}

export function setDelay(newDelay) {
  if (state.currentDelay !== newDelay) {
    state.currentDelay = newDelay;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { delay: newDelay } }));
  }
}

// Per-album search-setting setters. The search dialog calls these on user
// edit, then persists the change back to the active album via
// /update_album/. Album switches overwrite these via setAlbum below.
export function setMinSearchScore(newScore) {
  const clamped = Math.max(0.0, Math.min(1.0, parseFloat(newScore)));
  if (!Number.isNaN(clamped) && state.minSearchScore !== clamped) {
    state.minSearchScore = clamped;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { minSearchScore: clamped } }));
  }
}

export function setMaxSearchResults(newMax) {
  const clamped = Math.max(1, parseInt(newMax, 10));
  if (!Number.isNaN(clamped) && state.maxSearchResults !== clamped) {
    state.maxSearchResults = clamped;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { maxSearchResults: clamped } }));
  }
}

export function setUseQueryOptimization(value) {
  const bool = !!value;
  if (state.useQueryOptimization !== bool) {
    state.useQueryOptimization = bool;
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { useQueryOptimization: bool } }));
  }
}

export function setUmapShowLandmarks(showLandmarks) {
  if (state.umapShowLandmarks !== showLandmarks) {
    state.umapShowLandmarks = showLandmarks;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { umapShowLandmarks: showLandmarks } }));
  }
}

export function setUmapShowHoverThumbnails(showHoverThumbnails) {
  if (state.umapShowHoverThumbnails !== showHoverThumbnails) {
    state.umapShowHoverThumbnails = showHoverThumbnails;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", { detail: { umapShowHoverThumbnails: showHoverThumbnails } })
    );
  }
}

export function setUmapExitFullscreenOnSelection(exitFullscreenOnSelection) {
  if (state.umapExitFullscreenOnSelection !== exitFullscreenOnSelection) {
    state.umapExitFullscreenOnSelection = exitFullscreenOnSelection;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", { detail: { umapExitFullscreenOnSelection: exitFullscreenOnSelection } })
    );
  }
}

export function setUmapClickSelectsCluster(clickSelectsCluster) {
  if (state.umapClickSelectsCluster !== clickSelectsCluster) {
    state.umapClickSelectsCluster = clickSelectsCluster;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", { detail: { umapClickSelectsCluster: clickSelectsCluster } })
    );
  }
}

export function setUmapControlsVisible(visible) {
  if (state.umapControlsVisible !== visible) {
    state.umapControlsVisible = visible;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { umapControlsVisible: visible } }));
  }
}
