// touch.js
// This file handles touch events for the slideshow, allowing tap and swipe gestures to control navigation and overlays.

import { showSlideshowModeMenu, toggleSlideshowWithIndicator } from "./slideshow.js";
import { state } from "./state.js";

// Touch events
let touchStartY = null;
let touchStartX = null;
let touchStartTime = null;
const swipeThreshold = 50; // Minimum distance in px for a swipe
const tapThreshold = 10; // Maximum movement in px for a tap
const tapTimeThreshold = 500; // Maximum time in ms for a tap

function handleTouchStart(e) {
  // Only track single-finger touches
  if (e.touches.length === 1) {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchStartTime = Date.now();
  }
}

function handleTouchMove(e) {
  // Ignore multi-touch events
  if (!e.touches || e.touches.length !== 1) {
    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
    return;
  }

  if (touchStartY === null || touchStartX === null) {
    return;
  }

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
  // Handle single-finger events only
  if (touchStartY === null || touchStartX === null) {
    return;
  }

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
  const isTap = Math.abs(deltaX) < tapThreshold && Math.abs(deltaY) < tapThreshold && touchDuration < tapTimeThreshold;

  // Check if text search panel is open
  const textSearchPanel = document.getElementById("textSearchPanel");
  const textSearchBtn = document.getElementById("textSearchBtn");

  if (textSearchPanel && textSearchPanel.style.display === "block") {
    // If panel is open, check if tap was outside it
    const tapTarget = e.target;
    const tapOutsidePanel =
      isTap && !textSearchPanel.contains(tapTarget) && !(textSearchBtn && textSearchBtn.contains(tapTarget));

    if (tapOutsidePanel) {
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

  // Detect fullscreen using standard and vendor-prefixed properties.
  // document.fullScreenElement is incorrect (wrong capitalization) and returns undefined,
  // which made the tap check always fail.
  const isFullscreen = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );

  if (isTap && isFullscreen) {
    toggleSlideshowWithIndicator();
  } else {
    // Only detect horizontal swipe (left/right) for pausing slideshow
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > swipeThreshold) {
      state.single_swiper.pauseSlideshow();
    }
  }

  // Reset touch tracking
  touchStartY = null;
  touchStartX = null;
  touchStartTime = null;
}

// Long-touch handler for slideshow button
const slideshowBtn = document.getElementById("startStopSlideshowBtn");
if (slideshowBtn) {
  let longTouchTimer = null;
  let touchStartPos = null;

  slideshowBtn.addEventListener("touchstart", (e) => {
    touchStartPos = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };

    longTouchTimer = setTimeout(() => {
      if (touchStartPos) {
        e.preventDefault();
        showSlideshowModeMenu(touchStartPos.x + 6, touchStartPos.y + 6);
        touchStartPos = null;
      }
    }, 500); // 500ms for long touch
  });

  slideshowBtn.addEventListener("touchmove", (e) => {
    // Cancel long touch if finger moves too much
    if (touchStartPos) {
      const dx = e.touches[0].clientX - touchStartPos.x;
      const dy = e.touches[0].clientY - touchStartPos.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longTouchTimer);
        touchStartPos = null;
      }
    }
  });

  slideshowBtn.addEventListener("touchend", () => {
    clearTimeout(longTouchTimer);
    touchStartPos = null;
  });

  slideshowBtn.addEventListener("touchcancel", () => {
    clearTimeout(longTouchTimer);
    touchStartPos = null;
  });
}

document.addEventListener("DOMContentLoaded", async () => {
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
