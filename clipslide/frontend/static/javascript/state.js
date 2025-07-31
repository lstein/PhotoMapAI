// state.js
// This file manages the state of the application, including slide management and metadata handling.
import { albumManager } from "./album.js";

export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentTextToCopy: "", // Text to be copied to clipboard
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "random", // next slide selection when no search is active ("random", "sequential", "search")
  highWaterMark: 20, // Maximum number of slides to load at once
  searchOrigin: 0, // When in search mode, this is the index of the first slide in swiper
  searchResults: [], // List of file paths matching the current search query
  album: "family", // Default album to use
  availableAlbums: [], // List of available albums
  dataChanged: true, // Flag to indicate if umap data has changed
}

document.addEventListener("DOMContentLoaded", async function () {
  initializeFromServer();
  restoreFromLocalStorage();
});

// Initialize the state from the initial URL.
export function initializeFromServer() {
  if (window.slideshowConfig) {
    setDelay(window.slideshowConfig.currentDelay || 5);
    setMode(window.slideshowConfig.mode || "random");
    
    if (window.slideshowConfig.album) {
      setAlbum(window.slideshowConfig.album);
    } else {
      setAlbum(null);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('noAlbumsFound'));
      }, 100);
    }
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

  const storedShowControlPanelText = localStorage.getItem("showControlPanelText");
  if (storedShowControlPanelText !== null) {
    state.showControlPanelText = storedShowControlPanelText === "true";
  } else {
    state.showControlPanelText = window.innerWidth >= 600; // Default to true on larger screens;
  }

  const storedAlbum = localStorage.getItem("album");
  if (storedAlbum && storedAlbum !== "null") {
    setAlbum(storedAlbum);
  } else {
    // call out to the server to get the current album
    const album_list = await albumManager.fetchAvailableAlbums();
    if (album_list.length > 0)
      setAlbum(album_list[0].key);
    else
      setAlbum(null); // Default to null album if no albums found
  }
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", state.highWaterMark);
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
  localStorage.setItem("album", state.album);
  localStorage.setItem("showControlPanelText", state.showControlPanelText || "");
}

export async function setAlbum(newAlbumKey) {
  if (state.album !== newAlbumKey) {
    state.album = newAlbumKey;
    state.dataChanged = true;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: newAlbumKey } }));
  }
}

export function setMode(newMode) {
  if (state.mode !== newMode) {
    state.mode = newMode;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { mode: newMode } }));
  }
}

export function setDelay(newDelay) {
  if (state.currentDelay !== newDelay) {
    state.currentDelay = newDelay;
    saveSettingsToLocalStorage();
    window.dispatchEvent(new CustomEvent("settingsUpdated", { detail: { delay: newDelay } }));
  }
}
