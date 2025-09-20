// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album-manager.js";
import { getIndexMetadata } from "./index.js";
import { switchAlbum } from "./settings.js";


// TO DO - CONVERT THIS INTO A CLASS
export const state = {
  swiper: null, // Will be initialized in swiper.js
  gridViewActive: false, // Whether the grid view is active
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "chronological", // next slide selection when no search is active ("random", "chronological")
  highWaterMark: 20, // Maximum number of slides to load at once
  album: null, // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed (TO DO - REVISIT THIS)
  suppressDeleteConfirm: false,
  gridThumbSizeFactor: 1.0,
};

document.addEventListener("DOMContentLoaded", async function () {
  await restoreFromLocalStorage();
  initializeFromServer();
  switchAlbum(state.album); // Initialize with the current album

  // Notify that state is ready
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
}

// Restore state from local storage
export async function restoreFromLocalStorage() {
  const storedCurrentDelay = localStorage.getItem("currentDelay");
  if (storedCurrentDelay !== null)
    state.currentDelay = parseInt(storedCurrentDelay, 10);

  const storedMode = localStorage.getItem("mode");
  if (storedMode) state.mode = storedMode;

  const storedShowControlPanelText = localStorage.getItem(
    "showControlPanelText"
  );
  if (storedShowControlPanelText !== null) {
    state.showControlPanelText = storedShowControlPanelText === "true";
  } else {
    state.showControlPanelText = window.innerWidth >= 600; // Default to true on larger screens;
  }

  let storedAlbum = localStorage.getItem("album");
  const albumList = await albumManager.fetchAvailableAlbums();
  if (!albumList || albumList.length === 0) return; // No albums available, do not set album
  if (storedAlbum) {
    // check that this is a valid album
    const validAlbum = albumList.find((album) => album.key === storedAlbum);
    if (!validAlbum) storedAlbum = null;
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
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
  localStorage.setItem("album", state.album);
  localStorage.setItem(
    "showControlPanelText",
    state.showControlPanelText || ""
  );
  localStorage.setItem("gridViewActive", state.gridViewActive ? "true" : "false");
  localStorage.setItem("suppressDeleteConfirm", state.suppressDeleteConfirm ? "true" : "false");
  localStorage.setItem("gridThumbSizeFactor", state.gridThumbSizeFactor);
}

export async function setAlbum(newAlbumKey, force = false) {
  if (force || state.album !== newAlbumKey) {
    state.album = newAlbumKey;
    
    const metadata = await getIndexMetadata(state.album);
    
    state.dataChanged = true;
    saveSettingsToLocalStorage();
    
    // Update the event to include the metadata for SlideStateManager
    window.dispatchEvent(
      new CustomEvent("albumChanged", { 
        detail: { 
          album: newAlbumKey,
          totalImages: metadata.filename_count || 0  // Pass this to SlideStateManager
        } 
      })
    );
  }
}

export function setMode(newMode) {
  if (state.mode !== newMode) {
    state.mode = newMode;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", { detail: { mode: newMode } })
    );
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
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", { detail: { delay: newDelay } })
    );
  }
}
