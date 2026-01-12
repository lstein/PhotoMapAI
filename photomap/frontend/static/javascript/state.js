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
  // persisted search settings
  minSearchScore: 0.2, // [0.0, 1.0]
  maxSearchResults: 100, // [50, 500]
  // persisted UMAP settings
  umapShowLandmarks: true, // Show landmarks in UMAP
  umapShowHoverThumbnails: true, // Show hover thumbnails in UMAP
  umapExitFullscreenOnSelection: true, // Exit fullscreen when cluster is selected
  umapClickSelectsCluster: true, // Whether click selects cluster or single image
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

  const storedMinSearchScore = localStorage.getItem("minSearchScore");
  if (storedMinSearchScore !== null) {
    const v = Math.max(0.0, Math.min(1.0, parseFloat(storedMinSearchScore)));
    if (!Number.isNaN(v)) {
      state.minSearchScore = v;
    }
  }
  const storedMaxSearchResults = localStorage.getItem("maxSearchResults");
  if (storedMaxSearchResults !== null) {
    const v = Math.max(50, Math.min(500, parseInt(storedMaxSearchResults, 10)));
    if (!Number.isNaN(v)) {
      state.maxSearchResults = v;
    }
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
  localStorage.setItem("minSearchScore", state.minSearchScore);
  localStorage.setItem("maxSearchResults", state.maxSearchResults);
  localStorage.setItem("umapShowLandmarks", state.umapShowLandmarks ? "true" : "false");
  localStorage.setItem("umapShowHoverThumbnails", state.umapShowHoverThumbnails ? "true" : "false");
  localStorage.setItem("umapExitFullscreenOnSelection", state.umapExitFullscreenOnSelection ? "true" : "false");
  localStorage.setItem("umapClickSelectsCluster", state.umapClickSelectsCluster ? "true" : "false");
}

export async function setAlbum(newAlbumKey, force = false) {
  if (force || state.album !== newAlbumKey) {
    state.album = newAlbumKey;

    const metadata = await getIndexMetadata(state.album);

    state.dataChanged = true;
    saveSettingsToLocalStorage();

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

// NEW: setters for search settings (persist + notify)
export function setMinSearchScore(newScore) {
  const clamped = Math.max(0.0, Math.min(1.0, parseFloat(newScore)));
  if (!Number.isNaN(clamped) && state.minSearchScore !== clamped) {
    state.minSearchScore = clamped;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { minSearchScore: clamped } }));
  }
}

export function setMaxSearchResults(newMax) {
  const clamped = Math.max(50, Math.min(500, parseInt(newMax, 10)));
  if (!Number.isNaN(clamped) && state.maxSearchResults !== clamped) {
    state.maxSearchResults = clamped;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { maxSearchResults: clamped } }));
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
