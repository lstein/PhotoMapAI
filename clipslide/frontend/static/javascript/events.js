// events.js
// This file manages event listeners for the application, including slide transitions and slideshow controls.
import { state } from "./state.js";
import {
  pauseSlideshow,
  resumeSlideshow,
  addNewSlide,
  updateSlideshowIcon,
} from "./swiper.js";
import { showPauseOverlay, hidePauseOverlay, updateOverlay } from "./overlay.js";
import { showSpinner, hideSpinner } from "./utils.js";
import { getCurrentFilepath, deleteImage } from "./api.js";
import {} from "./touch.js"; // Import touch event handlers

// initialize event listeners after the DOM is fully loaded
document.addEventListener("DOMContentLoaded", async function () {

  // Initialize the slideshow title
  document.getElementById("slideshow_title").textContent = "Slideshow - " + state.album;

  // Fullscreen button
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const elem = document.documentElement;
      if (!document.fullscreenElement) {
        elem.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Copy text button - ADD THE MISSING EVENT LISTENER
  const copyTextBtn = document.getElementById("copyTextBtn");
  if (copyTextBtn) {
    copyTextBtn.addEventListener("click", function () {
      if (state.currentTextToCopy) {
        navigator.clipboard.writeText(state.currentTextToCopy);
      }
    });
  }

  // Start/stop slideshow button
  const startStopBtn = document.getElementById("startStopSlideshowBtn");
  if (startStopBtn) {
    startStopBtn.addEventListener("click", function () {
      if (state.swiper?.autoplay?.running) {
        state.swiper.autoplay.stop();
      } else if (state.swiper?.autoplay) {
        state.swiper.autoplay.start();
      }
      updateSlideshowIcon();
    });
  }

  // The X in the right corner of the pause overlay
  const closeOverlayBtn = document.getElementById("closeOverlayBtn");
  if (closeOverlayBtn) {
    document.getElementById("closeOverlayBtn").onclick = hidePauseOverlay;
  }
});

// Keyboard navigation
window.addEventListener("keydown", function (e) {
  // Prevent global shortcuts when typing in an input or textarea
  if (
    e.target.tagName === "INPUT" ||
    e.target.tagName === "TEXTAREA" ||
    e.target.isContentEditable
  ) {
    return;
  }

  if (e.key === "ArrowRight") {
    pauseSlideshow(); // Pause on navigation
    state.swiper.slideNext();
  }
  if (e.key === "ArrowLeft") {
    pauseSlideshow(); // Pause on navigation
    state.swiper.slidePrev();
  }
  if (e.key === "ArrowUp") showPauseOverlay();
  if (e.key === "ArrowDown") hidePauseOverlay();
  if (e.key === "i") {
    const pauseOverlay = document.getElementById("pauseOverlay");
    if (pauseOverlay.classList.contains("visible")) {
      hidePauseOverlay();
    } else {
      showPauseOverlay();
    }
  }
  if (e.key === "Escape") hidePauseOverlay();
  if (e.key === "f") {
    const elem = document.documentElement; // or use a specific container div
    if (!document.fullscreenElement) {
      elem.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }
  if (e.key === " ") {
    e.preventDefault();
    e.stopPropagation();
    if (
      state.swiper &&
      state.swiper.autoplay &&
      state.swiper.autoplay.running
    ) {
      pauseSlideshow();
    } else {
      resumeSlideshow();
    }
  }
});

// Disable tabbing on buttons to prevent focus issues
document.querySelectorAll("button").forEach((btn) => (btn.tabIndex = -1));

document.querySelectorAll('input[type="radio"]').forEach((rb) => {
  rb.tabIndex = -1; // Remove from tab order
  rb.addEventListener("mousedown", function (e) {
    e.preventDefault(); // Prevent focus on mouse down
  });
  rb.addEventListener("focus", function () {
    this.blur(); // Remove focus if somehow focused
  });
});


// Handler for the delete (trash) button
const delete_current_file_btn = document.getElementById("deleteCurrentFileBtn");
if (delete_current_file_btn) {
  delete_current_file_btn.addEventListener("click", async function () {
    const currentFilepath = getCurrentFilepath();

    if (!currentFilepath) {
      alert("No image selected for deletion.");
      return;
    }

    // Show confirmation dialog
    const confirmDelete = confirm(
      `Are you sure you want to delete this image?\n\n${currentFilepath}\n\nThis action cannot be undone.`
    );

    if (!confirmDelete) {
      return; // User cancelled, do nothing
    }

    try {
      // Show spinner during deletion
      showSpinner();

      // Call the delete function
      await deleteImage(currentFilepath);

      // Remove the current slide from swiper
      if (state.swiper && state.swiper.slides && state.swiper.slides.length > 0) {
        const currentIndex = state.swiper.activeIndex;
        state.swiper.removeSlide(currentIndex);

        // If no slides left, add a new one
        if (state.swiper.slides.length === 0) {
          await addNewSlide();
        }

        // Update overlay with new current slide
        updateOverlay();
      }

      hideSpinner();
      console.log("Image deleted successfully");
    } catch (error) {
      hideSpinner();
      alert(`Failed to delete image: ${error.message}`);
      console.error("Delete failed:", error);
    }
  });
}
