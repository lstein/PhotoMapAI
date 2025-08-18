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

// Function to replace reference image filenames with clickable links
function replaceReferenceImagesWithLinks(description, referenceImages, albumKey) {
  if (!description || !referenceImages || !albumKey) {
    return description || "";
  }

  let processedDescription = description;

  // Parse reference_images if it's a JSON string
  let imageList = [];
  try {
    if (typeof referenceImages === "string") {
      imageList = JSON.parse(referenceImages);
    } else if (Array.isArray(referenceImages)) {
      imageList = referenceImages;
    }
  } catch (e) {
    console.warn("Failed to parse reference_images:", e);
    return description;
  }

  // Replace each reference image filename with a link
  imageList.forEach((imageName) => {
    if (imageName && typeof imageName === "string") {
      // Create a case-insensitive global regex to find all instances
      const regex = new RegExp(
        imageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi"
      );
      const link = `<a href="image_by_name/${encodeURIComponent(
        albumKey
      )}/${encodeURIComponent(imageName)}" target="_blank" style="color: #faea0e;">${imageName}</a>`;
      processedDescription = processedDescription.replace(regex, link);
    }
  });

  return processedDescription;
}

// Update banner with current slide's metadata
export function updateMetadataOverlay() {
  const slide = state.swiper.slides[state.swiper.activeIndex];
  if (!slide) return;

  // Process description with reference image links
  const rawDescription = slide.dataset.description || "";
  const referenceImages = slide.dataset.reference_images || [];
  const processedDescription = replaceReferenceImagesWithLinks(
    rawDescription,
    referenceImages,
    state.album
  );

  document.getElementById("descriptionText").innerHTML = processedDescription;
  document.getElementById("filenameText").textContent =
    slide.dataset.filename || "";
  document.getElementById("filepathText").textContent =
    slide.dataset.filepath || "";
  document.getElementById("metadataLink").href = slide.dataset.metadata_url || "#";
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

document.addEventListener("click", function (e) {
  // Check if the click is on the copy icon or its SVG child
  let icon = e.target.closest(".copy-icon");
  if (icon) {
    // Find the parent td.copyme
    let td = icon.closest("td.copyme");
    if (td) {
      // Clone the td, remove the icon, and get the text
      let clone = td.cloneNode(true);
      let iconClone = clone.querySelector(".copy-icon");
      if (iconClone) iconClone.remove();
      let text = clone.textContent.trim();
      if (text) {
        navigator.clipboard.writeText(text)
          .then(() => {
            icon.title = "Copied!";
            setTimeout(() => { icon.title = "Copy"; }, 1000);
          })
          .catch((e) => {
            console.error("Failed to copy text:", e);
            icon.title = "Copy failed";
          });
      }
    }
  }
});

const copyMetadataBtn = document.getElementById("copyMetadataBtn");

if (copyMetadataBtn && metadataTextArea) {
  copyMetadataBtn.addEventListener("click", function () {
    const text = metadataTextArea.value;
    if (text) {
      navigator.clipboard.writeText(text)
        .then(() => {
          copyMetadataBtn.title = "Copied!";
          setTimeout(() => { copyMetadataBtn.title = "Copy metadata"; }, 1000);
        })
        .catch(() => {
          copyMetadataBtn.title = "Copy failed";
        });
    }
  });
}
