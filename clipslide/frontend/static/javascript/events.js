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

  // Fullscreen change event listener
  document.addEventListener("fullscreenchange", function() {
    const bottomLeftBtnGroup = document.getElementById("bottomLeftBtnGroup");
    const searchPanel = document.getElementById("searchPanel");
    
    if (document.fullscreenElement) {
      // Entering fullscreen - hide panels
      bottomLeftBtnGroup?.classList.add("hidden-fullscreen");
      searchPanel?.classList.add("hidden-fullscreen");
    } else {
      // Exiting fullscreen - show panels
      bottomLeftBtnGroup?.classList.remove("hidden-fullscreen");
      searchPanel?.classList.remove("hidden-fullscreen");
    }
  });

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
    const elem = document.documentElement;
    if (!document.fullscreenElement) {
      elem.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
    // No need to manually hide/show panels here - the fullscreenchange event will handle it
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
      showFullscreenIndicator(false); // Show pause indicator
    } else {
      resumeSlideshow();
      showFullscreenIndicator(true); // Show play indicator
    }
  }
});

// Function to show fullscreen play/pause indicator
function showFullscreenIndicator(isPlaying) {
  // Only show in fullscreen mode
  if (!document.fullscreenElement) return;
  
  // Remove any existing indicator
  const existingIndicator = document.getElementById('fullscreen-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
  
  // Create the indicator element
  const indicator = document.createElement('div');
  indicator.id = 'fullscreen-indicator';
  indicator.className = 'fullscreen-playback-indicator';
  
  // Add the appropriate icon (using Unicode symbols or you can replace with SVG/Font Awesome)
  indicator.innerHTML = isPlaying ? '▶' : '⏸'; // Play or Pause symbol
  
  // Add to body
  document.body.appendChild(indicator);
  
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
    }, 300); // Wait for fade out animation
  }, 800); // Show for 800ms
}

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
searchPanel