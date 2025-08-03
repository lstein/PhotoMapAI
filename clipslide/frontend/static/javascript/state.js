// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album.js";

export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentTextToCopy: "", // Text to be copied to clipboard
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "random", // next slide selection when no search is active ("random", "chronological", "search")
  highWaterMark: 20, // Maximum number of slides to load at once
  searchOrigin: 0, // When in search mode, this is the index of the first slide in swiper
  searchResults: [], // List of file paths matching the current search query
  album: null, // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed
};

document.addEventListener("DOMContentLoaded", async function () {
  await restoreFromLocalStorage();
  initializeFromServer();
  setAlbum(state.album, true);  // This raises the event that kicks off slide retrieval
});

// Initialize the state from the initial URL.
export function initializeFromServer() {
  console.log("Initializing state from server configuration...", window.slideshowConfig);
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
  console.log("Restoring state from local storage...");
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
  console.log("directly storing into state.album:", storedAlbum || albumList[0].key);
  state.album = storedAlbum || albumList[0].key;
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  console.log("Saving state to local storage:", state);
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
    console.trace("Setting new album:", newAlbumKey);
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
