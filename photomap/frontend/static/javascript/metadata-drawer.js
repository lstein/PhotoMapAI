// overlay.js
// This file manages the overlay functionality, including showing and hiding overlays during slide transitions.
import { bookmarkManager } from "./bookmarks.js";
import { scoreDisplay } from "./score-display.js";
import { slideState } from "./slide-state.js";
import { state, setShowMetadataFields } from "./state.js";
import { setSearchResults } from "./search.js";
import { isColorLight, makeDraggable } from "./utils.js";
import {
  getClusterColorFromPoints,
  getClusterInfoForImage,
  getClusterLabelInfo,
  getImageLabelInfo,
  SHOW_CLUSTER_LABELS_IN_BADGES,
} from "./cluster-utils.js";
import { enhanceReferenceImageThumbnails, registerReferenceThumbnailClickHandler } from "./reference-thumbnails.js";

export { enhanceReferenceImageThumbnails };

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

// Update banner with current slide's metadata
export function updateMetadataOverlay(slide) {
  if (!slide) {
    return;
  }

  const rawDescription = slide.dataset.description || "";
  const referenceImages = slide.dataset.reference_images || [];
  const metadataUrl = slide.dataset.metadata_url || "#";

  const descriptionText = document.getElementById("descriptionText");
  descriptionText.innerHTML = rawDescription;
  enhanceReferenceImageThumbnails(descriptionText, referenceImages, state.album);

  // Inject filepath as first row of the metadata table
  const filepath = slide.dataset.filepath || "";
  if (filepath) {
    const table = document.querySelector("#descriptionText .invoke-metadata");
    if (table) {
      const row = document.createElement("tr");
      row.innerHTML = `<th>Path</th><td style="word-break:break-all">${filepath}</td>`;
      table.tBodies[0]
        ? table.tBodies[0].insertBefore(row, table.tBodies[0].firstChild)
        : table.insertBefore(row, table.firstChild);
    }
  }

  // Move recall/remix buttons out of the scrollable description area
  const recallContainer = document.getElementById("recallButtonsContainer");
  if (recallContainer) {
    recallContainer.innerHTML = "";
    const recallControls = document.querySelector("#descriptionText .invoke-recall-controls");
    if (recallControls) {
      recallContainer.appendChild(recallControls);
    }
  }

  document.getElementById("filenameText").textContent = slide.dataset.filename || "";

  // Two metadata-link slots: the master sits in #metadataLinkContainer below
  // the scrollable description and never moves; a clone is inserted into the
  // bottom of the details table. The clone shares the .metadata-link class so
  // the document-level delegated click handler activates it. Cloning instead
  // of moving the master means an innerHTML wipe of descriptionText (by this
  // function or by grid-view's equivalent) can never destroy the only
  // metadata link in the page.
  const masterLink = document.getElementById("metadataLink");
  if (masterLink) {
    masterLink.href = metadataUrl;
  }
  const detailsTable =
    document.querySelector("#descriptionText .invoke-metadata") ||
    document.querySelector("#descriptionText .exif-metadata table");
  const linkContainer = document.getElementById("metadataLinkContainer");
  if (detailsTable) {
    const cloneLink = document.createElement("a");
    cloneLink.className = "metadata-link";
    cloneLink.href = metadataUrl;
    cloneLink.target = "_blank";
    cloneLink.rel = "noopener noreferrer";
    cloneLink.textContent = "View Metadata (JSON)";
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.className = "details-link-cell";
    cell.appendChild(cloneLink);
    row.appendChild(cell);
    (detailsTable.tBodies[0] || detailsTable).appendChild(row);
    if (linkContainer) {
      linkContainer.style.display = "none";
    }
  } else if (linkContainer) {
    linkContainer.style.display = "";
  }

  // Update cluster information display
  updateClusterInfo(slide.dataset);
  updateImageLabel(slide.dataset);
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

    // Build badge contents. When the vocabulary endpoint has supplied a phrase
    // for this cluster, splice it in as an italicized tag value. Gated by
    // SHOW_CLUSTER_LABELS_IN_BADGES so the whole addition can be backed out
    // with one flag flip.
    let titleAttr = null;
    let labelInfo = null;
    if (SHOW_CLUSTER_LABELS_IN_BADGES && cluster !== -1) {
      labelInfo = getClusterLabelInfo(cluster);
      if (labelInfo?.alternates?.length) {
        titleAttr = `also: ${labelInfo.alternates.join(", ")}`;
      }
    }

    clusterInfoBadge.replaceChildren();
    if (cluster === -1) {
      clusterInfoBadge.appendChild(document.createTextNode(`Unclustered (size=${size})`));
    } else if (labelInfo) {
      clusterInfoBadge.appendChild(document.createTextNode(`Cluster ${cluster} · `));
      const valSpan = document.createElement("span");
      valSpan.className = "tag-value";
      valSpan.textContent = labelInfo.label;
      clusterInfoBadge.appendChild(valSpan);
      clusterInfoBadge.appendChild(document.createTextNode(` (size=${size})`));
    } else {
      clusterInfoBadge.appendChild(document.createTextNode(`Cluster ${cluster} (size=${size})`));
    }

    // Set badge colors
    clusterInfoBadge.style.backgroundColor = color;
    clusterInfoBadge.style.color = isColorLight(color) ? "#222" : "#fff";
    if (titleAttr) {
      clusterInfoBadge.title = titleAttr;
    } else {
      clusterInfoBadge.removeAttribute("title");
    }

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

// Lazily fetch and display the per-image vocabulary label. Independent of the
// cluster label so a heterogeneous cluster's aggregate label doesn't have to
// match the individual image. Gated by the same SHOW_CLUSTER_LABELS_IN_BADGES
// flag as the cluster badge for one-flag rollback consistency.
let _imageLabelFetchToken = 0;
export async function updateImageLabel(metadata) {
  const container = document.getElementById("imageLabelContainer");
  const textSpan = document.getElementById("imageLabelText");
  if (!container || !textSpan) {
    return;
  }
  if (!SHOW_CLUSTER_LABELS_IN_BADGES || !state.album) {
    container.style.display = "none";
    return;
  }
  const index = parseInt(metadata.globalIndex, 10);
  if (!Number.isFinite(index)) {
    container.style.display = "none";
    return;
  }

  // Token guards against stale responses: if the user navigates to a new
  // image before this fetch resolves, the response from the older request
  // gets ignored rather than overwriting the new image's label.
  _imageLabelFetchToken += 1;
  const myToken = _imageLabelFetchToken;
  const info = await getImageLabelInfo(state.album, index);
  if (myToken !== _imageLabelFetchToken) {
    return;
  }

  if (!info) {
    container.style.display = "none";
    return;
  }
  textSpan.replaceChildren();
  const tags = [info.label, ...(info.alternates || [])].slice(0, 3);
  tags.forEach((tag, idx) => {
    if (idx > 0) {
      textSpan.appendChild(document.createTextNode(", "));
    }
    const span = document.createElement("span");
    span.className = "tag-value";
    span.textContent = tag;
    textSpan.appendChild(span);
  });
  container.style.display = "block";
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

// Delegated click on any .metadata-link (the master in #metadataLinkContainer
// and any per-table clone) — using delegation rather than binding to a single
// element lets updateMetadataOverlay clone the link into the details table
// without losing the handler if the table is later wiped by innerHTML.
document.addEventListener("click", async (e) => {
  const link = e.target.closest(".metadata-link");
  if (!link) {
    return;
  }
  e.preventDefault();
  if (!metadataModal || !metadataTextArea) {
    return;
  }
  metadataModal.classList.add("visible");

  try {
    const resp = await fetch(link.href);
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

// Helper to set/reset drawer position. ``setDrawerPosition`` is passed to
// ``makeDraggable`` below as a custom writer so it can also clear the CSS
// ``transform`` that originally centered the drawer.
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

// Wire up the drawer's titlebar to the shared `makeDraggable` helper.
const drawer = document.getElementById("bannerDrawerContainer");
if (drawer) {
  makeDraggable(drawer, drawer, {
    // The drawer is its own handle — restrict to the titlebar region and
    // exclude the copy button so its click still works.
    shouldDrag: (e) => {
      const isTitlebar =
        e.target.id === "filenameTitlebar" ||
        e.target.classList.contains("filename-titlebar") ||
        e.target.id === "filenameText";
      const isCopyButton = e.target.id === "copyTextBtn" || e.target.closest("#copyTextBtn");
      return isTitlebar && !isCopyButton;
    },
    setPosition: setDrawerPosition,
    onDragStart: () => {
      drawer.classList.add("dragging");
      document.body.style.userSelect = "none";
    },
    onDragEnd: () => {
      drawer.classList.remove("dragging");
      document.body.style.userSelect = "";
    },
  });
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
  registerReferenceThumbnailClickHandler();

  // Metadata-fields accordion: mirrors the open/closed pattern used by the
  // Settings dialog accordions, with the open state persisted in
  // state.showMetadataFields (and therefore in localStorage).
  const header = document.getElementById("metadataFieldsHeader");
  const body = document.getElementById("metadataFieldsBody");
  if (header && body) {
    const setOpen = (open) => {
      header.setAttribute("aria-expanded", String(open));
      body.classList.toggle("open", open);
    };
    setOpen(state.showMetadataFields);
    header.addEventListener("click", () => {
      const open = header.getAttribute("aria-expanded") !== "true";
      setOpen(open);
      setShowMetadataFields(open);
    });
  }

  // Listen for UMAP data loaded event to refresh cluster info for the current slide
  window.addEventListener("umapDataLoaded", () => {
    const currentSlide = slideState.getCurrentSlide();
    if (currentSlide && currentSlide.globalIndex !== undefined) {
      // Get the slide data/metadata for the current slide
      // In swiper view, we need to get the actual slide element
      const swiperSlide = document.querySelector(`[data-global-index="${currentSlide.globalIndex}"]`);
      if (swiperSlide && swiperSlide.dataset) {
        updateClusterInfo(swiperSlide.dataset);
        updateImageLabel(swiperSlide.dataset);
        updateCurrentImageScore(swiperSlide.dataset);
      } else {
        // In grid view or if slide element not found, construct minimal metadata
        const metadata = { globalIndex: currentSlide.globalIndex };
        updateClusterInfo(metadata);
        updateImageLabel(metadata);
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
