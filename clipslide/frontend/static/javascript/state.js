// state.js
// This file manages the state of the application, including slide management and metadata handling.

export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentTextToCopy: "", // Text to be copied to clipboard
  currentDelay: 5, // Delay in seconds for slide transitions
  mode: "random", // next slide selection when no search is active ("random", "sequential", "search")
  embeddingsFile: null, // Path to the current embeddings file
  highWaterMark: 20, // Maximum number of slides to load at once
  searchIndex: 0, // When in search mode, this is the index of the current slide in the search results
  searchResults: [], // List of file paths matching the current search query
  album: "family", // Default album to use}
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
    state.album = window.slideshowConfig.album || "family"; // Default to "family" if not set
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

  const storedAlbum = localStorage.getItem("album");
  if (storedAlbum) state.album = storedAlbum;
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", state.highWaterMark);
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
  localStorage.setItem("album", state.album);
}