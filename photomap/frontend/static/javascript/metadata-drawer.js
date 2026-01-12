// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
import { bookmarkManager } from "./bookmarks.js";
import { scoreDisplay } from "./score-display.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { setSearchResults } from "./search.js";
import { isColorLight } from "./utils.js";
import { getClusterInfoForImage, getClusterColorFromPoints } from "./cluster-utils.js";

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
export function replaceReferenceImagesWithLinks(description, referenceImages, albumKey) {
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
      const regex = new RegExp(imageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const link = `<a href="image_by_name/${encodeURIComponent(albumKey)}/${encodeURIComponent(
        imageName
      )}" target="_blank" style="color: #faea0e;">${imageName}</a>`;
      processedDescription = processedDescription.replace(regex, link);
    }
  });

  return processedDescription;
}

// Update banner with current slide's metadata
export function updateMetadataOverlay(slide) {
  if (!slide) {
    return;
  }

  // Process description with reference image links
  const rawDescription = slide.dataset.description || "";
  const referenceImages = slide.dataset.reference_images || [];
  const processedDescription = replaceReferenceImagesWithLinks(rawDescription, referenceImages, state.album);

  document.getElementById("descriptionText").innerHTML = processedDescription;
  document.getElementById("filenameText").textContent = slide.dataset.filename || "";
  document.getElementById("filepathText").textContent = slide.dataset.filepath || "";
  document.getElementById("metadataLink").href = slide.dataset.metadata_url || "#";

  // Update cluster information display
  updateClusterInfo(slide.dataset);
  updateCurrentImageScore(slide.dataset);
}

// Update cluster information in the metadata window
export function updateClusterInfo(metadata) {
  const clusterInfoContainer = document.getElementById("clusterInfoContainer");
  const clusterInfoBadge = document.getElementById("clusterInfoBadge");

  if (!clusterInfoContainer || !clusterInfoBadge) {
    return;
  }

  // Get cluster info using shared utility
  const clusterInfo = getClusterInfoForImage(parseInt(metadata.globalIndex, 10), window.umapPoints);

  // Check if we have cluster information
  if (clusterInfo && clusterInfo.cluster !== null && clusterInfo.cluster !== undefined) {
    const { cluster, color, size } = clusterInfo;

    // Create label
    const clusterLabel = cluster === -1 ? `Unclustered (size=${size})` : `Cluster ${cluster} (size=${size})`;

    // Set badge text and colors
    clusterInfoBadge.textContent = clusterLabel;
    clusterInfoBadge.style.backgroundColor = color;
    clusterInfoBadge.style.color = isColorLight(color) ? "#222" : "#fff";

    // Store current cluster value in data attribute for the click handler
    clusterInfoBadge.dataset.currentCluster = cluster;

    // Show container
    clusterInfoContainer.style.display = "block";

    // Set up click handler to select cluster (if not already set)
    if (!clusterInfoBadge.hasAttribute("data-click-handler")) {
      clusterInfoBadge.setAttribute("data-click-handler", "true");
      clusterInfoBadge.addEventListener("click", () => {
        // Get the current cluster from the data attribute
        const currentCluster = parseInt(clusterInfoBadge.dataset.currentCluster, 10);

        // Find all points in this cluster from UMAP data
        if (window.umapPoints) {
          const clusterPoints = window.umapPoints.filter((p) => p.cluster === currentCluster);

          if (clusterPoints.length > 0) {
            // Get the cluster color using shared utility
            const clusterColor = getClusterColorFromPoints(currentCluster, window.umapPoints);

            // Create search results
            const clusterMembers = clusterPoints.map((point) => ({
              index: point.index,
              cluster: currentCluster,
              color: clusterColor,
            }));

            // Set search results
            setSearchResults(clusterMembers, "cluster");
          }
        }
      });
    }
  } else {
    // Hide cluster info if no cluster
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

  // Get current cluster info from UMAP points, not from stale metadata
  const clusterInfo = getClusterInfoForImage(globalIndex, window.umapPoints);
  if (clusterInfo && clusterInfo.cluster !== null && clusterInfo.cluster !== undefined) {
    // Show "unclustered" text for cluster -1
    const clusterDisplay = clusterInfo.cluster === -1 ? "unclustered" : clusterInfo.cluster;
    scoreDisplay.showCluster(clusterDisplay, clusterInfo.color, searchIndex, state.searchResults.length);
    return;
  }
}

// Metadata modal logic
const metadataModal = document.getElementById("metadataModal");
const metadataTextArea = document.getElementById("metadataTextArea");
const closeMetadataModalBtn = document.getElementById("closeMetadataModalBtn");
const metadataLink = document.getElementById("metadataLink");

// Show modal and fetch metadata
metadataLink.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!metadataModal || !metadataTextArea) {
    return;
  }
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
  } catch {
    metadataTextArea.value = "Error loading metadata.";
  }
});

// Hide modal on close button
closeMetadataModalBtn.addEventListener("click", () => {
  metadataModal.classList.remove("visible");
});

// Hide modal when clicking outside the modal content
metadataModal.addEventListener("click", (e) => {
  if (e.target === metadataModal) {
    metadataModal.classList.remove("visible");
  }
});

document.addEventListener("click", (e) => {
  // Check if the click is on the copy icon or its SVG child
  const icon = e.target.closest(".copy-icon");
  if (icon) {
    // Find the parent td.copyme
    const td = icon.closest("td.copyme");
    if (td) {
      // Clone the td, remove the icon, and get the text
      const clone = td.cloneNode(true);
      const iconClone = clone.querySelector(".copy-icon");
      if (iconClone) {
        iconClone.remove();
      }
      const text = clone.textContent.trim();
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
  copyMetadataBtn.addEventListener("click", () => {
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
let startX, startY, initialLeft, initialTop;

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

// Helper function to get coordinates from event (mouse or touch)
const getEventCoords = (e) => {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
};

// Mouse/touch drag handlers
function onDrawerMouseDown(e) {
  // Only drag if clicking on the titlebar, but not on the copy button
  const isTitlebar =
    e.target.id === "filenameTitlebar" ||
    e.target.classList.contains("filename-titlebar") ||
    e.target.id === "filenameText";
  const isCopyButton = e.target.id === "copyTextBtn" || e.target.closest("#copyTextBtn");

  if (isTitlebar && !isCopyButton) {
    isDraggingDrawer = true;
    const coords = getEventCoords(e);
    startX = coords.x;
    startY = coords.y;

    const container = document.getElementById("bannerDrawerContainer");
    const rect = container.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    document.body.style.userSelect = "none";
    e.preventDefault();
  }
}

function onDrawerMouseMove(e) {
  if (!isDraggingDrawer) {
    return;
  }

  const coords = getEventCoords(e);
  const deltaX = coords.x - startX;
  const deltaY = coords.y - startY;

  const left = initialLeft + deltaX;
  const top = initialTop + deltaY;
  setDrawerPosition(left, top);

  e.preventDefault();
}

function onDrawerMouseUp() {
  isDraggingDrawer = false;
  document.body.style.userSelect = "";
}

// Touch support
function onDrawerTouchStart(e) {
  // Only drag if clicking on the titlebar, but not on the copy button
  const isTitlebar =
    e.target.id === "filenameTitlebar" ||
    e.target.classList.contains("filename-titlebar") ||
    e.target.id === "filenameText";
  const isCopyButton = e.target.id === "copyTextBtn" || e.target.closest("#copyTextBtn");

  if (isTitlebar && !isCopyButton) {
    isDraggingDrawer = true;
    const coords = getEventCoords(e);
    startX = coords.x;
    startY = coords.y;

    const container = document.getElementById("bannerDrawerContainer");
    const rect = container.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    document.body.style.userSelect = "none";
    e.preventDefault();
  }
}

function onDrawerTouchMove(e) {
  if (!isDraggingDrawer) {
    return;
  }

  const coords = getEventCoords(e);
  const deltaX = coords.x - startX;
  const deltaY = coords.y - startY;

  const left = initialLeft + deltaX;
  const top = initialTop + deltaY;
  setDrawerPosition(left, top);

  e.preventDefault();
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
    overlayDrawer.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMetadataOverlay();
    });
  }
}

// Initialize metadata drawer - sets up all event listeners
export function initializeMetadataDrawer() {
  setupOverlayButtons();

  // Listen for UMAP data loaded event to refresh cluster info for the current slide
  window.addEventListener("umapDataLoaded", () => {
    const currentSlide = slideState.getCurrentSlide();
    if (currentSlide && currentSlide.globalIndex !== undefined) {
      // Get the slide data/metadata for the current slide
      // In swiper view, we need to get the actual slide element
      const swiperSlide = document.querySelector(`[data-global-index="${currentSlide.globalIndex}"]`);
      if (swiperSlide && swiperSlide.dataset) {
        updateClusterInfo(swiperSlide.dataset);
        updateCurrentImageScore(swiperSlide.dataset);
      } else {
        // In grid view or if slide element not found, construct minimal metadata
        const metadata = { globalIndex: currentSlide.globalIndex };
        updateClusterInfo(metadata);
      }
    }
  });
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
