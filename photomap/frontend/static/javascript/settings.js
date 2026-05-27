// settings.js
// This file manages the settings of the application, including saving and restoring settings to/from local storage
import { albumManager } from "./album-manager.js";
import { cancelPendingPatches } from "./preferences-client.js";
import { exitSearchMode } from "./search-ui.js";
import {
  clearPersistedSettingsCache,
  saveSettingsToLocalStorage,
  setAlbum,
  setAutotaggingEnabled,
  setWrapNavigation,
  state,
} from "./state.js";
import { clearImageLabelCache, setClusterLabels } from "./cluster-utils.js";
import { fetchJson, hideSpinner, showSpinner } from "./utils.js";

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
    deleteMethodTrash: document.getElementById("deleteMethodTrash"),
    deleteMethodImmediate: document.getElementById("deleteMethodImmediate"),
    wrapNavigationCheckbox: document.getElementById("wrapNavigationCheckbox"),
    gridThumbSizeFactor: document.getElementById("gridThumbSizeFactor"),
    gridThumbSizeFactorReset: document.getElementById("gridThumbSizeFactorReset"),
    autotaggingEnabledCheckbox: document.getElementById("autotaggingEnabledCheckbox"),
    resetAllPreferencesBtn: document.getElementById("resetAllPreferencesBtn"),
  };
}

// Export the function so other modules can use it
export async function loadAvailableAlbums() {
  try {
    const albums = await fetchJson("available_albums/");
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
  showSpinner();
  // Resolves when the swiper has finished rebuilding for the new album.
  // Listener attached before setAlbum so we don't miss the event for fast switches.
  const slidesReady = new Promise((resolve) => {
    const handler = () => {
      window.removeEventListener("slidesReset", handler);
      clearTimeout(safetyTimer);
      resolve();
    };
    window.addEventListener("slidesReset", handler);
    // Safety net: if anything in the rebuild errors out, we still hide the spinner.
    const safetyTimer = setTimeout(() => {
      window.removeEventListener("slidesReset", handler);
      resolve();
    }, 8000);
  });
  try {
    const album = await albumManager.getAlbum(newAlbum);
    exitSearchMode("switchAlbum");
    await setAlbum(newAlbum, true);
    updatePageTitle(album.name);
    await slidesReady;
  } finally {
    hideSpinner();
  }
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

  if (elements.deleteMethodTrash) {
    elements.deleteMethodTrash.checked = !!state.moveToTrash;
    elements.deleteMethodImmediate.checked = !state.moveToTrash;
  }

  if (elements.wrapNavigationCheckbox) {
    elements.wrapNavigationCheckbox.checked = !!state.wrapNavigation;
  }

  if (elements.autotaggingEnabledCheckbox) {
    elements.autotaggingEnabledCheckbox.checked = !!state.autotaggingEnabled;
  }

  // Set the grid thumbnail size factor spinner value
  if (elements.gridThumbSizeFactor) {
    elements.gridThumbSizeFactor.value = state.gridThumbSizeFactor;
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

function setupMoveToTrashControl() {
  if (!elements.deleteMethodTrash) {
    return;
  }
  document.querySelectorAll('input[name="deleteMethod"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      if (this.checked) {
        state.moveToTrash = this.value === "trash";
        saveSettingsToLocalStorage();
      }
    });
  });
}

function setupWrapNavigationControl() {
  if (!elements.wrapNavigationCheckbox) {
    return;
  }
  elements.wrapNavigationCheckbox.addEventListener("change", function () {
    setWrapNavigation(this.checked);
    // Rebuild around the current image so stale wrap-neighbors are dropped
    // (turning wrap off) or wrap-neighbors are loaded (turning wrap on).
    state.single_swiper?.resetAllSlides();
  });
}

function setupAutotaggingControl() {
  if (!elements.autotaggingEnabledCheckbox) {
    return;
  }
  elements.autotaggingEnabledCheckbox.addEventListener("change", function () {
    setAutotaggingEnabled(this.checked);
    // Drop any cluster/image labels currently in memory so the UI stops
    // showing them immediately when toggled off. On toggle-on, the caches
    // start fresh; new labels are fetched on the next album switch.
    setClusterLabels({});
    clearImageLabelCache();
  });
}

async function loadLocationIQApiKey() {
  try {
    if (!elements.locationiqApiKeyInput) {
      return;
    } // If album selection is locked, skip
    const data = await fetchJson("locationiq_key/");

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
    const result = await fetchJson("locationiq_key/", { json: { key: apiKey } });
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
  let data;
  try {
    data = await fetchJson("invokeai/config");
  } catch (error) {
    // Network/parse failures fall through to refreshInvokeAIStatus(); a
    // non-2xx HTTP response short-circuits before that, matching the
    // pre-refactor behaviour of bailing out without probing the URL.
    if (error.name === "HttpError") {
      return;
    }
    console.error("Failed to load InvokeAI settings:", error);
    await refreshInvokeAIStatus();
    return;
  }
  try {
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
    await fetchJson("invokeai/config", { json: body });
    return null;
  } catch (error) {
    if (error.name === "HttpError") {
      const detail = error.body?.detail;
      return detail ? String(detail) : `Save failed (${error.status})`;
    }
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
  let data;
  try {
    data = await fetchJson("invokeai/status");
  } catch (error) {
    if (error.name === "HttpError") {
      setInvokeAIAuthSectionVisible(false);
      setInvokeAIUrlError(`Status check failed (HTTP ${error.status})`);
      return;
    }
    console.error("Failed to probe InvokeAI status:", error);
    setInvokeAIAuthSectionVisible(false);
    setInvokeAIUrlError("Could not contact the status endpoint");
    return;
  }
  try {
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
    const boards = await fetchJson("invokeai/boards");
    renderBoardOptions(boards, invokeaiSelectedBoardId);
  } catch (error) {
    // Auth failure or upstream error — render a disabled dropdown so the
    // user knows the list couldn't be fetched but can still see what the
    // default (Uncategorized) will do.
    if (error.name !== "HttpError") {
      console.error("Failed to load InvokeAI boards:", error);
    }
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

// Reset-to-default handler for the grid-thumb-size spinner.
// (The min-search-score and max-search-results controls now live in the
// search dialog as per-album settings — see search-ui.js.)
function setupResetDefaultsControls() {
  if (elements.gridThumbSizeFactorReset && elements.gridThumbSizeFactor) {
    elements.gridThumbSizeFactorReset.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      elements.gridThumbSizeFactor.value = "1.0";
      elements.gridThumbSizeFactor.dispatchEvent(new Event("input", { bubbles: true }));
      elements.gridThumbSizeFactor.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  }
}

// "Reset to Defaults" button at the bottom of the modal. Confirms, then
// DELETE /preferences/ (which also clears the device cookie server-side),
// wipes the localStorage paint cache for owned keys, and reloads. The
// reload re-mints a fresh device cookie and the new device starts at
// model defaults.
function setupResetAllPreferencesButton() {
  if (!elements.resetAllPreferencesBtn) {
    return;
  }
  elements.resetAllPreferencesBtn.addEventListener("click", async () => {
    const ok = window.confirm(
      "Reset all PhotoMap preferences on this device to defaults? " + "Albums and bookmarks are not affected."
    );
    if (!ok) {
      return;
    }
    // Drop anything queued — we don't want a stale debounce firing a
    // PATCH against the freshly minted device after the DELETE.
    cancelPendingPatches();
    try {
      const response = await fetch("preferences/", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        console.warn("Reset preferences failed:", response.status);
        window.alert("Failed to reset preferences. Please try again.");
        return;
      }
    } catch (err) {
      console.warn("Reset preferences failed:", err);
      window.alert("Failed to reset preferences. Please try again.");
      return;
    }
    clearPersistedSettingsCache();
    window.location.reload();
  });
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
  setupMoveToTrashControl();
  setupWrapNavigationControl();
  setupGridThumbSizeFactorControl();
  setupResetDefaultsControls();
  setupResetAllPreferencesButton();
  setupAutotaggingControl();
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
