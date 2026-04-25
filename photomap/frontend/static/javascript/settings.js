// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { albumManager } from "./album-manager.js";
import { exitSearchMode } from "./search-ui.js";
import { saveSettingsToLocalStorage, setAlbum, setMaxSearchResults, setMinSearchScore, state } from "./state.js";

// Constants
const DELAY_CONFIG = {
  step: 1, // seconds to increase/decrease per click
  min: 1, // minimum delay in seconds
  max: 60, // maximum delay in seconds
};

// Cache DOM elements to avoid repeated queries
let elements = {};

export function cacheElements() {
  elements = {
    settingsBtn: document.getElementById("settingsBtn"),
    settingsOverlay: document.getElementById("settingsOverlay"),
    closeSettingsBtn: document.getElementById("closeSettingsBtn"),
    delayValueSpan: document.getElementById("delayValue"),
    modeRandom: document.getElementById("modeRandom"),
    modeChronological: document.getElementById("modeChronological"),
    albumSelect: document.getElementById("albumSelect"),
    titleElement: document.getElementById("slideshow_title"),
    slowerBtn: document.getElementById("slowerBtn"),
    fasterBtn: document.getElementById("fasterBtn"),
    locationiqApiKeyInput: document.getElementById("locationiqApiKeyInput"),
    invokeaiUrlInput: document.getElementById("invokeaiUrlInput"),
    invokeaiUsernameInput: document.getElementById("invokeaiUsernameInput"),
    invokeaiPasswordInput: document.getElementById("invokeaiPasswordInput"),
    invokeaiBoardSelect: document.getElementById("invokeaiBoardSelect"),
    invokeaiAuthSection: document.getElementById("invokeaiAuthSection"),
    invokeaiStatusHint: document.getElementById("invokeaiStatusHint"),
    showControlPanelTextCheckbox: document.getElementById("showControlPanelTextCheckbox"),
    confirmDeleteCheckbox: document.getElementById("confirmDeleteCheckbox"),
    gridThumbSizeFactor: document.getElementById("gridThumbSizeFactor"),
    minSearchScore: document.getElementById("minSearchScore"),
    maxSearchResults: document.getElementById("maxSearchResults"),
    gridThumbSizeFactorReset: document.getElementById("gridThumbSizeFactorReset"),
    minSearchScoreReset: document.getElementById("minSearchScoreReset"),
    maxSearchResultsReset: document.getElementById("maxSearchResultsReset"),
  };
}

// Export the function so other modules can use it
export async function loadAvailableAlbums() {
  try {
    const response = await fetch("available_albums/");
    const albums = await response.json();
    if (!elements.albumSelect) {
      return;
    } // If album selection is locked, skip

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
  const adjustment = direction === "slower" ? DELAY_CONFIG.step : -DELAY_CONFIG.step;
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
  elements.delayValueSpan.textContent = state.currentDelay;
  if (elements.albumSelect) {
    elements.albumSelect.value = state.album;
  }
  elements.modeRandom.checked = state.mode === "random";
  elements.modeChronological.checked = state.mode === "chronological";
  elements.showControlPanelTextCheckbox.checked = state.showControlPanelText;

  // Set the confirm delete checkbox state
  if (elements.confirmDeleteCheckbox) {
    elements.confirmDeleteCheckbox.checked = !state.suppressDeleteConfirm;
  }

  // Set the grid thumbnail size factor spinner value
  if (elements.gridThumbSizeFactor) {
    elements.gridThumbSizeFactor.value = state.gridThumbSizeFactor;
  }

  // search settings initial values
  if (elements.minSearchScore) {
    elements.minSearchScore.value = state.minSearchScore.toFixed(2);
  }
  if (elements.maxSearchResults) {
    elements.maxSearchResults.value = state.maxSearchResults;
  }

  await loadLocationIQApiKey();
  await loadInvokeAISettings();
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
        state.single_swiper.removeSlidesAfterCurrent();
        state.single_swiper.addNewSlide();
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
  if (!elements.albumSelect) {
    return;
  } // If album selection is locked, skip
  elements.albumSelect.addEventListener("change", function () {
    const newAlbum = this.value;
    if (newAlbum !== state.album) {
      switchAlbum(newAlbum);
      closeSettingsModal();
    }
  });
}

function setupConfirmDeleteControl() {
  if (!elements.confirmDeleteCheckbox) {
    return;
  }
  elements.confirmDeleteCheckbox.addEventListener("change", function () {
    state.suppressDeleteConfirm = !this.checked;
    saveSettingsToLocalStorage();
  });
}

async function loadLocationIQApiKey() {
  try {
    if (!elements.locationiqApiKeyInput) {
      return;
    } // If album selection is locked, skip
    const response = await fetch("locationiq_key/");
    const data = await response.json();

    if (data.has_key) {
      elements.locationiqApiKeyInput.placeholder = `Current key: ${data.key}`;
    } else {
      elements.locationiqApiKeyInput.placeholder = "Enter your LocationIQ API key (optional)";
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
      body: JSON.stringify({ key: apiKey }),
    });

    const result = await response.json();
    if (!result.success) {
      console.error("Failed to save API key:", result.message);
    }
  } catch (error) {
    console.error("Failed to save LocationIQ API key:", error);
  }
}

// Tracks the currently-selected board_id as returned by the backend so the
// auth/url refresh flow can restore the dropdown selection after re-populating.
let invokeaiSelectedBoardId = "";

export async function loadInvokeAISettings() {
  if (!elements.invokeaiUrlInput) {
    return;
  }
  try {
    const response = await fetch("invokeai/config");
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    elements.invokeaiUrlInput.value = data.url || "";
    if (elements.invokeaiUsernameInput) {
      elements.invokeaiUsernameInput.value = data.username || "";
    }
    if (elements.invokeaiPasswordInput) {
      // Never echo passwords; indicate if one is stored.
      elements.invokeaiPasswordInput.value = "";
      elements.invokeaiPasswordInput.placeholder = data.has_password
        ? "(password saved — leave blank to keep)"
        : "(optional, multi-user mode)";
    }
    invokeaiSelectedBoardId = data.board_id || "";
  } catch (error) {
    console.error("Failed to load InvokeAI settings:", error);
  }
  await refreshInvokeAIStatus();
}

// Captured lazily on first use so setInvokeAIUrlError can restore the original
// hint after clearing a validation error. Has to be lazy because cacheElements()
// runs after module import.
let _defaultInvokeAIHintHTML = null;

function setInvokeAIUrlError(message) {
  const hint = elements.invokeaiStatusHint;
  if (!hint) {
    return;
  }
  if (_defaultInvokeAIHintHTML === null) {
    _defaultInvokeAIHintHTML = hint.innerHTML;
  }
  if (message) {
    hint.style.color = "#c0392b";
    hint.setAttribute("role", "alert");
    hint.textContent = "";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚠ ";
    hint.appendChild(icon);
    hint.appendChild(document.createTextNode(message));
  } else {
    hint.style.color = "#666";
    hint.removeAttribute("role");
    hint.innerHTML = _defaultInvokeAIHintHTML;
  }
}

// Returns null on success, or the backend's error detail string on failure,
// so the caller can render it inline under the URL field.
async function saveInvokeAISettings() {
  if (!elements.invokeaiUrlInput) {
    return null;
  }
  const body = {
    url: elements.invokeaiUrlInput.value,
    username: elements.invokeaiUsernameInput ? elements.invokeaiUsernameInput.value : "",
  };
  // Only include password when the user actually typed one — otherwise the
  // backend keeps the stored value.
  if (elements.invokeaiPasswordInput && elements.invokeaiPasswordInput.value) {
    body.password = elements.invokeaiPasswordInput.value;
  }
  if (elements.invokeaiBoardSelect) {
    body.board_id = elements.invokeaiBoardSelect.value || "";
  }
  try {
    const response = await fetch("invokeai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = `Save failed (${response.status})`;
      try {
        const data = await response.json();
        if (data && data.detail) {
          detail = String(data.detail);
        }
      } catch {
        // Non-JSON body — keep the generic message.
      }
      return detail;
    }
    return null;
  } catch (error) {
    console.error("Failed to save InvokeAI settings:", error);
    return error.message || "Save failed";
  }
}

function setInvokeAIAuthSectionVisible(visible) {
  if (!elements.invokeaiAuthSection) {
    return;
  }
  elements.invokeaiAuthSection.hidden = !visible;
}

export async function refreshInvokeAIStatus() {
  // Don't even try to probe when the URL is blank — keep the auth rows
  // hidden so the UI stays calm for users who don't run InvokeAI. Also
  // clear any stale error from a previous typing session.
  if (!elements.invokeaiUrlInput || !elements.invokeaiUrlInput.value.trim()) {
    setInvokeAIAuthSectionVisible(false);
    setInvokeAIUrlError(null);
    return;
  }
  try {
    const response = await fetch("invokeai/status");
    if (!response.ok) {
      setInvokeAIAuthSectionVisible(false);
      setInvokeAIUrlError(`Status check failed (HTTP ${response.status})`);
      return;
    }
    const data = await response.json();
    const reachable = !!data.reachable;
    setInvokeAIAuthSectionVisible(reachable);
    if (reachable) {
      setInvokeAIUrlError(null);
      await loadInvokeAIBoards();
    } else {
      setInvokeAIUrlError(data.detail || "InvokeAI backend is not reachable");
    }
  } catch (error) {
    console.error("Failed to probe InvokeAI status:", error);
    setInvokeAIAuthSectionVisible(false);
    setInvokeAIUrlError("Could not contact the status endpoint");
  }
}

function renderBoardOptions(boards, selectedId) {
  const select = elements.invokeaiBoardSelect;
  if (!select) {
    return;
  }
  select.innerHTML = "";
  // "Uncategorized" (no board_id) is always available as the default.
  const uncategorized = document.createElement("option");
  uncategorized.value = "";
  uncategorized.textContent = "Uncategorized";
  select.appendChild(uncategorized);

  boards.forEach((board) => {
    const option = document.createElement("option");
    option.value = board.board_id;
    option.textContent = board.board_name;
    select.appendChild(option);
  });
  select.value = selectedId || "";
  // If the saved selection isn't in the returned list (board was deleted),
  // the value silently reverts to "" (Uncategorized) above — that's the
  // right default given the runtime fallback behaviour.
  select.disabled = false;
}

export async function loadInvokeAIBoards() {
  if (!elements.invokeaiBoardSelect) {
    return;
  }
  try {
    const response = await fetch("invokeai/boards");
    if (!response.ok) {
      // Auth failure or upstream error — render a disabled dropdown so the
      // user knows the list couldn't be fetched but can still see what the
      // default (Uncategorized) will do.
      elements.invokeaiBoardSelect.innerHTML = '<option value="">Uncategorized</option>';
      elements.invokeaiBoardSelect.value = "";
      elements.invokeaiBoardSelect.disabled = true;
      return;
    }
    const boards = await response.json();
    renderBoardOptions(boards, invokeaiSelectedBoardId);
  } catch (error) {
    console.error("Failed to load InvokeAI boards:", error);
    elements.invokeaiBoardSelect.innerHTML = '<option value="">Uncategorized</option>';
    elements.invokeaiBoardSelect.value = "";
    elements.invokeaiBoardSelect.disabled = true;
  }
}

function setupInvokeAISettingsControls() {
  if (!elements.invokeaiUrlInput) {
    return;
  }
  const debounced = (fn) => {
    let timeout = null;
    return () => {
      clearTimeout(timeout);
      timeout = setTimeout(fn, 600);
    };
  };
  // Every credential/URL edit has to save first and then probe status: the
  // status endpoint reads the persisted config, not whatever's in the field.
  // If the save was rejected (e.g. invalid URL scheme), skip the probe — the
  // persisted config still holds the previous value, so a probe would be
  // misleading — and surface the error inline under the URL field instead.
  const saveAndRefresh = async () => {
    const error = await saveInvokeAISettings();
    setInvokeAIUrlError(error);
    if (!error) {
      await refreshInvokeAIStatus();
    }
  };
  const debouncedSaveAndRefresh = debounced(saveAndRefresh);
  const textInputs = [elements.invokeaiUrlInput, elements.invokeaiUsernameInput, elements.invokeaiPasswordInput].filter(
    Boolean
  );
  textInputs.forEach((input) => {
    input.addEventListener("input", debouncedSaveAndRefresh);
    input.addEventListener("blur", saveAndRefresh);
  });
  if (elements.invokeaiBoardSelect) {
    elements.invokeaiBoardSelect.addEventListener("change", async () => {
      invokeaiSelectedBoardId = elements.invokeaiBoardSelect.value || "";
      const error = await saveInvokeAISettings();
      setInvokeAIUrlError(error);
    });
  }
}

function setupLocationIQApiKeyControl() {
  if (!elements.locationiqApiKeyInput) {
    return;
  } // If album selection is locked, skip

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

function setupGridThumbSizeFactorControl() {
  if (!elements.gridThumbSizeFactor) {
    return;
  }
  let debounceTimeout = null;
  elements.gridThumbSizeFactor.addEventListener("input", function () {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      let val = parseFloat(this.value);
      if (isNaN(val) || val < 0.5) {
        val = 0.5;
      }
      if (val > 2.0) {
        val = 2.0;
      }
      state.gridThumbSizeFactor = val;
      saveSettingsToLocalStorage();
      // Notify grid to reinitialize
      window.dispatchEvent(new CustomEvent("gridThumbSizeFactorChanged", { detail: { factor: val } }));
    }, 300); // 300ms debounce
  });
}

// wire search settings controls to state with clamping and persistence
function setupSearchSettingsControls() {
  // Minimum search score [0.00, 1.00]
  if (elements.minSearchScore) {
    elements.minSearchScore.addEventListener("input", function () {
      const val = this.value.trim();
      if (val === "") {
        return;
      } // let user type
      const num = Number(val);
      if (!Number.isFinite(num)) {
        return;
      }
      const clamped = Math.max(0.0, Math.min(1.0, num));
      setMinSearchScore(clamped);
    });

    elements.minSearchScore.addEventListener("blur", function () {
      const num = Number(this.value);
      const clamped = Number.isFinite(num) ? Math.max(0.0, Math.min(1.0, num)) : state.minSearchScore;
      setMinSearchScore(clamped);
      this.value = clamped.toFixed(2); // normalize on commit
    });
  }

  // Maximum results [50, 500]
  if (elements.maxSearchResults) {
    elements.maxSearchResults.addEventListener("input", function () {
      const val = this.value.trim();
      if (val === "") {
        return;
      }
      const num = parseInt(val, 10);
      if (!Number.isFinite(num)) {
        return;
      }
      const clamped = Math.max(50, Math.min(500, num));
      setMaxSearchResults(clamped);
    });

    elements.maxSearchResults.addEventListener("blur", function () {
      const num = parseInt(this.value, 10);
      const clamped = Number.isFinite(num) ? Math.max(50, Math.min(500, num)) : state.maxSearchResults;
      setMaxSearchResults(clamped);
      this.value = String(clamped); // normalize on commit
    });
  }
}

// NEW: reset-to-default handlers for three spinners
function setupResetDefaultsControls() {
  // Grid thumb size factor -> 1.0
  if (elements.gridThumbSizeFactorReset && elements.gridThumbSizeFactor) {
    elements.gridThumbSizeFactorReset.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      elements.gridThumbSizeFactor.value = "1.0";
      // Trigger existing input handlers so state/localStorage update
      elements.gridThumbSizeFactor.dispatchEvent(new Event("input", { bubbles: true }));
      elements.gridThumbSizeFactor.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  }

  // Minimum search score -> 0.20
  if (elements.minSearchScoreReset && elements.minSearchScore) {
    elements.minSearchScoreReset.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const defVal = 0.2;
      elements.minSearchScore.value = defVal.toString();
      // Update state via setter and normalize display on blur behavior
      setMinSearchScore(defVal);
      elements.minSearchScore.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  }

  // Maximum # search results -> 100
  if (elements.maxSearchResultsReset && elements.maxSearchResults) {
    elements.maxSearchResultsReset.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const defVal = 100;
      elements.maxSearchResults.value = String(defVal);
      setMaxSearchResults(defVal);
      elements.maxSearchResults.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  }
}

// Accordion section toggle
function setupAccordions() {
  document.querySelectorAll(".settings-accordion .accordion-header").forEach((header) => {
    const section = header.closest(".settings-accordion").dataset.section;
    const body = header.nextElementSibling;
    const storageKey = `settings-accordion-${section}`;

    // Restore persisted open/closed state
    const wasOpen = localStorage.getItem(storageKey) === "true";
    if (wasOpen) {
      header.setAttribute("aria-expanded", "true");
      body.classList.add("open");
    }

    header.addEventListener("click", () => {
      const expanded = header.getAttribute("aria-expanded") === "true";
      header.setAttribute("aria-expanded", String(!expanded));
      body.classList.toggle("open");
      localStorage.setItem(storageKey, String(!expanded));
    });
  });
}

// MAIN INITIALIZATION FUNCTION
async function initializeSettings() {
  cacheElements();

  // Load albums first
  await loadAvailableAlbums();

  // Setup all controls
  setupAccordions();
  setupDelayControls();
  setupModeControls();
  setupModalControls();
  setupAlbumSelector();
  setupLocationIQApiKeyControl();
  setupInvokeAISettingsControls();
  setupConfirmDeleteControl();
  setupGridThumbSizeFactorControl();
  setupSearchSettingsControls();
  setupResetDefaultsControls();
}

// Initialize settings from the server and local storage
document.addEventListener("DOMContentLoaded", initializeSettings);
document.addEventListener("settingsUpdated", initializeSettings);

// CSS styles
const styles = `
.setting-row {
  display: grid;
  grid-template-columns: 220px 1fr;
  align-items: center;
  gap: 1em;
  margin-top: 1em;
}

.setting-row label {
  font-size: 16px;
  color: #faea0e;
  text-align: right;
  justify-self: end;
  margin-bottom: 0;
  white-space: nowrap;
}

.setting-row input[type="checkbox"],
.setting-row input[type="password"],
.setting-row select,
.setting-row .album-selector-group {
  justify-self: start;
}

.setting-row .album-selector-group {
  display: flex;
  gap: 0.5em;
  align-items: center;
}

.setting-row small {
  grid-column: 2 / 3;
}
`;

// Append styles to the document
const styleSheet = document.createElement("style");
styleSheet.type = "text/css";
styleSheet.innerText = styles;
document.head.appendChild(styleSheet);
