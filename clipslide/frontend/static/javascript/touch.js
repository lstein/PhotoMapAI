// touch.js
// This file handles touch events for the slideshow, allowing swipe gestures to control navigation and overlays.

import { showPauseOverlay, hidePauseOverlay } from "./overlay.js";
import { pauseSlideshow } from "./swiper.js";
import { state } from "./state.js";

// Touch events
let touchStartY = null;
let touchStartX = null;
let touchEndY = null;
let verticalSwipeDetected;
const swipeThreshold = 50; // Minimum distance in px for a swipe

function handleTouchStart(e) {
  if (e.touches && e.touches.length === 1) {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    verticalSwipeDetected = false; // Reset swipe detection
  }
}

function handleTouchMove(e) {
  if (touchStartY === null || touchStartX === null) return;
  const currentY = e.touches[0].clientY;
  const currentX = e.touches[0].clientX;
  const deltaY = currentY - touchStartY;
  const deltaX = currentX - touchStartX;

  // Only prevent default if vertical movement is dominant
  if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
    e.preventDefault();
    if (Math.abs(deltaY) > swipeThreshold && !verticalSwipeDetected) {
      e.preventDefault(); // Prevent default scrolling behavior
      verticalSwipeDetected = true;
      if (deltaY < -swipeThreshold) showPauseOverlay();
      else if (deltaY > swipeThreshold) hidePauseOverlay();
    }
  }
}

function handleTouchEnd(e) {
  if (touchStartY === null || touchStartX === null) return;
  const touch = (e.changedTouches && e.changedTouches[0]) || null;
  if (!touch) return;
  const deltaY = touch.clientY - touchStartY;
  const deltaX = touch.clientX - touchStartX;

  // Detect horizontal swipe (left/right)
  if (
    Math.abs(deltaX) > Math.abs(deltaY) &&
    Math.abs(deltaX) > swipeThreshold
  ) {
    pauseSlideshow();
  }
  // No pause on vertical swipe
  touchStartY = null;
  touchStartX = null;
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
