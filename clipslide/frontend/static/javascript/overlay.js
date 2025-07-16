// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
// TO DO: Change the name of the element from 'pauseOverlay' to 'overlay' to make it more generic.
import { state } from "./state.js";

// Show the overlay with the slide metadata
export function showPauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.style.display = "flex";
  // Force reflow to ensure the transition works when toggling quickly
  // void pauseOverlay.offsetWidth;
  pauseOverlay.classList.add("visible");
}

// Hide the overlay with the slide metadata
export function hidePauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.classList.remove("visible");
  pauseOverlay.style.display = "none";
}

// Update overlay with current slide's metadata
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
