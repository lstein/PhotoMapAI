// events.js
// This file manages event listeners for the application, including slide transitions and slideshow controls.
import { deleteImage, getCurrentFilepath } from "./api.js";
import { hidePauseOverlay, showPauseOverlay, togglePauseOverlay, updateOverlay } from "./overlay.js";
import { state } from "./state.js";
import {
  addNewSlide,
  pauseSlideshow,
  resumeSlideshow,
  updateSlideshowIcon,
} from "./swiper.js";
import { } from "./touch.js"; // Import touch event handlers
import { hideSpinner, showSpinner } from "./utils.js";

// Constants
const FULLSCREEN_INDICATOR_CONFIG = {
  showDuration: 800,    // How long to show the indicator
  fadeOutDuration: 300, // Fade out animation duration
  playSymbol: '▶',      // Play symbol
  pauseSymbol: '⏸'      // Pause symbol
};

const KEYBOARD_SHORTCUTS = {
  // ArrowRight: () => navigateSlide('next'),
  // ArrowLeft: () => navigateSlide('prev'),
  ArrowUp: () => showPauseOverlay(),
  ArrowDown: () => hidePauseOverlay(),
  i: () => togglePauseOverlay(),
  Escape: () => hidePauseOverlay(),
  f: () => toggleFullscreen(),
  ' ': (e) => handleSpacebarToggle(e)
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
    bottomLeftBtnGroup: document.getElementById("bottomLeftBtnGroup"),
    searchPanel: document.getElementById("searchPanel"),
    pauseOverlay: document.getElementById("pauseOverlay"),
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
  [elements.bottomLeftBtnGroup, elements.searchPanel].forEach(panel => {
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
  if (direction === 'next') {
    state.swiper.slideNext();
  } else {
    state.swiper.slidePrev();
  }
}

// Toggle the play/pause state using the spacebar
function handleSpacebarToggle(e) {
  e.preventDefault();
  e.stopPropagation();
  
  const isRunning = state.swiper?.autoplay?.running;
  
  if (isRunning) {
    pauseSlideshow();
    showFullscreenIndicator(false); // Show pause indicator
  } else {
    resumeSlideshow();
    showFullscreenIndicator(true); // Show play indicator
  }
}

// Copy text to clipboard
function handleCopyText() {
  if (state.currentTextToCopy) {
    navigator.clipboard.writeText(state.currentTextToCopy);
  }
}

// Delete the current file
async function handleDeleteCurrentFile() {
  const currentFilepath = getCurrentFilepath();

  if (!currentFilepath) {
    alert("No image selected for deletion.");
    return;
  }

  if (!confirmDelete(currentFilepath)) {
    return;
  }

  try {
    showSpinner();
    await deleteImage(currentFilepath);
    await handleSuccessfulDelete();
    hideSpinner();
    console.log("Image deleted successfully");
  } catch (error) {
    hideSpinner();
    alert(`Failed to delete image: ${error.message}`);
    console.error("Delete failed:", error);
  }
}

function confirmDelete(filepath) {
  return confirm(
    `Are you sure you want to delete this image?\n\n${filepath}\n\nThis action cannot be undone.`
  );
}

async function handleSuccessfulDelete() {
  if (state.swiper?.slides?.length > 0) {
    const currentIndex = state.swiper.activeIndex;
    state.swiper.removeSlide(currentIndex);

    // If no slides left, add a new one
    if (state.swiper.slides.length === 0) {
      await addNewSlide();
    }

    updateOverlay();
  }
}

// Toggle visibility of the fullscreen indicator
function showFullscreenIndicator(isPlaying) {
  // Only show in fullscreen mode
  if (!document.fullscreenElement) return;
  
  removeExistingIndicator();
  const indicator = createIndicator(isPlaying);
  showIndicatorWithAnimation(indicator);
}

function removeExistingIndicator() {
  const existingIndicator = document.getElementById('fullscreen-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
}

function createIndicator(isPlaying) {
  const indicator = document.createElement('div');
  indicator.id = 'fullscreen-indicator';
  indicator.className = 'fullscreen-playback-indicator';
  indicator.innerHTML = isPlaying 
    ? FULLSCREEN_INDICATOR_CONFIG.playSymbol 
    : FULLSCREEN_INDICATOR_CONFIG.pauseSymbol;
  
  document.body.appendChild(indicator);
  return indicator;
}

function showIndicatorWithAnimation(indicator) {
  // Trigger animation
  requestAnimationFrame(() => {
    indicator.classList.add('show');
  });
  
  // Remove after animation completes
  setTimeout(() => {
    indicator.classList.remove('show');
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
    elements.startStopBtn.addEventListener("click", toggleSlideshow);
  }

  // Close overlay button
  if (elements.closeOverlayBtn) {
    elements.closeOverlayBtn.onclick = hidePauseOverlay;
  }

  // Delete current file button
  if (elements.deleteCurrentFileBtn) {
    elements.deleteCurrentFileBtn.addEventListener("click", handleDeleteCurrentFile);
  }

  // Overlay drawer button
  if (elements.overlayDrawer) {
    elements.overlayDrawer.addEventListener("click", function (e) {
      e.stopPropagation();
      togglePauseOverlay();
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
}

function initializeTitle() {
  if (elements.slideshow_title && state.album) {
    elements.slideshow_title.textContent = "Slideshow - " + state.album;
  }
}

// MAIN INITIALIZATION FUNCTION
function initializeEvents() {
  cacheElements();
  initializeTitle();
  setupButtonEventListeners();
  setupGlobalEventListeners();
  setupAccessibility();
}

// Initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", initializeEvents);