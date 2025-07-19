// touch.js
// This file handles touch events for the slideshow, allowing tap and swipe gestures to control navigation and overlays.

import { togglePauseOverlay } from "./overlay.js";
import { pauseSlideshow } from "./swiper.js";
import { state } from "./state.js";

// Touch events
let touchStartY = null;
let touchStartX = null;
let touchStartTime = null;
let verticalSwipeDetected = false;
const swipeThreshold = 50; // Minimum distance in px for a swipe
const tapThreshold = 10; // Maximum movement in px for a tap
const tapTimeThreshold = 300; // Maximum time in ms for a tap

function handleTouchStart(e) {
  if (e.touches && e.touches.length === 1) {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
    verticalSwipeDetected = false; // Reset swipe detection
  }
}

function handleTouchMove(e) {
  if (touchStartY === null || touchStartX === null) return;
  const currentY = e.touches[0].clientY;
  const currentX = e.touches[0].clientX;
  const deltaY = currentY - touchStartY;
  const deltaX = currentX - touchStartX;

  // Only handle horizontal swipes now (for pausing slideshow)
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
    e.preventDefault();
  }
}

function handleTouchEnd(e) {
  if (touchStartY === null || touchStartX === null) return;
  const touch = (e.changedTouches && e.changedTouches[0]) || null;
  if (!touch) return;

  const deltaY = touch.clientY - touchStartY;
  const deltaX = touch.clientX - touchStartX;
  const touchDuration = Date.now() - touchStartTime;

  // Check if this is a tap (small movement and short duration)
  const isTap =
    Math.abs(deltaX) < tapThreshold &&
    Math.abs(deltaY) < tapThreshold &&
    touchDuration < tapTimeThreshold;

  if (isTap) {
    togglePauseOverlay(); // Toggle overlay on tap
  } else {
    // Detect horizontal swipe (left/right) for pausing slideshow
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
  verticalSwipeDetected = false;
}

document.addEventListener("DOMContentLoaded", async function () {
  // Attach touch event handlers to the swiper container
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
