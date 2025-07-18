// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { state } from "./state.js";
import { saveSettingsToLocalStorage } from "./state.js";
import { removeSlidesAfterCurrent, resetAllSlides } from "./swiper.js";

// Delay settings
const delayStep = 1; // seconds to increase/decrease per click
const minDelay = 1; // minimum delay in seconds
const maxDelay = 60; // maximum delay in seconds

// Load available albums from server
async function loadAvailableAlbums() {
  try {
    const response = await fetch("available_albums/");
    const albums = await response.json();

    const albumSelect = document.getElementById("albumSelect");
    albumSelect.innerHTML = ""; // Clear placeholder

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
    // Fallback to hardcoded options
    const albumSelect = document.getElementById("albumSelect");
    albumSelect.innerHTML = `
      <option value="family" data-embeddings-file="/net/cubox/CineRAID/Pictures/embeddings.npz">Family</option>
    `;
    albumSelect.value = state.album;
  }
}

// Initialize settings from the server and local storage
document.addEventListener("DOMContentLoaded", async function () {
  // Load albums first
  await loadAvailableAlbums();

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
  const albumSelect = document.getElementById("albumSelect"); // ✅ Add album selector

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
      state.searchResults = [];
      state.searchIndex = 0;

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
