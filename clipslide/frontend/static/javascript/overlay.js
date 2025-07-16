// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
import { state } from "./state.js";

export function showPauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.style.display = "flex";
  // Force reflow to ensure the transition works when toggling quickly
  // void pauseOverlay.offsetWidth;
  pauseOverlay.classList.add("visible");
}

export function hidePauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.classList.remove("visible");
  pauseOverlay.style.display = "none";
}
