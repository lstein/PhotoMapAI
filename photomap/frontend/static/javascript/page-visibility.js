// page-visibility.js
// This file handles page visibility changes and state persistence for iOS/iPad compatibility
// It addresses issues where localStorage is cleared and UMAP markers disappear when the app is backgrounded

import { state, restoreFromLocalStorage, saveSettingsToLocalStorage } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";

// Track if the page was hidden (for debugging and state restoration)
let wasHidden = false;
let visibilityChangeCount = 0;
let lastStateSnapshot = null;

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
    lastStateSnapshot = criticalState;
  } catch (e) {
    console.warn("Failed to backup state to sessionStorage:", e);
  }
}

// Restore state from sessionStorage backup if localStorage is missing critical data
function restoreStateFromSessionStorage() {
  try {
    const backup = sessionStorage.getItem("photomap_state_backup");
    if (!backup) return false;
    
    const criticalState = JSON.parse(backup);
    let restored = false;
    
    // Only restore if localStorage is missing critical data
    if (!localStorage.getItem("album") && criticalState.album) {
      localStorage.setItem("album", criticalState.album);
      state.album = criticalState.album;
      restored = true;
    }
    
    if (!localStorage.getItem("currentDelay") && criticalState.currentDelay) {
      localStorage.setItem("currentDelay", criticalState.currentDelay);
      state.currentDelay = criticalState.currentDelay;
      restored = true;
    }
    
    if (!localStorage.getItem("mode") && criticalState.mode) {
      localStorage.setItem("mode", criticalState.mode);
      state.mode = criticalState.mode;
      restored = true;
    }
    
    if (!localStorage.getItem("gridThumbSizeFactor") && criticalState.gridThumbSizeFactor !== undefined) {
      localStorage.setItem("gridThumbSizeFactor", criticalState.gridThumbSizeFactor);
      state.gridThumbSizeFactor = criticalState.gridThumbSizeFactor;
      restored = true;
    }
    
    if (!localStorage.getItem("minSearchScore") && criticalState.minSearchScore !== undefined) {
      localStorage.setItem("minSearchScore", criticalState.minSearchScore);
      state.minSearchScore = criticalState.minSearchScore;
      restored = true;
    }
    
    if (!localStorage.getItem("maxSearchResults") && criticalState.maxSearchResults !== undefined) {
      localStorage.setItem("maxSearchResults", criticalState.maxSearchResults);
      state.maxSearchResults = criticalState.maxSearchResults;
      restored = true;
    }
    
    if (!localStorage.getItem("umapShowLandmarks") && criticalState.umapShowLandmarks !== undefined) {
      localStorage.setItem("umapShowLandmarks", criticalState.umapShowLandmarks ? "true" : "false");
      state.umapShowLandmarks = criticalState.umapShowLandmarks;
      restored = true;
    }
    
    if (!localStorage.getItem("umapShowHoverThumbnails") && criticalState.umapShowHoverThumbnails !== undefined) {
      localStorage.setItem("umapShowHoverThumbnails", criticalState.umapShowHoverThumbnails ? "true" : "false");
      state.umapShowHoverThumbnails = criticalState.umapShowHoverThumbnails;
      restored = true;
    }
    
    if (!localStorage.getItem("umapExitFullscreenOnSelection") && criticalState.umapExitFullscreenOnSelection !== undefined) {
      localStorage.setItem("umapExitFullscreenOnSelection", criticalState.umapExitFullscreenOnSelection ? "true" : "false");
      state.umapExitFullscreenOnSelection = criticalState.umapExitFullscreenOnSelection;
      restored = true;
    }
    
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
  const missingKeys = criticalKeys.filter(key => !localStorage.getItem(key));
  
  if (missingKeys.length > 0) {
    console.warn("Missing critical localStorage keys:", missingKeys);
    const restored = restoreStateFromSessionStorage();
    
    if (restored) {
      // Re-apply restored state to UI
      await restoreFromLocalStorage();
      // Force album change event to update UI
      if (state.album) {
        window.dispatchEvent(new CustomEvent("albumChanged", { 
          detail: { album: state.album } 
        }));
      }
    }
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
      setTimeout(async () => {
        await verifyAndRestoreState();
        
        // Refresh the current image marker in UMAP
        // Use a timeout to ensure UMAP plot is ready
        setTimeout(() => {
          try {
            const plotDiv = document.getElementById("umapPlot");
            if (plotDiv && plotDiv.data && plotDiv.data.length > 0) {
              console.log("Refreshing UMAP current image marker...");
              updateCurrentImageMarker();
            }
          } catch (e) {
            console.warn("Failed to refresh UMAP marker:", e);
          }
        }, 1000);
      }, 100);
    }
  }
}

// Handle page freeze/resume events (iOS specific)
function handlePageFreeze() {
  console.log("Page freeze detected, backing up state...");
  saveSettingsToLocalStorage();
  backupStateToSessionStorage();
}

function handlePageResume() {
  console.log("Page resume detected, verifying state...");
  setTimeout(async () => {
    await verifyAndRestoreState();
    // Refresh UMAP marker
    setTimeout(() => {
      try {
        updateCurrentImageMarker();
      } catch (e) {
        console.warn("Failed to refresh UMAP marker on resume:", e);
      }
    }, 1000);
  }, 100);
}

// Periodic state backup (every 30 seconds) as an extra safety measure
function startPeriodicBackup() {
  setInterval(() => {
    if (!document.hidden) {
      saveSettingsToLocalStorage();
      backupStateToSessionStorage();
    }
  }, 30000); // 30 seconds
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
  // Wait for state to be ready before initializing
  window.addEventListener("stateReady", () => {
    initializePageVisibilityHandling();
  });
});
