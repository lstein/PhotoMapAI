// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
// TO DO: Change the name of the element from 'pauseOverlay' to 'overlay' to make it more generic.
import { scoreDisplay } from "./score-display.js";
import { state } from "./state.js";

// Show the banner by moving container up
export function showMetadataOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  container.classList.add("visible");
}

// Hide the banner by moving container down
export function hideMetadataOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  container.classList.remove("visible");
}

// Toggle the banner container
export function toggleMetadataOverlay() {
  const container = document.getElementById("bannerDrawerContainer");
  const isVisible = container.classList.contains("visible");

  if (isVisible) {
    hideMetadataOverlay();
  } else {
    showMetadataOverlay();
  }
}

// Update banner with current slide's metadata
export function updateMetadataOverlay() {
  const slide = state.swiper.slides[state.swiper.activeIndex];
  if (!slide) return;
  document.getElementById("descriptionText").innerHTML =
    slide.dataset.description || "";
  document.getElementById("filenameText").textContent =
    slide.dataset.filename || "";
  document.getElementById("filepathText").textContent =
    slide.dataset.filepath || "";
  document.getElementById("metadataLink").href = slide.dataset.metadata_url || "#";
  state.currentTextToCopy = slide.dataset.textToCopy || "";
  updateCurrentImageScore(slide);
}

async function updateCurrentImageScore(activeSlide) {
  if (!activeSlide) {
    console.warn("No active slide found");
    return;
  }

  const globalIndex = parseInt(activeSlide.dataset.index, 10);
  const globalTotal = parseInt(activeSlide.dataset.total, 10);
  const searchIndex = parseInt(activeSlide.dataset.searchIndex, 10);

  if (state.searchResults.length === 0) {
    scoreDisplay.showIndex(globalIndex, globalTotal);
    return;
  }

  if (activeSlide?.dataset?.score) {
    const score = parseFloat(activeSlide.dataset.score);
    scoreDisplay.show(score, searchIndex + 1, state.searchResults.length);
    return;
  }

  if (activeSlide?.dataset?.cluster) {
    scoreDisplay.showCluster(
      activeSlide.dataset.cluster,
      activeSlide.dataset.color,
      searchIndex + 1,
      state.searchResults.length
    );
    return;
  }
}

// Metadata modal logic
const metadataModal = document.getElementById("metadataModal");
const metadataTextArea = document.getElementById("metadataTextArea");
const closeMetadataModalBtn = document.getElementById("closeMetadataModalBtn");
const metadataLink = document.getElementById("metadataLink");

// Show modal and fetch metadata
metadataLink.addEventListener("click", async function (e) {
  e.preventDefault();
  if (!metadataModal || !metadataTextArea) return;
  metadataModal.classList.add("visible");

  // Fetch JSON metadata from the link's href
  try {
    const resp = await fetch(metadataLink.href);
    if (resp.ok) {
      const text = await resp.text();
      metadataTextArea.value = text;
    } else {
      metadataTextArea.value = "Failed to load metadata.";
    }
  } catch (err) {
    metadataTextArea.value = "Error loading metadata.";
  }
});

// Hide modal on close button
closeMetadataModalBtn.addEventListener("click", function () {
  metadataModal.classList.remove("visible");
});

// Hide modal when clicking outside the modal content
metadataModal.addEventListener("click", function (e) {
  if (e.target === metadataModal) {
    metadataModal.classList.remove("visible");
  }
});
