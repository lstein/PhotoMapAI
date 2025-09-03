// events.js
// This file manages event listeners for the application, including slide transitions and slideshow controls.
import { checkAlbumIndex } from "./album.js";
import { deleteImage } from "./index.js";
import {
  hideMetadataOverlay,
  showMetadataOverlay,
  toggleMetadataOverlay,
  updateMetadataOverlay,
} from "./metadata-drawer.js";
import { state } from "./state.js";
import {
  addNewSlide,
  getCurrentFilepath,
  getCurrentSlideIndex,
  pauseSlideshow,
  resumeSlideshow,
  updateSlideshowIcon
} from "./swiper.js";
import { } from "./touch.js"; // Import touch event handlers
import { toggleUmapWindow } from "./umap.js";
import { hideSpinner, showSpinner } from "./utils.js";

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
  [elements.controlPanel, elements.searchPanel].forEach((panel) => {
    if (panel) {
      panel.classList.toggle("hidden-fullscreen", isFullscreen);
    }
  });
}

// Toggle slideshow controls
function toggleSlideshow() {
  if (state.swiper?.autoplay?.running) {
    state.swiper.autoplay.stop();
  } else if (state.swiper?.autoplay) {
    state.swiper.autoplay.start();
  }
  updateSlideshowIcon();
}

function navigateSlide(direction) {
  pauseSlideshow(); // Pause on navigation
  if (direction === "next") {
    state.swiper.slideNext();
  } else {
    state.swiper.slidePrev();
  }
}

// Toggle the play/pause state using the spacebar
function handleSpacebarToggle(e) {
  e.preventDefault();
  e.stopPropagation();
  toggleSlideshowWithIndicator();
}

// Copy text to clipboard
function handleCopyText() {
  const activeSlide = state.swiper.slides[state.swiper.activeIndex];
  if (activeSlide) {
    const filepath = activeSlide.dataset.filepath || "";
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(filepath)
        .catch((err) => {
          alert("Failed to copy text: " + err);
        });
    } else {
      alert("Clipboard API not available. Please copy manually.");
    }
  }
}

// Delete the current file
async function handleDeleteCurrentFile() {
  const [globalIndex, totalImages, searchIndex] = await getCurrentSlideIndex();
  const currentFilepath = await getCurrentFilepath();

  if (globalIndex === -1 || !currentFilepath) {
    alert("No image selected for deletion.");
    return;
  }

  if (!confirmDelete(currentFilepath, globalIndex)) {
    return;
  }

  try {
    showSpinner();
    await deleteImage(state.album, globalIndex);
    await handleSuccessfulDelete(globalIndex, searchIndex);
    hideSpinner();
    console.log("Image deleted successfully");
  } catch (error) {
    hideSpinner();
    alert(`Failed to delete image: ${error.message}`);
    console.error("Delete failed:", error);
  }
}

function confirmDelete(filepath, globalIndex) {
  return confirm(
    `Are you sure you want to delete this image?\n\n${filepath} (Index ${globalIndex})\n\nThis action cannot be undone.`
  );
}

async function handleSuccessfulDelete(globalIndex, searchIndex) {
  // remove from search results, and adjust subsequent global indices downward by 1
  if (state.searchResults?.length > 0) {
      state.searchResults.splice(searchIndex, 1);
      for (let i = 0; i < state.searchResults.length; i++) {
        if (state.searchResults[i].index > globalIndex) {
          state.searchResults[i].index -= 1;
        } 
    }
  }

  // Remove the current slide from the swiper
  if (state.swiper?.slides?.length > 0) {
    // find index of the currentFilePath
    const currentIndex = state.swiper.slides.findIndex(
      (slide) => slide.dataset.index === globalIndex.toString()
    );
    if (currentIndex === -1) {
      console.warn("Current file with global index not found in swiper slides:", globalIndex);
      return;
    }
    state.swiper.removeSlide(currentIndex);

    // If no slides left, add a new one
    if (state.swiper.slides.length <= 1) {
      await addNewSlide();
    }

    updateMetadataOverlay();
  }
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
    elements.startStopBtn.addEventListener("click", toggleSlideshowWithIndicator);
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

export function toggleSlideshowWithIndicator() {
  const isRunning = state.swiper?.autoplay?.running;

  if (isRunning) {
    pauseSlideshow();
    showPlayPauseIndicator(false); // Show pause indicator
  } else {
    resumeSlideshow();
    showPlayPauseIndicator(true); // Show play indicator
  }
}

// MAIN INITIALIZATION FUNCTION
function initializeEvents() {
  cacheElements();
  initializeTitle();
  setupButtonEventListeners();
  setupGlobalEventListeners();
  setupAccessibility();
  checkAlbumIndex(); // Check if the album index exists before proceeding
}

// Initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", function() {
  initializeEvents();

  const aboutBtn = document.getElementById("aboutBtn");
  const aboutModal = document.getElementById("aboutModal");
  const closeAboutBtn = document.getElementById("closeAboutBtn");

  if (aboutBtn && aboutModal) {
    aboutBtn.addEventListener("click", () => {
      aboutModal.style.display = "flex";
    });
  }
  if (closeAboutBtn && aboutModal) {
    closeAboutBtn.addEventListener("click", () => {
      aboutModal.style.display = "none";
    });
  }
  // Optional: close modal when clicking outside content
  aboutModal.addEventListener("click", (e) => {
    if (e.target === aboutModal) {
      aboutModal.style.display = "none";
    }
  });
});
