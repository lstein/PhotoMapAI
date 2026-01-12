// control-panel.js
// This file manages control panel button events (fullscreen, copy, delete)
import { deleteImage, getIndexMetadata } from "./index.js";
import { getCurrentFilepath, getCurrentSlideIndex, slideState } from "./slide-state.js";
import { saveSettingsToLocalStorage, state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

// Cache DOM elements
let elements = {};

function cacheElements() {
  elements = {
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    copyTextBtn: document.getElementById("copyTextBtn"),
    deleteCurrentFileBtn: document.getElementById("deleteCurrentFileBtn"),
    controlPanel: document.getElementById("controlPanel"),
    searchPanel: document.getElementById("searchPanel"),
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
  [elements.controlPanel, elements.searchPanel, elements.scoreDisplay].forEach((panel) => {
    if (panel) {
      panel.classList.toggle("hidden-fullscreen", isFullscreen);
    }
  });
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
  const slideEl = document.querySelector(`.swiper-slide[data-global-index='${globalIndex}']`);
  if (!slideEl) {
    alert("Current slide element not found.");
    return;
  }
  const filepath = slideEl.dataset.filepath || "";
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
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
  const [globalIndex, , searchIndex] = getCurrentSlideIndex();
  const currentFilepath = await getCurrentFilepath();

  if (globalIndex === -1 || !currentFilepath) {
    alert("No image selected for deletion.");
    return;
  }

  const confirmed = await confirmDelete(currentFilepath, globalIndex);
  if (!confirmed) {
    return;
  }

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

    function cleanup() {
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
  if (state.suppressDeleteConfirm) {
    return true;
  }
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

// Setup button event listeners
function setupControlPanelEventListeners() {
  // Fullscreen button
  if (elements.fullscreenBtn) {
    elements.fullscreenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  // Copy text button
  if (elements.copyTextBtn) {
    elements.copyTextBtn.addEventListener("click", handleCopyText);
  }

  // Delete current file button
  if (elements.deleteCurrentFileBtn) {
    elements.deleteCurrentFileBtn.addEventListener("click", handleDeleteCurrentFile);
  }

  // Fullscreen change event
  document.addEventListener("fullscreenchange", handleFullscreenChange);
}

// Initialize control panel
export function initializeControlPanel() {
  cacheElements();
  setupControlPanelEventListeners();
}

// Export for keyboard shortcuts
export { toggleFullscreen };

// Export for use by bookmarks.js
export { showDeleteConfirmModal };
