// state.js
// This file manages the state of the application, including slide management and metadata handling.

export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentTextToCopy: "", // Text to be copied to clipboard
  currentDelay: 5, // Delay in seconds for slide transitions
  showControlPanelText: true, // Whether to show text in control panels
  mode: "random", // next slide selection when no search is active ("random", "sequential", "search")
  embeddingsFile: null, // Path to the current embeddings file
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
    state.currentDelay = window.slideshowConfig.currentDelay;
    state.mode = window.slideshowConfig.mode;
    
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
export function restoreFromLocalStorage() {
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
  }

  const storedAlbum = localStorage.getItem("album");
  if (storedAlbum && storedAlbum !== "null") {
    setAlbum(storedAlbum);
  } else {
    setAlbum(null);
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

export function setAlbum(newAlbum) {
  if (state.album !== newAlbum) {
    state.album = newAlbum;
    state.dataChanged = true;
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: newAlbum } }));
  }
}