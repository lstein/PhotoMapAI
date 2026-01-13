// page-visibility.js
// This file handles page visibility changes and state persistence for iOS/iPad compatibility
// It addresses issues where localStorage is cleared and UMAP markers disappear when the app is backgrounded

import { state, restoreFromLocalStorage, saveSettingsToLocalStorage } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";

// Track if the page was hidden (for debugging and state restoration)
let wasHidden = false;
let visibilityChangeCount = 0;

// Constants for timing
const UMAP_READY_TIMEOUT = 2000; // Maximum time to wait for UMAP plot to be ready
const UMAP_READY_CHECK_INTERVAL = 100; // Interval for checking UMAP plot readiness
const STATE_RESTORATION_DELAY = 100; // Delay before starting state restoration
const PERIODIC_BACKUP_INTERVAL = 30000; // Periodic state backup interval (30 seconds)

// Create a backup of critical state in sessionStorage
// sessionStorage is more persistent than localStorage on iOS when app is backgrounded
function backupStateToSessionStorage() {
  try {
    const criticalState = {
      album: state.album,
      currentDelay: state.currentDelay,
      mode: state.mode,
      showControlPanelText: state.showControlPanelText,
      gridViewActive: state.gridViewActive,
      suppressDeleteConfirm: state.suppressDeleteConfirm,
      gridThumbSizeFactor: state.gridThumbSizeFactor,
      minSearchScore: state.minSearchScore,
      maxSearchResults: state.maxSearchResults,
      umapShowLandmarks: state.umapShowLandmarks,
      umapShowHoverThumbnails: state.umapShowHoverThumbnails,
      umapExitFullscreenOnSelection: state.umapExitFullscreenOnSelection,
    };
    sessionStorage.setItem("photomap_state_backup", JSON.stringify(criticalState));
  } catch (e) {
    console.warn("Failed to backup state to sessionStorage:", e);
  }
}

// Helper function to convert boolean values for localStorage storage
function booleanToStorage(value) {
  return value ? "true" : "false";
}

// Helper function to convert stored string values to boolean
function storageToBoolean(value) {
  return value === true || value === "true";
}

// Helper function to restore a single localStorage item from sessionStorage backup
function restoreLocalStorageItem(key, backupValue, stateKey, converter = (v) => v) {
  if (!localStorage.getItem(key) && backupValue !== undefined) {
    try {
      const convertedValue = converter(backupValue);
      // Store booleans as "true"/"false" strings in localStorage
      const storageValue = typeof backupValue === "boolean" ? booleanToStorage(backupValue) : String(backupValue);
      localStorage.setItem(key, storageValue);
      state[stateKey] = convertedValue;
      return true;
    } catch (e) {
      console.warn(`Failed to restore ${key} to localStorage:`, e);
      return false;
    }
  }
  return false;
}

// Restore state from sessionStorage backup if localStorage is missing critical data
function restoreStateFromSessionStorage() {
  try {
    const backup = sessionStorage.getItem("photomap_state_backup");
    if (!backup) {
      return false;
    }

    const criticalState = JSON.parse(backup);
    let restored = false;

    // Restore all critical settings using helper function
    restored = restoreLocalStorageItem("album", criticalState.album, "album") || restored;
    restored =
      restoreLocalStorageItem("currentDelay", criticalState.currentDelay, "currentDelay", (v) => parseInt(v, 10)) ||
      restored;
    restored = restoreLocalStorageItem("mode", criticalState.mode, "mode") || restored;
    restored =
      restoreLocalStorageItem(
        "showControlPanelText",
        criticalState.showControlPanelText,
        "showControlPanelText",
        storageToBoolean
      ) || restored;
    restored =
      restoreLocalStorageItem("gridViewActive", criticalState.gridViewActive, "gridViewActive", storageToBoolean) ||
      restored;
    restored =
      restoreLocalStorageItem(
        "suppressDeleteConfirm",
        criticalState.suppressDeleteConfirm,
        "suppressDeleteConfirm",
        storageToBoolean
      ) || restored;
    restored =
      restoreLocalStorageItem(
        "gridThumbSizeFactor",
        criticalState.gridThumbSizeFactor,
        "gridThumbSizeFactor",
        parseFloat
      ) || restored;
    restored =
      restoreLocalStorageItem("minSearchScore", criticalState.minSearchScore, "minSearchScore", parseFloat) || restored;
    restored =
      restoreLocalStorageItem("maxSearchResults", criticalState.maxSearchResults, "maxSearchResults", (v) =>
        parseInt(v, 10)
      ) || restored;
    restored =
      restoreLocalStorageItem(
        "umapShowLandmarks",
        criticalState.umapShowLandmarks,
        "umapShowLandmarks",
        storageToBoolean
      ) || restored;
    restored =
      restoreLocalStorageItem(
        "umapShowHoverThumbnails",
        criticalState.umapShowHoverThumbnails,
        "umapShowHoverThumbnails",
        storageToBoolean
      ) || restored;
    restored =
      restoreLocalStorageItem(
        "umapExitFullscreenOnSelection",
        criticalState.umapExitFullscreenOnSelection,
        "umapExitFullscreenOnSelection",
        storageToBoolean
      ) || restored;

    if (restored) {
      console.log("State restored from sessionStorage backup");
      // Dispatch an event to notify other components
      window.dispatchEvent(new CustomEvent("stateRestored", { detail: { source: "sessionStorage" } }));
    }

    return restored;
  } catch (e) {
    console.warn("Failed to restore state from sessionStorage:", e);
    return false;
  }
}

// Verify localStorage integrity and restore from backup if needed
async function verifyAndRestoreState() {
  // Check if critical localStorage keys are missing
  const criticalKeys = ["album", "currentDelay", "mode"];
  const missingKeys = criticalKeys.filter((key) => !localStorage.getItem(key));

  if (missingKeys.length > 0) {
    console.warn("Missing critical localStorage keys:", missingKeys);
    const restored = restoreStateFromSessionStorage();

    if (restored) {
      // Re-apply restored state to UI
      await restoreFromLocalStorage();
      // Force album change event to update UI
      if (state.album) {
        window.dispatchEvent(
          new CustomEvent("albumChanged", {
            detail: { album: state.album },
          })
        );
      }
    }
  }
}

// Wait for UMAP plot to be ready with polling
async function waitForUmapReady() {
  const startTime = Date.now();

  while (Date.now() - startTime < UMAP_READY_TIMEOUT) {
    const plotDiv = document.getElementById("umapPlot");
    if (plotDiv && plotDiv.data && plotDiv.data.length > 0) {
      return true; // UMAP is ready
    }
    // Wait for next check interval
    await new Promise((resolve) => setTimeout(resolve, UMAP_READY_CHECK_INTERVAL));
  }

  return false; // Timeout reached
}

// Handle state restoration and UMAP marker refresh after page becomes visible
async function handleStateRestorationAfterVisibility() {
  await verifyAndRestoreState();

  // Refresh the current image marker in UMAP
  // Poll to ensure UMAP plot is ready
  const isReady = await waitForUmapReady();

  if (isReady) {
    try {
      console.log("Refreshing UMAP current image marker...");
      updateCurrentImageMarker();
    } catch (e) {
      console.warn("Failed to refresh UMAP marker:", e);
    }
  } else {
    console.warn("UMAP plot not ready after timeout, skipping marker refresh");
  }
}

// Handle page visibility changes
function handleVisibilityChange() {
  visibilityChangeCount++;

  if (document.hidden) {
    // Page is being hidden (backgrounded)
    wasHidden = true;
    console.log("Page hidden, backing up state...");

    // Save current state to both localStorage and sessionStorage
    saveSettingsToLocalStorage();
    backupStateToSessionStorage();
  } else {
    // Page is becoming visible again
    console.log("Page visible again (change #" + visibilityChangeCount + ")");

    if (wasHidden) {
      // Verify and restore state if needed
      setTimeout(() => handleStateRestorationAfterVisibility(), STATE_RESTORATION_DELAY);
    }
  }
}

// Handle page freeze/resume events (iOS specific)
function handlePageFreeze() {
  console.log("Page freeze detected, backing up state...");
  try {
    saveSettingsToLocalStorage();
    backupStateToSessionStorage();
  } catch (e) {
    console.warn("Failed to backup state during page freeze:", e);
  }
}

function handlePageResume() {
  console.log("Page resume detected, verifying state...");
  setTimeout(() => handleStateRestorationAfterVisibility(), STATE_RESTORATION_DELAY);
}

// Periodic state backup (every 30 seconds) as an extra safety measure
let periodicBackupIntervalId = null;

function startPeriodicBackup() {
  // Clear any existing interval to avoid duplicates
  if (periodicBackupIntervalId) {
    clearInterval(periodicBackupIntervalId);
  }

  periodicBackupIntervalId = setInterval(() => {
    if (!document.hidden) {
      try {
        saveSettingsToLocalStorage();
        backupStateToSessionStorage();
      } catch (e) {
        console.warn("Failed to perform periodic backup:", e);
      }
    }
  }, PERIODIC_BACKUP_INTERVAL);
}

// Stop periodic backup (for cleanup)
export function stopPeriodicBackup() {
  if (periodicBackupIntervalId) {
    clearInterval(periodicBackupIntervalId);
    periodicBackupIntervalId = null;
  }
}

// Initialize page visibility handling
export function initializePageVisibilityHandling() {
  console.log("Initializing page visibility handling for iOS compatibility...");

  // Listen for visibility changes
  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Listen for page lifecycle events (iOS specific)
  document.addEventListener("freeze", handlePageFreeze, { capture: true });
  document.addEventListener("resume", handlePageResume, { capture: true });

  // Also listen for pagehide/pageshow as backup
  window.addEventListener("pagehide", handlePageFreeze);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      // Page was restored from bfcache (back-forward cache)
      console.log("Page restored from bfcache");
      handlePageResume();
    }
  });

  // Start periodic backup
  startPeriodicBackup();

  // Create initial backup
  backupStateToSessionStorage();

  console.log("Page visibility handling initialized");
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Check if state is already ready (in case event already fired)
  if (window.stateIsReady) {
    initializePageVisibilityHandling();
  } else {
    // Wait for state to be ready before initializing
    window.addEventListener("stateReady", () => {
      initializePageVisibilityHandling();
    });
  }
});
