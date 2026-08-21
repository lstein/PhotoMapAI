// control-panel.js
// This file manages control panel button events (fullscreen, copy, delete)
import { deleteImage, getIndexMetadata } from "./index.js";
import { initializePanelAnchor, syncPanelAnchor } from "./panel-anchor.js";
import { getCurrentFilepath, getCurrentSlideIndex, slideState } from "./slide-state.js";
import { saveSettingsToLocalStorage, state } from "./state.js";
import { errorDetail, hideSpinner, showSpinner } from "./utils.js";

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

// Is the document (or anything in it) currently fullscreen?
//
// Which spelling of the Fullscreen API a browser exposes is not something this
// app gets to assume — reading only document.fullscreenElement can report "not
// fullscreen" while the app plainly is, and the panels then stay hidden with
// no way back. touch.js already checks all four; this now agrees with it
// rather than answering the same question differently.
function isDocumentFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.webkitCurrentFullScreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

// Toggle fullscreen mode.
//
// The exit chain has to cover every spelling the state check above accepts, or
// the button becomes a one-way trip: enter succeeds, isDocumentFullscreen()
// then reports true through a prefixed property, and the exit call is missing.
// Note that neither legacy vendor spells it "exit" — Firefox cancels, and so
// did older WebKit.
function toggleFullscreen() {
  const elem = document.documentElement;
  if (isDocumentFullscreen()) {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.webkitCancelFullScreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    exit?.call(document);
  } else {
    const request =
      elem.requestFullscreen || elem.webkitRequestFullscreen || elem.mozRequestFullScreen || elem.msRequestFullscreen;
    request?.call(elem);
  }
}

// Panel visibility follows the current fullscreen state and nothing else.
//
// A <video controls> element has its own fullscreen button, which makes this
// fire with the video as the fullscreen element and again with none on the
// way out. Suppressing the handler while the video player is open looks like
// the fix and is worse than the problem: if the app leaves fullscreen while
// the modal is open — which is what pressing Escape in fullscreen does, since
// browsers consume that keydown to exit rather than delivering it to the page
// — the panels keep .hidden-fullscreen (opacity:0 + visibility:hidden, both
// !important) after the modal closes, and nothing restores them until the
// user happens to toggle fullscreen twice.
//
// Letting every transition through is self-correcting instead. The video's
// own fullscreen is entered and left in pairs, so the class ends up where it
// started, and while the modal is open its backdrop sits at z-index 99999 —
// so no intermediate state is ever visible to the user anyway.
//
// Because the class is derived from the current state rather than flipped,
// calling this more often than strictly necessary is always a no-op — which is
// what lets the extra resyncs below exist.
function syncPanelVisibility() {
  const isFullscreen = isDocumentFullscreen();

  // Toggle visibility of UI panels
  [elements.controlPanel, elements.searchPanel, elements.scoreDisplay].forEach((panel) => {
    if (panel) {
      panel.classList.toggle("hidden-fullscreen", isFullscreen);
    }
  });

  // Leaving fullscreen is the transition that strands the panels below the
  // visible area on iPadOS; see panel-anchor.js. Entering is corrected too,
  // since the layout viewport changes in both directions.
  syncPanelAnchor();
}

// Neither the fullscreen state nor the viewport can be trusted to be settled
// at the moment the event fires. An exit event delivered while the document
// still names the outgoing fullscreen element reads as "still fullscreen" and
// latches the panels hidden in windowed mode, and iPadOS finishes resizing the
// viewport well after the event — the exit is animated. Both are unrecoverable
// if sampled once: visibility:hidden takes the fullscreen button out of hit
// testing, and a stranded panel is off the bottom of the screen, so in either
// case the user cannot reach the control that would undo it. Resampling over
// the following second costs nothing, because both syncs derive their result
// from the current state rather than toggling it.
function handleFullscreenChange() {
  syncPanelVisibility();
  [0, 250, 750].forEach((delay) => setTimeout(syncPanelVisibility, delay));
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
  const [globalIndex] = getCurrentSlideIndex();
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
    await deleteImage(state.album, globalIndex, state.moveToTrash);
    await handleSuccessfulDelete(globalIndex);
    hideSpinner();
  } catch (error) {
    hideSpinner();
    alert(`Failed to delete: ${errorDetail(error)}`);
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

async function handleSuccessfulDelete(globalIndex) {
  const metadata = await getIndexMetadata(state.album);
  const totalImages = metadata?.filename_count || 0;

  // Tell the rest of the app (slide state, bookmarks, back-stack, grid view)
  // which index the backend just renumbered out from under them. The
  // multi-delete path in bookmarks.js fires the same event with multiple
  // indices, so listeners only need to handle one shape. slide-state.js owns
  // repositioning — including staying inside an active search — so don't
  // touch slideState's position fields here.
  window.dispatchEvent(
    new CustomEvent("albumChanged", {
      detail: {
        album: state.album,
        totalImages,
        changeType: "deletion",
        deletedIndices: [globalIndex],
      },
    })
  );

  if (totalImages === 0) {
    state.swiper.removeAllSlides();
    return;
  }

  // Full rebuild — neighbor slides' dataset.globalIndex values are now stale after backend reindexing.
  await state.single_swiper.resetAllSlides();
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

  // Fullscreen change event. The prefixed spellings are for iPad browsers that
  // only emit those; a browser emitting both just resyncs twice, which is a
  // no-op.
  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach((eventName) => {
    document.addEventListener(eventName, handleFullscreenChange);
  });

  // Self-healing resync. If a fullscreen transition is ever missed entirely —
  // no event delivered, or every sample taken while the document still reports
  // the outgoing element — the panels would otherwise stay hidden until a
  // reload, with the button that would undo it out of hit testing. The visual
  // viewport is included deliberately: on a stranded iPadOS exit the layout
  // viewport does not change, so window.resize may never fire, while the
  // visible area shrinking always does.
  window.addEventListener("resize", syncPanelVisibility);
  window.addEventListener("orientationchange", syncPanelVisibility);
  window.visualViewport?.addEventListener("resize", syncPanelVisibility);
}

// Initialize control panel
export function initializeControlPanel() {
  cacheElements();
  setupControlPanelEventListeners();
  // Every bottom-anchored element that a stranded layout viewport carries off
  // the screen with it. The score display is not one: it hangs off the *top*
  // of the viewport, and lifting it would push it off that edge instead.
  // .curation-panel is bottom-anchored too but animates itself with a
  // transform, which this would overwrite; it belongs to a separate mode and
  // is left alone.
  initializePanelAnchor([elements.controlPanel, elements.searchPanel, document.getElementById("textSearchPanel")]);
}

// Export for keyboard shortcuts
export { toggleFullscreen };

// Export for use by bookmarks.js
export { showDeleteConfirmModal };
