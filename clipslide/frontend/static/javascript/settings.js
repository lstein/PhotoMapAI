// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { exitSearchMode } from "./search.js";
import { state } from "./state.js";
import { saveSettingsToLocalStorage } from "./state.js";
import { removeSlidesAfterCurrent, resetAllSlides } from "./swiper.js";

// Delay settings
const delayStep = 1; // seconds to increase/decrease per click
const minDelay = 1; // minimum delay in seconds
const maxDelay = 60; // maximum delay in seconds

// Export the function so other modules can use it
export async function loadAvailableAlbums() {
  try {
    const response = await fetch("available_albums/");
    const albums = await response.json();

    const albumSelect = document.getElementById("albumSelect");
    albumSelect.innerHTML = ""; // Clear placeholder

    // ✅ CHECK IF NO ALBUMS EXIST
    if (albums.length === 0) {
      // Show "no albums" message in dropdown
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No albums available";
      option.disabled = true;
      option.selected = true;
      albumSelect.appendChild(option);

      // ✅ FORCE OPEN ALBUM MANAGER IN SETUP MODE
      window.dispatchEvent(new CustomEvent("noAlbumsFound"));
      return;
    }

    albums.forEach((album) => {
      const option = document.createElement("option");
      option.value = album.key;
      option.textContent = album.name;
      option.dataset.embeddingsFile = album.embeddings_file; // Store embeddings path
      albumSelect.appendChild(option);
    });

    // Set current album after populating options
    albumSelect.value = state.album;
  } catch (error) {
    console.error("Failed to load albums:", error);
    // On error, also trigger setup mode
    window.dispatchEvent(new CustomEvent("noAlbumsFound"));
  }
}

// Load available albums from server (keep the existing function for backward compatibility)
async function loadAvailableAlbumsInternal() {
  return loadAvailableAlbums();
}

// Initialize settings from the server and local storage
document.addEventListener("DOMContentLoaded", async function () {
  // Load albums first
  await loadAvailableAlbumsInternal();

  let slowerBtn = document.getElementById("slowerBtn");
  let fasterBtn = document.getElementById("fasterBtn");

  slowerBtn.onclick = function () {
    let newDelay = Math.min(maxDelay, state.currentDelay + delayStep);
    setDelay(newDelay);
  };

  fasterBtn.onclick = function () {
    let newDelay = Math.max(minDelay, state.currentDelay - delayStep);
    setDelay(newDelay);
  };
  updateDelayDisplay(state.currentDelay);

  // Set initial radio button state based on current mode
  document.getElementById("modeRandom").checked = state.mode === "random";
  document.getElementById("modeSequential").checked =
    state.mode === "sequential";

  // Listen for changes to the radio buttons
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      if (this.checked) {
        state.mode = this.value;
        saveSettingsToLocalStorage();
        removeSlidesAfterCurrent();
      }
    });
  });

  // Handlers for the settings modal
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsOverlay = document.getElementById("settingsOverlay");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const highWaterMarkInput = document.getElementById("highWaterMarkInput");
  const delayValueSpan = document.getElementById("delayValue");
  const modeRandom = document.getElementById("modeRandom");
  const modeSequential = document.getElementById("modeSequential");
  const albumSelect = document.getElementById("albumSelect");

  // Open settings modal and populate fields
  settingsBtn.addEventListener("click", () => {
    if (settingsOverlay.style.display === "none") {
      // Populate fields with current values
      highWaterMarkInput.value = state.highWaterMark;
      delayValueSpan.textContent = state.currentDelay;
      albumSelect.value = state.album;
      if (state.mode === "random") modeRandom.checked = true;
      if (state.mode === "sequential") modeSequential.checked = true;
      settingsOverlay.style.display = "block";
    } else {
      settingsOverlay.style.display = "none";
    }
  });

  albumSelect.addEventListener("change", function () {
    const newAlbum = this.value;
    if (newAlbum !== state.album) {
      state.album = newAlbum;

      // Get embeddings file from the selected option
      const selectedOption = this.options[this.selectedIndex];
      state.embeddingsFile = selectedOption.dataset.embeddingsFile;

      // Clear search results when switching albums
      exitSearchMode();

      // Remove all slides after current when switching albums
      removeSlidesAfterCurrent();
      saveSettingsToLocalStorage();

      // Update page title
      const titleElement = document.getElementById("slideshow_title");
      if (titleElement) {
        titleElement.textContent = `Slideshow - ${newAlbum}`;
      }
      resetAllSlides();
    }
  });

  // Close modal without saving
  closeSettingsBtn.addEventListener("click", () => {
    settingsOverlay.style.display = "none";
  });

  // Optional: close overlay when clicking outside the modal
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.style.display = "none";
    }
  });

  highWaterMarkInput.addEventListener("input", function () {
    let newHighWaterMark = parseInt(highWaterMarkInput.value, 10);
    if (isNaN(newHighWaterMark) || newHighWaterMark < 2) {
      newHighWaterMark = 2;
    }
    if (newHighWaterMark > 100) {
      newHighWaterMark = 100;
    }
    state.highWaterMark = newHighWaterMark;
    saveSettingsToLocalStorage();
  });
});

function setDelay(newDelay) {
  newDelay = Math.max(minDelay, Math.min(maxDelay, newDelay));
  state.currentDelay = newDelay;
  state.swiper.params.autoplay.delay = state.currentDelay * 1000;
  updateDelayDisplay(newDelay);
  saveSettingsToLocalStorage();
}

// Update the displayed delay value
function updateDelayDisplay(newDelay) {
  const delayValueSpan = document.getElementById("delayValue");
  if (delayValueSpan) {
    delayValueSpan.textContent = newDelay;
  }
}
