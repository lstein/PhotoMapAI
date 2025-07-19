// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
// TO DO: Change the name of the element from 'pauseOverlay' to 'overlay' to make it more generic.
import { state } from "./state.js";

// Show the banner by moving container up
export function showPauseOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  container.classList.add("visible");
}

// Hide the banner by moving container down
export function hidePauseOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  container.classList.remove("visible");
}

// Toggle the banner container
export function togglePauseOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  const isVisible = container.classList.contains("visible");

  if (isVisible) {
    hidePauseOverlay();
  } else {
    showPauseOverlay();
  }
}

// Update banner with current slide's metadata
export function updateOverlay() {
  const slide = state.swiper.slides[state.swiper.activeIndex];
  if (!slide) return;
  document.getElementById("descriptionText").innerHTML =
    slide.dataset.description || "";
  document.getElementById("filenameText").textContent =
    slide.dataset.filename || "";
  document.getElementById("filepathText").textContent =
    slide.dataset.filepath || "";
  state.currentTextToCopy = slide.dataset.textToCopy || "";
}
