// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album.js";
import { switchAlbum } from "./settings.js";


// TO DO - CONVERT THIS INTO A CLASS
export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "chronological", // next slide selection when no search is active ("random", "chronological")
  highWaterMark: 20, // Maximum number of slides to load at once
  searchResults: [], // List of file paths matching the current search query
  album: null, // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed
};

document.addEventListener("DOMContentLoaded", async function () {
  await restoreFromLocalStorage();
  initializeFromServer();
  switchAlbum(state.album); // Initialize with the current album
});

// Initialize the state from the initial URL.
export function initializeFromServer() {
  if (window.slideshowConfig?.currentDelay > 0) {
    setDelay(window.slideshowConfig.currentDelay);
  }

  if (window.slideshowConfig?.mode !== null) {
    setMode(window.slideshowConfig.mode);
  }

  if (window.slideshowConfig?.highWaterMark !== null) {
    setHighWaterMark(window.slideshowConfig.highWaterMark);
  }

  if (window.slideshowConfig?.album !== null) {
    setAlbum(window.slideshowConfig.album);
  }
}

// Restore state from local storage
export async function restoreFromLocalStorage() {
  const storedHighWaterMark = localStorage.getItem("highWaterMark");
  if (storedHighWaterMark !== null)
    state.highWaterMark = parseInt(storedHighWaterMark, 10);

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
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", state.highWaterMark);
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
  localStorage.setItem("album", state.album);
  localStorage.setItem(
    "showControlPanelText",
    state.showControlPanelText || ""
  );
}

export async function setAlbum(newAlbumKey, force = false) {
  if (force || state.album !== newAlbumKey) {
    state.album = newAlbumKey;
    state.dataChanged = true;
    saveSettingsToLocalStorage();
    window.dispatchEvent(
      new CustomEvent("albumChanged", { detail: { album: newAlbumKey } })
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

export function setHighWaterMark(newHighWaterMark) {
  if (state.highWaterMark !== newHighWaterMark) {
    state.highWaterMark = newHighWaterMark;
    localStorage.setItem("highWaterMark", newHighWaterMark);
    window.dispatchEvent(
      new CustomEvent("settingsUpdated", {
        detail: { highWaterMark: newHighWaterMark },
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
