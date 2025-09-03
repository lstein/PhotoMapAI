// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { albumManager } from "./album.js";
import { exitSearchMode } from "./search-ui.js";
import { saveSettingsToLocalStorage, setAlbum, state } from "./state.js";
import { addNewSlide, removeSlidesAfterCurrent } from "./swiper.js";

// Constants
const DELAY_CONFIG = {
  step: 1, // seconds to increase/decrease per click
  min: 1, // minimum delay in seconds
  max: 60, // maximum delay in seconds
};

const WATERMARK_CONFIG = {
  min: 2,
  max: 100,
};

// Cache DOM elements to avoid repeated queries
let elements = {};

function cacheElements() {
  elements = {
    settingsBtn: document.getElementById("settingsBtn"),
    settingsOverlay: document.getElementById("settingsOverlay"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    highWaterMarkInput: document.getElementById("highWaterMarkInput"),
    delayValueSpan: document.getElementById("delayValue"),
    modeRandom: document.getElementById("modeRandom"),
    modeChronological: document.getElementById("modeChronological"),
    albumSelect: document.getElementById("albumSelect"),
    titleElement: document.getElementById("slideshow_title"),
    slowerBtn: document.getElementById("slowerBtn"),
    fasterBtn: document.getElementById("fasterBtn"),
    locationiqApiKeyInput: document.getElementById("locationiqApiKeyInput"),
    showControlPanelTextCheckbox: document.getElementById(
      "showControlPanelTextCheckbox"
    ),
  };
}

// Export the function so other modules can use it
export async function loadAvailableAlbums() {
  try {
    const response = await fetch("available_albums/");
    const albums = await response.json();
    if (!elements.albumSelect) return; // If album selection is locked, skip

    elements.albumSelect.innerHTML = ""; // Clear placeholder

    // Check if there are no albums
    if (albums.length === 0) {
      addNoAlbumsOption();
      triggerSetupMode();
      return;
    }

    populateAlbumOptions(albums);
    // If albums are locked this element won't exist
    elements.albumSelect.value = state.album;
  } catch (error) {
    console.error("Failed to load albums:", error);
    triggerSetupMode();
  }
}

function addNoAlbumsOption() {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "No albums available";
  option.disabled = true;
  option.selected = true;
  elements.albumSelect.appendChild(option);
}

function populateAlbumOptions(albums) {
  albums.forEach((album) => {
    const option = document.createElement("option");
    option.value = album.key;
    option.textContent = album.name;
    option.dataset.embeddingsFile = album.embeddings_file; // Store embeddings path
    option.dataset.umapEps = album.umap_eps || 0.07; // Store EPS
    elements.albumSelect.appendChild(option);
  });
}

function triggerSetupMode() {
  window.dispatchEvent(new CustomEvent("noAlbumsFound"));
}

// Album switching logic
export async function switchAlbum(newAlbum) {
  const album = await albumManager.getAlbum(newAlbum);
  exitSearchMode("switchAlbum");
  setAlbum(newAlbum, true);
  updatePageTitle(album.name);
}

// Update the page title based on the current album
// This function is called when the album is switched
function updatePageTitle(albumName) {
  if (elements.titleElement) {
    elements.titleElement.textContent = albumName;
  }
}

// Delay management
function setDelay(newDelay) {
  newDelay = Math.max(DELAY_CONFIG.min, Math.min(DELAY_CONFIG.max, newDelay));
  state.currentDelay = newDelay;
  state.swiper.params.autoplay.delay = state.currentDelay * 1000;
  updateDelayDisplay(newDelay);
  saveSettingsToLocalStorage();
}

function updateDelayDisplay(newDelay) {
  if (elements.delayValueSpan) {
    elements.delayValueSpan.textContent = newDelay;
  }
}

function adjustDelay(direction) {
  const adjustment =
    direction === "slower" ? DELAY_CONFIG.step : -DELAY_CONFIG.step;
  const newDelay =
    direction === "slower"
      ? Math.min(DELAY_CONFIG.max, state.currentDelay + adjustment)
      : Math.max(DELAY_CONFIG.min, state.currentDelay + adjustment);
  setDelay(newDelay);
}

//  Model window management
export function openSettingsModal() {
  populateModalFields();
  elements.settingsOverlay.classList.add("visible");
}

export function closeSettingsModal() {
  elements.settingsOverlay.classList.remove("visible");
}

function toggleSettingsModal() {
  if (elements.settingsOverlay.classList.contains("visible")) {
    closeSettingsModal();
  } else {
    openSettingsModal();
  }
}

async function populateModalFields() {
  elements.highWaterMarkInput.value = state.highWaterMark;
  elements.delayValueSpan.textContent = state.currentDelay;
  if (elements.albumSelect)
    elements.albumSelect.value = state.album;
  elements.modeRandom.checked = state.mode === "random";
  elements.modeChronological.checked = state.mode === "chronological";
  elements.showControlPanelTextCheckbox.checked = state.showControlPanelText;

  await loadLocationIQApiKey();
}

// Function to validate the high water mark
function validateAndSetHighWaterMark(value) {
  let newHighWaterMark = parseInt(value, 10);
  if (isNaN(newHighWaterMark) || newHighWaterMark < WATERMARK_CONFIG.min) {
    newHighWaterMark = WATERMARK_CONFIG.min;
  }
  if (newHighWaterMark > WATERMARK_CONFIG.max) {
    newHighWaterMark = WATERMARK_CONFIG.max;
  }
  state.highWaterMark = newHighWaterMark;
  saveSettingsToLocalStorage();
}

// Event listener setup
function setupDelayControls() {
  elements.slowerBtn.onclick = () => adjustDelay("slower");
  elements.fasterBtn.onclick = () => adjustDelay("faster");
  updateDelayDisplay(state.currentDelay);
}

function setupModeControls() {
  // Set initial radio button state based on current mode
  elements.modeRandom.checked = state.mode === "random";
  elements.modeChronological.checked = state.mode === "chronological";

  // Listen for changes to the radio buttons
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      if (this.checked) {
        state.mode = this.value;
        saveSettingsToLocalStorage();
        removeSlidesAfterCurrent();
        addNewSlide();
      }
    });
  });
}

function setupModalControls() {
  // Toggle modal
  elements.settingsBtn.addEventListener("click", toggleSettingsModal);

  // Close modal
  elements.closeSettingsBtn.addEventListener("click", closeSettingsModal);

  // Close when clicking outside
  elements.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === elements.settingsOverlay) {
      closeSettingsModal();
    }
  });

  elements.showControlPanelTextCheckbox.addEventListener("change", function () {
    // Call showHidePanelText from events.js
    import("./events.js").then(({ showHidePanelText }) => {
      showHidePanelText(!this.checked);
    });
    // Optionally, persist to localStorage
    state.showControlPanelText = this.checked;
    localStorage.setItem("showControlPanelText", this.checked);
  });
}

function setupAlbumSelector() {
  if (!elements.albumSelect) return; // If album selection is locked, skip
  elements.albumSelect.addEventListener("change", function () {
    const newAlbum = this.value;
    if (newAlbum !== state.album) {
      switchAlbum(newAlbum);
      closeSettingsModal();
    }
  });
}

function setupHighWaterMarkControl() {
  elements.highWaterMarkInput.addEventListener("input", function () {
    validateAndSetHighWaterMark(this.value);
  });
}

async function loadLocationIQApiKey() {
  try {
    if (!elements.locationiqApiKeyInput) return; // If album selection is locked, skip
    const response = await fetch("locationiq_key/");
    const data = await response.json();

    if (data.has_key) {
      elements.locationiqApiKeyInput.placeholder = `Current key: ${data.key}`;
    } else {
      elements.locationiqApiKeyInput.placeholder =
        "Enter your LocationIQ API key (optional)";
    }
  } catch (error) {
    console.error("Failed to load LocationIQ API key:", error);
  }
}

async function saveLocationIQApiKey(apiKey) {
  try {
    const response = await fetch("locationiq_key/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_key: apiKey }),
    });

    const result = await response.json();
    if (!result.success) {
      console.error("Failed to save API key:", result.message);
    }
  } catch (error) {
    console.error("Failed to save LocationIQ API key:", error);
  }
}

function setupLocationIQApiKeyControl() {
  if (!elements.locationiqApiKeyInput) return; // If album selection is locked, skip

  // Load existing key on initialization
  loadLocationIQApiKey();
  elements.locationiqApiKeyInput.addEventListener("input", function () {
    // Debounce the save operation
    clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      saveLocationIQApiKey(this.value);
    }, 1000); // Save 1 second after user stops typing
  });

  elements.locationiqApiKeyInput.addEventListener("blur", function () {
    // Save immediately when field loses focus
    clearTimeout(this.saveTimeout);
    saveLocationIQApiKey(this.value);
  });
}

// MAIN INITIALIZATION FUNCTION
async function initializeSettings() {
  cacheElements();

  // Load albums first
  await loadAvailableAlbums();

  // Setup all controls
  setupDelayControls();
  setupModeControls();
  setupModalControls();
  setupAlbumSelector();
  setupHighWaterMarkControl();
  setupLocationIQApiKeyControl();
}

// Initialize settings from the server and local storage
document.addEventListener("DOMContentLoaded", initializeSettings);
document.addEventListener("settingsUpdated", initializeSettings);
