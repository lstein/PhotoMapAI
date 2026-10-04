// page-visibility.js
// Refreshes the UMAP current-image marker when the page comes back from the
// background (iOS/iPad), where it can otherwise go missing.
//
// This module used to also back settings up to sessionStorage and restore
// them into localStorage on resume. That never helped — iOS empties both —
// and its periodic saves pushed the whole settings set to the server. The
// server now embeds each device's preferences in the page (see state.js).

import { updateCurrentImageMarker } from "./umap.js";

// Constants for timing
const UMAP_READY_TIMEOUT = 2000; // Maximum time to wait for UMAP plot to be ready
const UMAP_READY_CHECK_INTERVAL = 100; // Interval for checking UMAP plot readiness
const RESTORATION_DELAY = 100; // Delay before refreshing after the page returns

let wasHidden = false;

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

// Refresh the UMAP marker once the plot is ready again.
async function refreshUmapMarker() {
  const isReady = await waitForUmapReady();
  if (!isReady) {
    console.warn("UMAP plot not ready after timeout, skipping marker refresh");
    return;
  }
  try {
    updateCurrentImageMarker();
  } catch (e) {
    console.warn("Failed to refresh UMAP marker:", e);
  }
}

function scheduleRefresh() {
  setTimeout(() => refreshUmapMarker(), RESTORATION_DELAY);
}

function handleVisibilityChange() {
  if (document.hidden) {
    wasHidden = true;
  } else if (wasHidden) {
    scheduleRefresh();
  }
}

// Initialize page visibility handling
export function initializePageVisibilityHandling() {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  // Page lifecycle resume (Chromium) and bfcache restores (Safari).
  document.addEventListener("resume", scheduleRefresh, { capture: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      scheduleRefresh();
    }
  });
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  if (window.stateIsReady) {
    initializePageVisibilityHandling();
  } else {
    window.addEventListener("stateReady", () => {
      initializePageVisibilityHandling();
    });
  }
});
