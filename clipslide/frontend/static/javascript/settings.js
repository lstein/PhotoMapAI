// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { state } from "./state.js";
import { removeSlidesAfterCurrent } from "./swiper.js";

// Initialize settings from the server and local storage
document.addEventListener("DOMContentLoaded", async function () {
  initializeFromServer();
  restoreFromLocalStorage();

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
        removeSlidesAfterCurrent(); // Remove slides after the current one when changing mode
      }
    });
  }); // ✅ Added missing closing brace here!

  // Handlers for the settings modal
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsOverlay = document.getElementById("settingsOverlay");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const highWaterMarkInput = document.getElementById("highWaterMarkInput");
  const delayValueSpan = document.getElementById("delayValue");
  const modeRandom = document.getElementById("modeRandom");
  const modeSequential = document.getElementById("modeSequential");

  // Open settings modal and populate fields
  settingsBtn.addEventListener("click", () => {
    if (settingsOverlay.style.display === "none") {
      // Populate fields with current values
      highWaterMarkInput.value = state.highWaterMark;
      delayValueSpan.textContent = state.currentDelay;
      if (state.mode === "random") modeRandom.checked = true;
      if (state.mode === "sequential") modeSequential.checked = true;
      settingsOverlay.style.display = "block";
    } else {
      settingsOverlay.style.display = "none";
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
  
  // Save settings and close modal
  saveSettingsBtn.addEventListener("click", () => {
    settingsOverlay.style.display = "none";
  });
});

// Delay controls
const delayStep = 1; // seconds to increase/decrease per click
const minDelay = 1; // minimum delay in seconds
const maxDelay = 60; // maximum delay in seconds

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

// Initialize the state from the initial URL.
function initializeFromServer() {
  if (window.slideshowConfig) {
    state.currentDelay = window.slideshowConfig.currentDelay;
    state.mode = window.slideshowConfig.mode;
    state.embeddingsFile = window.slideshowConfig.embeddings_file;
  }
}

// Restore state from local storage
function restoreFromLocalStorage() {
  const storedHighWaterMark = localStorage.getItem("highWaterMark");
  if (storedHighWaterMark !== null)
    state.highWaterMark = parseInt(storedHighWaterMark, 10);

  const storedCurrentDelay = localStorage.getItem("currentDelay");
  if (storedCurrentDelay !== null)
    state.currentDelay = parseInt(storedCurrentDelay, 10);

  const storedMode = localStorage.getItem("mode");
  if (storedMode) state.mode = storedMode;
}

// Save state to local storage
export function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", state.highWaterMark);
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
}
