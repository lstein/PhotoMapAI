// events.js
// This file manages event listeners for the application, including slide transitions and slideshow controls.
import { aboutManager } from "./about.js";
import { checkAlbumIndex } from "./album-manager.js";
import { eventRegistry } from "./event-registry.js";
import { initializeGridSwiper } from "./grid-view.js";
import { deleteImage, getIndexMetadata } from "./index.js";
import {
  hideMetadataOverlay,
  showMetadataOverlay,
  toggleMetadataOverlay,
} from "./metadata-drawer.js";
import {
  getCurrentFilepath,
  getCurrentSlideIndex,
  slideState,
} from "./slide-state.js";
import { saveSettingsToLocalStorage, state } from "./state.js";
import {
  initializeSingleSwiper,
  pauseSlideshow,
  resumeSlideshow
} from "./swiper.js";
import { } from "./touch.js"; // Import touch event handlers
import { isUmapFullscreen, toggleUmapWindow } from "./umap.js";
import { hideSpinner, setCheckmarkOnIcon, showSpinner } from "./utils.js";

// Constants
const FULLSCREEN_INDICATOR_CONFIG = {
  showDuration: 800, // How long to show the indicator
  fadeOutDuration: 300, // Fade out animation duration
  playSymbol: "▶", // Play symbol
  pauseSymbol: "⏸", // Pause symbol
};

const KEYBOARD_SHORTCUTS = {
  // ArrowRight: () => navigateSlide('next'),
  // ArrowLeft: () => navigateSlide('prev'),
  ArrowUp: () => showMetadataOverlay(),
  ArrowDown: () => hideMetadataOverlay(),
  i: () => toggleMetadataOverlay(),
  Escape: () => hideMetadataOverlay(),
  f: () => toggleFullscreen(),
  g: () => toggleGridSwiperView(),
  m: () => toggleUmapWindow(),
  " ": (e) => handleSpacebarToggle(e),
};

// Cache DOM elements
let elements = {};

function cacheElements() {
  elements = {
    slideshow_title: document.getElementById("slideshow_title"),
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    copyTextBtn: document.getElementById("copyTextBtn"),
    startStopBtn: document.getElementById("startStopSlideshowBtn"),
    closeOverlayBtn: document.getElementById("closeOverlayBtn"),
    deleteCurrentFileBtn: document.getElementById("deleteCurrentFileBtn"),
    controlPanel: document.getElementById("controlPanel"),
    searchPanel: document.getElementById("searchPanel"),
    metadataOverlay: document.getElementById("metadataOverlay"),
    bannerDrawerContainer: document.getElementById("bannerDrawerContainer"),
    overlayDrawer: document.getElementById("overlayDrawer"),
    scoreDisplay: document.getElementById("fixedScoreDisplay"),
  };
}

// Toggle fullscreen mode
function toggleFullscreen() {
  const elem = document.documentElement;
  if (!document.fullscreenElement) {
    elem.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function handleFullscreenChange() {
  const isFullscreen = !!document.fullscreenElement;

  // Toggle visibility of UI panels
  [elements.controlPanel, elements.searchPanel, elements.scoreDisplay].forEach(
    (panel) => {
      if (panel) {
        panel.classList.toggle("hidden-fullscreen", isFullscreen);
      }
    }
  );
}

// Toggle the play/pause state using the spacebar
function handleSpacebarToggle(e) {
  e.preventDefault();
  e.stopPropagation();
  toggleSlideshowWithIndicator();
}

// Copy text to clipboard
// Note: this is legacy code and is awkwardly copying the filepath information
// from the slide dataset. This should be replaced with a more flexible system.
// In addition, there is duplicated code here for transiently displaying a checkmark
// after copying. This should be refactored.
// See metadata-drawer.js for a more robust implementation.
function handleCopyText() {
  const globalIndex = slideState.getCurrentSlide().globalIndex;
  if (globalIndex === -1) {
    alert("No image selected to copy.");
    return;
  }
  // Get the element of the current slide
  const slideEl = document.querySelector(
    `.swiper-slide[data-global-index='${globalIndex}']`
  );
  if (!slideEl) {
    alert("Current slide element not found.");
    return;
  }
  const filepath = slideEl.dataset.filepath || "";
  if (
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    navigator.clipboard
      .writeText(filepath)
      .then(() => {
        // Find the icon inside the copyTextBtn
        const btn = document.getElementById("copyTextBtn");
        if (btn) {
          // Try to find an SVG or icon inside the button
          const icon = btn.querySelector("svg, .icon, i") || btn;
          const originalIconHTML = icon.innerHTML;
          // SVG for a checkbox with a checkmark
          const checkSVG = `
          <svg width="18" height="18" viewBox="0 0 18 18">
            <rect x="2" y="2" width="14" height="14" rx="3" fill="#faea0e" stroke="#222" stroke-width="2"/>
            <polyline points="5,10 8,13 13,6" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        `;
          icon.innerHTML = checkSVG;
          setTimeout(() => {
            icon.innerHTML = originalIconHTML;
          }, 1000);
        }
      })
      .catch((err) => {
        alert("Failed to copy text: " + err);
      });
  } else {
    alert("Clipboard API not available. Please copy manually.");
  }
}

// Delete the current file
async function handleDeleteCurrentFile() {
  const [globalIndex, totalImages, searchIndex] = getCurrentSlideIndex();
  const currentFilepath = await getCurrentFilepath();

  if (globalIndex === -1 || !currentFilepath) {
    alert("No image selected for deletion.");
    return;
  }

  const confirmed = await confirmDelete(currentFilepath, globalIndex);
  if (!confirmed) return;

  try {
    showSpinner();
    await deleteImage(state.album, globalIndex);
    await handleSuccessfulDelete(globalIndex, searchIndex);
    hideSpinner();
  } catch (error) {
    hideSpinner();
    alert(`Failed to delete: ${error.message}`);
    console.error("Delete failed:", error);
  }
}

function showDeleteConfirmModal(filepath, globalIndex) {
  return new Promise((resolve) => {
    const modal = document.getElementById("deleteConfirmModal");
    const text = document.getElementById("deleteConfirmText");
    const dontAsk = document.getElementById("deleteDontAskAgain");
    const cancelBtn = document.getElementById("deleteCancelBtn");
    const confirmBtn = document.getElementById("deleteConfirmBtn");

    text.textContent = `Are you sure you want to delete this image?\n\n${filepath} (Index ${globalIndex})\n\nThis action cannot be undone.`;
    dontAsk.checked = false;
    modal.style.display = "flex";

    function cleanup(result) {
      modal.style.display = "none";
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
    }

    function onCancel() {
      cleanup(false);
      resolve(false);
    }
    function onConfirm() {
      if (dontAsk.checked) {
        state.suppressDeleteConfirm = true;
        saveSettingsToLocalStorage();
      }
      cleanup(true);
      resolve(true);
    }

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  });
}

async function confirmDelete(filepath, globalIndex) {
  if (state.suppressDeleteConfirm) return true;
  return await showDeleteConfirmModal(filepath, globalIndex);
}

async function handleSuccessfulDelete(globalIndex, searchIndex) {
  // synchronize the album information
  const metadata = await getIndexMetadata(state.album);

  // remove from search results, and adjust subsequent global indices downward by 1
  if (slideState.isSearchMode && slideState.searchResults?.length > 0) {
    slideState.searchResults.splice(searchIndex, 1);
    for (let i = 0; i < slideState.searchResults.length; i++) {
      if (slideState.searchResults[i].index > globalIndex) {
        slideState.searchResults[i].index -= 1;
      }
    }
  }

  // If the current globalIndex is after the deleted index, decrement it
  if (slideState.currentGlobalIndex > globalIndex) {
    slideState.currentGlobalIndex -= 1;
  }

  // Update total images
  slideState.totalAlbumImages = metadata.filename_count || 0;

  // TO DO: What happens when the last image is removed?!

  // Update the current swiper.
  const removedSlideIndex = state.swiper.slides.findIndex((slide) => {
    return parseInt(slide.dataset.globalIndex, 10) === globalIndex;
  });
  if (removedSlideIndex === -1) {
    console.warn("Deleted slide not found in swiper slides.");
    return;
  }
  await state.swiper.removeSlide(removedSlideIndex);
  slideState.navigateByOffset(0); // Stay on the same index, which is now the next image
}

// Toggle visibility of the fullscreen indicator
function showPlayPauseIndicator(isPlaying) {
  removeExistingIndicator();
  const indicator = createIndicator(isPlaying);
  showIndicatorWithAnimation(indicator);
}

function removeExistingIndicator() {
  const existingIndicator = document.getElementById("fullscreen-indicator");
  if (existingIndicator) {
    existingIndicator.remove();
  }
}

function createIndicator(isPlaying) {
  const indicator = document.createElement("div");
  indicator.id = "fullscreen-indicator";
  indicator.className = "fullscreen-playback-indicator";
  indicator.innerHTML = isPlaying
    ? FULLSCREEN_INDICATOR_CONFIG.playSymbol
    : FULLSCREEN_INDICATOR_CONFIG.pauseSymbol;

  document.body.appendChild(indicator);
  return indicator;
}

function showIndicatorWithAnimation(indicator) {
  // Trigger animation
  requestAnimationFrame(() => {
    indicator.classList.add("show");
  });

  // Remove after animation completes
  setTimeout(() => {
    indicator.classList.remove("show");
    setTimeout(() => {
      if (indicator.parentNode) {
        indicator.parentNode.removeChild(indicator);
      }
    }, FULLSCREEN_INDICATOR_CONFIG.fadeOutDuration);
  }, FULLSCREEN_INDICATOR_CONFIG.showDuration);
}

// Keyboard event handling
function handleKeydown(e) {
  // Prevent global shortcuts when typing in input fields
  if (shouldIgnoreKeyEvent(e)) {
    return;
  }

  const handler = KEYBOARD_SHORTCUTS[e.key];
  if (handler) {
    handler(e);
  }
}

function shouldIgnoreKeyEvent(e) {
  return (
    e.target.tagName === "INPUT" ||
    e.target.tagName === "TEXTAREA" ||
    e.target.isContentEditable
  );
}

// Button event listeners
function setupButtonEventListeners() {
  // Fullscreen button
  if (elements.fullscreenBtn) {
    elements.fullscreenBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  // Copy text button
  if (elements.copyTextBtn) {
    elements.copyTextBtn.addEventListener("click", handleCopyText);
  }

  // Start/stop slideshow button
  if (elements.startStopBtn) {
    elements.startStopBtn.addEventListener(
      "click",
      toggleSlideshowWithIndicator
    );
  }

  // Close overlay button
  if (elements.closeOverlayBtn) {
    elements.closeOverlayBtn.onclick = hideMetadataOverlay;
  }

  // Delete current file button
  if (elements.deleteCurrentFileBtn) {
    elements.deleteCurrentFileBtn.addEventListener(
      "click",
      handleDeleteCurrentFile
    );
  }

  // Overlay drawer button
  if (elements.overlayDrawer) {
    elements.overlayDrawer.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMetadataOverlay();
    });
  }
}

function setupGlobalEventListeners() {
  // Fullscreen change event
  document.addEventListener("fullscreenchange", handleFullscreenChange);

  // Keyboard navigation
  window.addEventListener("keydown", handleKeydown);
}

function setupAccessibility() {
  // Disable tabbing on buttons to prevent focus issues
  document.querySelectorAll("button").forEach((btn) => (btn.tabIndex = -1));

  // Handle radio button accessibility
  document.querySelectorAll('input[type="radio"]').forEach((rb) => {
    rb.tabIndex = -1; // Remove from tab order
    rb.addEventListener("mousedown", function (e) {
      e.preventDefault(); // Prevent focus on mouse down
    });
    rb.addEventListener("focus", function () {
      this.blur(); // Remove focus if somehow focused
    });
  });

  // Turn off labels if a user preference.
  showHidePanelText(!state.showControlPanelText);
}

function initializeTitle() {
  if (elements.slideshow_title && state.album) {
    elements.slideshow_title.textContent = "Slideshow - " + state.album;
  }
}

export function showHidePanelText(hide) {
  const className = "hide-panel-text";
  if (hide) {
    elements.controlPanel.classList.add(className);
    elements.searchPanel.classList.add(className);
    state.showControlPanelText = false;
  } else {
    elements.controlPanel.classList.remove(className);
    elements.searchPanel.classList.remove(className);
    state.showControlPanelText = true;
  }
}

export async function toggleSlideshowWithIndicator() {
  const isRunning = state.swiper?.autoplay?.running;

  if (isRunning) {
    pauseSlideshow();
    showPlayPauseIndicator(false); // Show pause indicator
  } else {
    if (state.gridViewActive) await toggleGridSwiperView(false); // Switch to swiper mode if in grid mode
    if (isUmapFullscreen()) toggleUmapWindow(false); // Close umap if open
    resumeSlideshow();
    showPlayPauseIndicator(true); // Show play indicator
  }
}

// Listen for slide changes to update UI
window.addEventListener("slideChanged", (e) => {
  const { globalIndex, searchIndex, totalCount, isSearchMode } = e.detail;
  // Update any UI elements that need to reflect current position
  // updateUIForSlideChange(e.detail); // TO COME
});

// MAIN INITIALIZATION FUNCTION
function initializeEvents() {
  cacheElements();
  initializeTitle();
  setupButtonEventListeners();
  setupGlobalEventListeners();
  setupAccessibility();
  checkAlbumIndex(); // Check if the album index exists before proceeding
}

function positionMetadataDrawer() {
  const seekSlider = document.getElementById("scoreSliderRow");
  const drawer = document.getElementById("bannerDrawerContainer");
  if (seekSlider && drawer) {
    const rect = seekSlider.getBoundingClientRect();
    // Add window scrollY to get absolute position
    const top = rect.bottom + window.scrollY;
    drawer.style.top = `${top + 8}px`; // 8px gap, adjust as needed
  }
}

// Initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", function () {
  initializeEvents();
  positionMetadataDrawer();
  window.addEventListener("resize", positionMetadataDrawer);
  const aboutBtn = document.getElementById("aboutBtn");
  const aboutModal = document.getElementById("aboutModal");
  const closeAboutBtn = document.getElementById("closeAboutBtn");

  if (aboutBtn && aboutModal) {
    aboutBtn.addEventListener("click", () => {
      aboutManager.showModal();
    });
  }
  if (closeAboutBtn && aboutModal) {
    closeAboutBtn.addEventListener("click", () => {
      aboutManager.hideModal();
    });
  }
  // Close modal when clicking outside content
  aboutModal.addEventListener("click", (e) => {
    if (e.target === aboutModal) {
      aboutManager.hideModal();
    }
  });
});

// Toggle grid/swiper views
export async function toggleGridSwiperView(gridView = null) {
  if (gridView === null) state.gridViewActive = !state.gridViewActive;
  else state.gridViewActive = gridView;
  saveSettingsToLocalStorage();

  const swiperContainer = document.querySelector(".swiper");
  const gridViewBtn = document.getElementById("gridViewBtn");
  const gridViewIcon = gridViewBtn.querySelector("svg");
  eventRegistry.removeAll("swiper");
  eventRegistry.removeAll("grid");
  swiperContainer.style.display = ""; // Always show the swiper container

  const pagination = document.querySelector(".swiper-pagination");
  if (pagination) {
    pagination.style.display = state.gridViewActive ? "none" : "";
  }

  if (state.gridViewActive) {
    await initializeGridSwiper();
  } else {
    await initializeSingleSwiper();
  }

  const event = new CustomEvent("swiperModeChanged", {
    detail: { isGridMode: state.gridViewActive },
  });
  window.dispatchEvent(event);
  setCheckmarkOnIcon(gridViewIcon, state.gridViewActive);
}

// Show/hide grid button
document.addEventListener("DOMContentLoaded", async function () {
  const gridViewBtn = document.getElementById("gridViewBtn");

  if (gridViewBtn)
    gridViewBtn.addEventListener("click", () => {
      if (isUmapFullscreen()) toggleUmapWindow(false); // Close umap if open
      toggleGridSwiperView();
    });
});

window.addEventListener("stateReady", function () {
  toggleGridSwiperView(state.gridViewActive);
});
