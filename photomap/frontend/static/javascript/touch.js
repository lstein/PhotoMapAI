// touch.js
// This file handles touch events for the slideshow, allowing tap and swipe gestures to control navigation and overlays.

import { toggleSlideshowWithIndicator } from "./events.js";
import { toggleMetadataOverlay } from "./overlay.js";
import { pauseSlideshow } from "./swiper.js";

// Touch events
let touchStartY = null;
let touchStartX = null;
let touchStartTime = null;
let twoFingerTouchStart = null;
const swipeThreshold = 50; // Minimum distance in px for a swipe
const tapThreshold = 10; // Maximum movement in px for a tap
const tapTimeThreshold = 300; // Maximum time in ms for a tap

function handleTouchStart(e) {
  if (e.touches && e.touches.length === 1) {
    // Single finger touch
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
    twoFingerTouchStart = null;
  } else if (e.touches && e.touches.length === 2) {
    // Two finger touch - track for two-finger tap
    twoFingerTouchStart = {
      time: Date.now(),
      finger1: { x: e.touches[0].clientX, y: e.touches[0].clientY },
      finger2: { x: e.touches[1].clientX, y: e.touches[1].clientY },
    };
    // Reset single touch tracking
    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
  } else {
    // More than 2 fingers - reset everything
    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
    twoFingerTouchStart = null;
  }
}

function handleTouchMove(e) {
  // If this is a multi-touch event, reset single-touch tracking
  if (!e.touches || e.touches.length !== 1) {
    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
    return;
  }

  if (touchStartY === null || touchStartX === null) return;

  const currentY = e.touches[0].clientY;
  const currentX = e.touches[0].clientX;
  const deltaY = currentY - touchStartY;
  const deltaX = currentX - touchStartX;

  // Only handle horizontal swipes (for pausing slideshow)
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
    e.preventDefault();
  }
}

function handleTouchEnd(e) {
  // Handle two-finger tap
  if (twoFingerTouchStart && e.changedTouches && e.changedTouches.length >= 1) {
    const touchDuration = Date.now() - twoFingerTouchStart.time;

    // Check if this was a quick two-finger tap (not a long press or drag)
    if (touchDuration < tapTimeThreshold) {
      // Check if fingers didn't move much
      let fingersMoved = false;
      for (let i = 0; i < Math.min(e.changedTouches.length, 2); i++) {
        const touch = e.changedTouches[i];
        const startFinger =
          i === 0
            ? twoFingerTouchStart.finger1
            : twoFingerTouchStart.finger2;
        const deltaX = Math.abs(touch.clientX - startFinger.x);
        const deltaY = Math.abs(touch.clientY - startFinger.y);

        if (deltaX > tapThreshold || deltaY > tapThreshold) {
          fingersMoved = true;
          break;
        }
      }

      if (!fingersMoved) {
        e.preventDefault();
        toggleMetadataOverlay();
        twoFingerTouchStart = null;
        return;
      }
    }

    twoFingerTouchStart = null;
    return;
  }

  // Handle single-finger events
  if (touchStartY === null || touchStartX === null) return;

  // Ignore if this was a multi-touch event
  if (!e.changedTouches || e.changedTouches.length !== 1) {
    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
    return;
  }

  const touch = e.changedTouches[0];
  const deltaY = touch.clientY - touchStartY;
  const deltaX = touch.clientX - touchStartX;
  const touchDuration = Date.now() - touchStartTime;

  // Check if this is a tap (small movement and short duration)
  const isTap =
    Math.abs(deltaX) < tapThreshold &&
    Math.abs(deltaY) < tapThreshold &&
    touchDuration < tapTimeThreshold;

  // Check if text search panel is open
  const textSearchPanel = document.getElementById("textSearchPanel");
  const textSearchBtn = document.getElementById("textSearchBtn");

  if (textSearchPanel && textSearchPanel.style.display === "block") {
    // If panel is open, check if tap was outside it
    if (
      isTap &&
      !textSearchPanel.contains(e.target) &&
      !textSearchBtn.contains(e.target)
    ) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      textSearchPanel.style.opacity = 0;
      setTimeout(() => {
        textSearchPanel.style.display = "none";
      }, 200);

      touchStartY = null;
      touchStartX = null;
      touchStartTime = null;
      return;
    }

    // If tap was inside the panel, don't trigger any other actions
    if (textSearchPanel.contains(e.target)) {
      touchStartY = null;
      touchStartX = null;
      touchStartTime = null;
      return;
    }
  }

  if (isTap) {
    const container = document.getElementById("bannerDrawerContainer");
    if (container.classList.contains("visible")) {
      toggleMetadataOverlay();
    } else {
      toggleSlideshowWithIndicator();
    }
  } else {
    // Only detect horizontal swipe (left/right) for pausing slideshow
    // Removed vertical swipe detection since we now use two-finger tap for overlay
    if (
      Math.abs(deltaX) > Math.abs(deltaY) &&
      Math.abs(deltaX) > swipeThreshold
    ) {
      pauseSlideshow();
    }
  }

  // Reset touch tracking
  touchStartY = null;
  touchStartX = null;
  touchStartTime = null;
}

document.addEventListener("DOMContentLoaded", async function () {
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.addEventListener("touchstart", handleTouchStart, {
    passive: false,
  });
  swiperContainer.addEventListener("touchmove", handleTouchMove, {
    passive: false,
  });
  swiperContainer.addEventListener("touchend", handleTouchEnd, {
    passive: false,
  });
});
