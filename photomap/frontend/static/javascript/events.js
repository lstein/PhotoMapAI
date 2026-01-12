// events.js
// This file manages global event listeners for the application,
// including keyboard shortcuts and cross-component coordination.
import { aboutManager } from "./about.js";
import { checkAlbumIndex } from "./album-manager.js";
import { toggleCurrentBookmark } from "./bookmarks.js";
import { initializeControlPanel, toggleFullscreen } from "./control-panel.js";
import { initializeGridSwiper } from "./grid-view.js";
import {
  hideMetadataOverlay,
  initializeMetadataDrawer,
  positionMetadataDrawer,
  showMetadataOverlay,
  toggleMetadataOverlay,
} from "./metadata-drawer.js";
import { switchAlbum } from "./settings.js";
import { initializeSlideshowControls, toggleSlideshowWithIndicator, updateSlideshowButtonIcon } from "./slideshow.js";
import { saveSettingsToLocalStorage, state } from "./state.js";
import { initializeSingleSwiper } from "./swiper.js";
import {} from "./touch.js"; // Import touch event handlers
import { isUmapFullscreen, toggleUmapWindow } from "./umap.js";
import { setCheckmarkOnIcon } from "./utils.js";

// MAIN INITIALIZATION FUNCTIONS
// Initialize event listeners after the DOM is fully loaded
window.addEventListener("stateReady", async () => {
  await initializeEvents();
});

async function initializeEvents() {
  cacheElements();
  initializeTitle();
  initializeControlPanel(); // Initialize control panel buttons
  initializeMetadataDrawer(); // Initialize metadata drawer events
  initializeSlideshowControls(); // Initialize slideshow controls
  setupGlobalEventListeners();
  setupAccessibility();
  checkAlbumIndex(); // Check if the album index exists before proceeding
  positionMetadataDrawer();

  await initializeSwipers();
  await toggleGridSwiperView(state.gridViewActive);
  switchAlbum(state.album); // Initialize with the current album
}

// Cache DOM elements
let elements = {};

function cacheElements() {
  elements = {
    slideshow_title: document.getElementById("slideshow_title"),
    controlPanel: document.getElementById("controlPanel"),
    searchPanel: document.getElementById("searchPanel"),
  };
}

// Constants
const KEYBOARD_SHORTCUTS = {
  ArrowUp: () => showMetadataOverlay(),
  ArrowDown: () => hideMetadataOverlay(),
  i: () => toggleMetadataOverlay(),
  Escape: () => hideMetadataOverlay(),
  f: () => toggleFullscreen(),
  g: () => toggleGridSwiperView(),
  m: () => toggleUmapWindow(),
  b: () => toggleCurrentBookmark(),
  B: () => toggleCurrentBookmark(),
  " ": (e) => handleSpacebarToggle(e),
};

// Toggle the play/pause state using the spacebar
function handleSpacebarToggle(e) {
  e.preventDefault();
  e.stopPropagation();
  toggleSlideshowWithIndicator();
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
  return e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;
}

function setupGlobalEventListeners() {
  // Keyboard navigation
  window.addEventListener("keydown", handleKeydown);

  // Window resize event
  window.addEventListener("resize", positionMetadataDrawer);

  // About button and modal
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
  if (aboutModal) {
    aboutModal.addEventListener("click", (e) => {
      if (e.target === aboutModal) {
        aboutManager.hideModal();
      }
    });
  }
}

// After both swipers are initialized (e.g. at end of initializeSwipers or in initializeEvents)
window.addEventListener("slideshowStartRequested", async () => {
  // ensure we are in single swiper view before starting
  if (state.gridViewActive) {
    await toggleGridSwiperView(false);
  }
  await state.single_swiper.resetAllSlides(state.mode === "random");
  if (isUmapFullscreen()) {
    toggleUmapWindow(false);
  }
  try {
    state.single_swiper.resumeSlideshow();
  } catch (err) {
    console.warn("Failed to resume slideshow:", err);
  }
  // update icon in case slideshow started
  updateSlideshowButtonIcon();
});

function setupAccessibility() {
  // Disable tabbing on buttons to prevent focus issues
  document.querySelectorAll("button").forEach((btn) => (btn.tabIndex = -1));

  // Handle radio button accessibility
  document.querySelectorAll('input[type="radio"]').forEach((rb) => {
    rb.tabIndex = -1; // Remove from tab order
    rb.addEventListener("mousedown", (e) => {
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

// Listen for slide changes to update UI
window.addEventListener("slideChanged", () => {
  // nothing to do here yet, but could be used to update UI elements
});

// Toggle grid/swiper views
export async function toggleGridSwiperView(gridView = null) {
  if (state.single_swiper === null || state.grid_swiper === null) {
    console.error("Swipers not initialized yet.");
    return;
  }

  if (gridView === null) {
    state.gridViewActive = !state.gridViewActive;
  } else {
    state.gridViewActive = gridView;
  }

  saveSettingsToLocalStorage();

  const singleContainer = document.getElementById("singleSwiperContainer");
  const gridContainer = document.getElementById("gridViewContainer");
  const slideShowRunning = state.single_swiper.swiper.autoplay.running;

  // Toggle body class for CSS-based hiding of score display
  if (state.gridViewActive) {
    document.body.classList.add("grid-view-active");
  } else {
    document.body.classList.remove("grid-view-active");
  }

  if (state.gridViewActive) {
    // Fade out single view
    singleContainer.classList.add("fade-out");
    await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for fade
    singleContainer.style.display = "none";
    singleContainer.classList.remove("fade-out");

    // Fade in grid view
    gridContainer.style.display = "";
    gridContainer.style.opacity = "0";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    gridContainer.style.opacity = "1";
    await state.grid_swiper.resetOrInitialize();
    state.single_swiper.pauseSlideshow();
    updateSlideshowButtonIcon(); // Show pause indicator
  } else {
    // Fade out grid view
    gridContainer.classList.add("fade-out");
    await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for fade
    gridContainer.style.display = "none";
    gridContainer.classList.remove("fade-out");

    if (singleContainer.style.display === "none") // if previous hidden, then reset
    {
      await state.single_swiper.resetAllSlides(slideShowRunning && state.mode === "random");
    }

    // Fade in single view
    singleContainer.style.display = "";
    singleContainer.style.opacity = "0";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    singleContainer.style.opacity = "1";
  }
  // Update the grid icon with a checkmark if in grid view
  const gridViewBtn = document.getElementById("gridViewBtn");
  setCheckmarkOnIcon(gridViewBtn, state.gridViewActive);
}

// Handle clicks on the slide navigation buttons
function setupNavigationButtons() {
  const prevBtn = document.getElementById("swiperPrevButton");
  const nextBtn = document.getElementById("swiperNextButton");

  if (prevBtn) {
    prevBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const swiperMgr = state.gridViewActive ? state.grid_swiper : state.single_swiper;
      swiperMgr.swiper.slidePrev();
    };
  }

  if (nextBtn) {
    nextBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const swiperMgr = state.gridViewActive ? state.grid_swiper : state.single_swiper;
      swiperMgr.swiper.slideNext();
    };
  }
}

// Show/hide grid button
async function initializeSwipers() {
  const gridViewBtn = document.getElementById("gridViewBtn");
  state.single_swiper = await initializeSingleSwiper();
  state.grid_swiper = await initializeGridSwiper();
  setupNavigationButtons();

  if (gridViewBtn) {
    gridViewBtn.addEventListener("click", async () => {
      if (isUmapFullscreen()) {
        toggleUmapWindow(false);
      } // Close umap if open
      await toggleGridSwiperView();
    });
  }
}
