// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
import { bookmarkManager } from "./bookmarks.js";
import { scoreDisplay } from "./score-display.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { setSearchResults } from "./search.js";
import { isColorLight } from "./utils.js";

// Set up the bookmark toggle callback for the star icon
scoreDisplay.setToggleBookmarkCallback((globalIndex) => {
  bookmarkManager.toggleBookmark(globalIndex);
  // Update the star display after toggling
  const isBookmarked = bookmarkManager.isBookmarked(globalIndex);
  scoreDisplay.setBookmarkStatus(globalIndex, isBookmarked);
  scoreDisplay.refreshDisplay();
});

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
export function replaceReferenceImagesWithLinks(
  description,
  referenceImages,
  albumKey
) {
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
      )}/${encodeURIComponent(
        imageName
      )}" target="_blank" style="color: #faea0e;">${imageName}</a>`;
      processedDescription = processedDescription.replace(regex, link);
    }
  });

  return processedDescription;
}

// Update banner with current slide's metadata
export function updateMetadataOverlay(slide) {
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
  document.getElementById("metadataLink").href =
    slide.dataset.metadata_url || "#";
  
  // Update cluster information display
  updateClusterInfo(slide.dataset);
  updateCurrentImageScore(slide.dataset);
}

// Update cluster information in the metadata window
function updateClusterInfo(metadata) {
  const clusterInfoContainer = document.getElementById("clusterInfoContainer");
  const clusterInfoBadge = document.getElementById("clusterInfoBadge");
  
  if (!clusterInfoContainer || !clusterInfoBadge) return;
  
  // Check if we have cluster information and we're in cluster search mode
  if (metadata.cluster !== null && metadata.cluster !== undefined && state.searchType === "cluster") {
    const cluster = metadata.cluster;
    const color = metadata.color || "#cccccc";
    
    // Calculate cluster size from search results
    const clusterSize = state.searchResults.length;
    
    // Create label
    const clusterLabel = cluster === "unclustered" 
      ? `Unclustered (size=${clusterSize})` 
      : `Cluster ${cluster} (size=${clusterSize})`;
    
    // Set badge text and colors
    clusterInfoBadge.textContent = clusterLabel;
    clusterInfoBadge.style.backgroundColor = color;
    clusterInfoBadge.style.color = isColorLight(color) ? "#222" : "#fff";
    
    // Show container
    clusterInfoContainer.style.display = "block";
    
    // Set up click handler to select cluster (if not already set)
    if (!clusterInfoBadge.hasAttribute("data-click-handler")) {
      clusterInfoBadge.setAttribute("data-click-handler", "true");
      clusterInfoBadge.addEventListener("click", () => {
        // The cluster is already selected, so just ensure search results are populated
        // This click should refresh or maintain the current cluster selection
        if (state.searchResults.length > 0) {
          // Already showing this cluster, no action needed
          // Could potentially scroll to top or refocus on search results
        }
      });
    }
  } else {
    // Hide cluster info if not in cluster mode
    clusterInfoContainer.style.display = "none";
  }
}

export async function updateCurrentImageScore(metadata) {
  if (!metadata) {
    return;
  }
  const globalIndex = parseInt(metadata.globalIndex, 10);
  const globalTotal = parseInt(metadata.total, 10);
  const searchIndex = parseInt(metadata.searchIndex, 10);

  // Update bookmark status for the star display
  const isBookmarked = bookmarkManager.isBookmarked(globalIndex);
  scoreDisplay.setBookmarkStatus(globalIndex, isBookmarked);

  if (slideState.searchResults.length === 0) {
    scoreDisplay.showIndex(globalIndex, globalTotal);
    return;
  }

  // For bookmarks, show index within bookmark results (no score)
  if (state.searchType === "bookmarks") {
    scoreDisplay.showIndex(searchIndex, state.searchResults.length);
    return;
  }

  if (metadata.score) {
    const score = parseFloat(metadata.score);
    scoreDisplay.showSearchScore(score, searchIndex, state.searchResults.length);
    return;
  }

  if (metadata.cluster !== null && metadata.cluster !== undefined) {
    scoreDisplay.showCluster(
      metadata.cluster || 0,
      metadata.color,
      searchIndex,
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
        // Save the original SVG/icon HTML
        const originalIconHTML = icon.innerHTML;
        // SVG for a checkbox with a checkmark
        const checkSVG = `
          <svg width="18" height="18" viewBox="0 0 18 18">
            <rect x="2" y="2" width="14" height="14" rx="3" fill="#faea0e" stroke="#222" stroke-width="2"/>
            <polyline points="5,10 8,13 13,6" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        `;
        navigator.clipboard
          .writeText(text)
          .then(() => {
            icon.innerHTML = checkSVG;
            setTimeout(() => {
              icon.innerHTML = originalIconHTML;
            }, 1000);
          })
          .catch((e) => {
            console.error("Failed to copy text:", e);
            // Optionally show an error icon or message here
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
      navigator.clipboard
        .writeText(text)
        .then(() => {
          copyMetadataBtn.title = "Copied!";
          setTimeout(() => {
            copyMetadataBtn.title = "Copy metadata";
          }, 1000);
        })
        .catch(() => {
          copyMetadataBtn.title = "Copy failed";
        });
    }
  });
}

let isDraggingDrawer = false;
let dragOffset = { x: 0, y: 0 };
let originalPosition = { left: null, top: null };

// Helper to get/set drawer position
function setDrawerPosition(left, top) {
  const container = document.getElementById("bannerDrawerContainer");
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;
  container.style.transform = "none";
}

function resetDrawerPosition() {
  const container = document.getElementById("bannerDrawerContainer");
  container.style.left = "";
  container.style.top = "";
  container.style.transform = ""; // Restore original transform
}

// Mouse/touch drag handlers
function onDrawerMouseDown(e) {
  // Only drag if background, not handle or children
  if (
    e.target.classList.contains("banner-drawer-container") ||
    e.target.id === "filenameBanner" ||
    e.target.classList.contains("filename-banner")
  ) {
    isDraggingDrawer = true;
    const container = document.getElementById("bannerDrawerContainer");
    const rect = container.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    // Save original position for snapping back
    originalPosition.left = rect.left;
    originalPosition.top = rect.top;
    document.body.style.userSelect = "none";
  }
}

function onDrawerMouseMove(e) {
  if (!isDraggingDrawer) return;
  const left = e.clientX - dragOffset.x;
  const top = e.clientY - dragOffset.y;
  setDrawerPosition(left, top);
}

function onDrawerMouseUp() {
  isDraggingDrawer = false;
  document.body.style.userSelect = "";
}

// Touch support
function onDrawerTouchStart(e) {
  if (
    e.target.classList.contains("banner-drawer-container") ||
    e.target.id === "filenameBanner" ||
    e.target.classList.contains("filename-banner")
  ) {
    isDraggingDrawer = true;
    const container = document.getElementById("bannerDrawerContainer");
    const rect = container.getBoundingClientRect();
    const touch = e.touches[0];
    dragOffset.x = touch.clientX - rect.left;
    dragOffset.y = touch.clientY - rect.top;
    originalPosition.left = rect.left;
    originalPosition.top = rect.top;
    document.body.style.userSelect = "none";
  }
}

function onDrawerTouchMove(e) {
  if (!isDraggingDrawer) return;
  const touch = e.touches[0];
  const left = touch.clientX - dragOffset.x;
  const top = touch.clientY - dragOffset.y;
  setDrawerPosition(left, top);
}

function onDrawerTouchEnd() {
  isDraggingDrawer = false;
  document.body.style.userSelect = "";
}

// Attach event listeners
const drawer = document.getElementById("bannerDrawerContainer");
if (drawer) {
  drawer.addEventListener("mousedown", onDrawerMouseDown);
  window.addEventListener("mousemove", onDrawerMouseMove);
  window.addEventListener("mouseup", onDrawerMouseUp);

  drawer.addEventListener("touchstart", onDrawerTouchStart, { passive: false });
  window.addEventListener("touchmove", onDrawerTouchMove, { passive: false });
  window.addEventListener("touchend", onDrawerTouchEnd);
}

// 2. Snap back when handle is clicked
const handle = document.querySelector(".drawer-handle");
if (handle) {
  handle.addEventListener("click", () => {
    resetDrawerPosition();
    // Optionally, also close the drawer:
    // hideMetadataOverlay();
  });
}

// Setup overlay control buttons
function setupOverlayButtons() {
  const closeOverlayBtn = document.getElementById("closeOverlayBtn");
  const overlayDrawer = document.getElementById("overlayDrawer");

  // Close overlay button
  if (closeOverlayBtn) {
    closeOverlayBtn.onclick = hideMetadataOverlay;
  }

  // Overlay drawer button
  if (overlayDrawer) {
    overlayDrawer.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMetadataOverlay();
    });
  }
}

// Initialize metadata drawer - sets up all event listeners
export function initializeMetadataDrawer() {
  setupOverlayButtons();
}

// Position metadata drawer (called from events.js during initialization and on window resize)
export function positionMetadataDrawer() {
  const drawer = document.getElementById("bannerDrawerContainer");
  if (drawer) {
    // Position drawer below where the slider would be when visible (top: 12px + slider height ~30px + 8px gap)
    // This is independent of the slider's current visibility state
    const sliderVisibleTop = 12; // The slider's top position when visible
    const sliderHeight = 30; // Approximate slider height
    const gap = 8;
    drawer.style.top = `${sliderVisibleTop + sliderHeight + gap}px`;
  }
}
