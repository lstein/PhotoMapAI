// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-manager.js";
import { exitSearchMode } from "./search-ui.js";
import { getImagePath, setSearchResults } from "./search.js";
import { getCurrentSlideIndex, slideState } from "./slide-state.js";
import {
  setUmapExitFullscreenOnSelection,
  setUmapShowHoverThumbnails,
  setUmapShowLandmarks,
  setUmapClickSelectsCluster,
  state,
} from "./state.js";
import { debounce, getPercentile, isColorLight } from "./utils.js";
import { CLUSTER_PALETTE } from "./cluster-utils.js";

const UMAP_SIZES = {
  big: { width: 800, height: 590 },
  medium: { width: 440, height: 310 },
  small: { width: 360, height: 210 },
  fullscreen: { width: window.innerWidth, height: window.innerHeight },
};
const landmarkCount = 18; // Maximum number of non-overlapping landmarks to show at any time
const randomWalkMaxSize = 2000; // Max cluster size to use random walk ordering
const MARKER_UPDATE_IGNORE_WINDOW_MS = 1000; // Time window to ignore marker updates after manual navigation

let externalClickCallback = null;
let updateMarkerTimer = null;
let ignoreUpdatesUntil = 0;
let isCurationModeActive = false; // Track if curation panel is open

export function setUmapClickCallback(callback) {
  externalClickCallback = callback;
}
// --------------------------------------------

let points = [];
let clusters = [];
let colors = [];
let mapExists = false;
let isShaded = false;
let umapWindowHasBeenShown = false; // Track if window has been shown at least once
let isFullscreen = true;
let lastUnshadedSize = "medium"; // Track last non-fullscreen size
const lastUnshadedPosition = { left: null, top: null }; // Track last position
let landmarksVisible = false;
let hoverThumbnailsEnabled = true; // default ON

// Helper to get current window size
function getCurrentWindowSize() {
  const win = document.getElementById("umapFloatingWindow");
  const width = parseInt(win.style.width, 10);
  if (isFullscreen) {
    return "fullscreen";
  }
  if (width >= UMAP_SIZES.big.width) {
    return "big";
  }
  if (width >= UMAP_SIZES.medium.width) {
    return "medium";
  }
  return "small";
}

// Helper to save current position
function saveCurrentPosition() {
  const win = document.getElementById("umapFloatingWindow");
  lastUnshadedPosition.left = win.style.left;
  lastUnshadedPosition.top = win.style.top;
}

// --- Utility ---
function getClusterColor(cluster) {
  if (cluster === -1) {
    return "#cccccc";
  }
  const idx = clusters.indexOf(cluster);
  return colors[idx % colors.length];
}

// --- Spinner UI ---
function showUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "block";
}
function hideUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "none";
}

// --- EPS Spinner Debounce ---
let epsUpdateTimer = null;
document.getElementById("umapEpsSpinner").oninput = async () => {
  const eps = parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
  if (epsUpdateTimer) {
    clearTimeout(epsUpdateTimer);
  }
  epsUpdateTimer = setTimeout(async () => {
    await fetch("set_umap_eps/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album: state.album, eps }),
    });
    state.dataChanged = true;
    await fetchUmapData();
  }, 1000);
};

// --- Caching Current Album ---
let cachedAlbum = null;
let cachedAlbumName = null;

async function getCachedAlbum() {
  const currentAlbumName = state.album;
  if (cachedAlbum && cachedAlbumName === currentAlbumName) {
    return cachedAlbum;
  }
  cachedAlbum = await albumManager.getCurrentAlbum();
  cachedAlbumName = currentAlbumName;
  return cachedAlbum;
}

// --- Main UMAP Data Fetch and Plot ---
export async function fetchUmapData() {
  if (mapExists && !state.dataChanged) {
    return;
  }
  if (!state.album) {
    return;
  }
  showUmapSpinner();
  try {
    const eps = parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(`umap_data/${encodeURIComponent(state.album)}?cluster_eps=${eps}`);
    points = await response.json();

    // Compute clusters and colors
    clusters = [...new Set(points.map((p) => p.cluster))];
    colors = clusters.map((c, i) => CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]);

    // Compute axis ranges (1st to 99th percentile)
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = getPercentile(xs, 1);
    const xMax = getPercentile(xs, 99);
    const yMin = getPercentile(ys, 1);
    const yMax = getPercentile(ys, 99);

    // Prepare marker arrays
    const markerColors = points.map((p) => getClusterColor(p.cluster));
    const markerAlphas = points.map((p) => (p.cluster === -1 ? 0.08 : 0.75));

    // Main trace: all points
    const allPointsTrace = {
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: markerColors,
        opacity: markerAlphas,
        size: 5,
      },
      customdata: points.map((p) => p.index),
      name: "All Points",
      hoverinfo: "none",
    };

    // Current image marker trace
    const [globalIndex] = getCurrentSlideIndex();
    const currentPoint = points.find((p) => p.index === globalIndex);
    const currentImageTrace = currentPoint
      ? {
          x: [currentPoint.x],
          y: [currentPoint.y],
          text: ["Current slide: " + (await getImagePath(state.album, currentPoint.index)).split("/").pop()],
          mode: "markers",
          type: "scattergl",
          marker: {
            color: "#FFD700",
            size: 18,
            symbol: "circle-dot",
            line: { color: "#000", width: 2 },
          },
          name: "Current Image",
          hoverinfo: "text",
        }
      : {
          x: [],
          y: [],
          text: [],
          mode: "markers",
          type: "scattergl",
          marker: {
            color: "#FFD700",
            size: 18,
            symbol: "circle-dot",
            line: { color: "#000", width: 2 },
          },
          name: "Current Image",
          hoverinfo: "none",
        };

    const layout = {
      showlegend: false,
      dragmode: "pan",
      height: UMAP_SIZES.medium.height,
      width: UMAP_SIZES.medium.width,
      plot_bgcolor: "rgba(0,0,0,0)", // transparent plot area
      paper_bgcolor: "rgba(0,0,0,0)", // transparent paper
      font: { color: "#eee" },
      xaxis: {
        gridcolor: "rgba(255,255,255,0.15)",
        zerolinecolor: "rgba(255,255,255,0.25)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [xMin, xMax],
        scaleanchor: "y",
      },
      yaxis: {
        gridcolor: "rgba(255,255,255,0.15)",
        zerolinecolor: "rgba(255,255,255,0.25)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [yMin, yMax],
      },
      margin: {
        t: 30,
        r: 0,
        b: 30,
        l: 30,
        pad: 0,
      },
    };

    const config = {
      modeBarButtons: [["zoom2d", "pan2d", "zoomIn2d", "zoomOut2d", "autoScale2d", "toImage"]],
      scrollZoom: true,
    };

    Plotly.newPlot("umapPlot", [allPointsTrace, currentImageTrace], layout, config).then(async (gd) => {
      document.getElementById("umapContent").style.display = "block";
      setUmapWindowSize("fullscreen");
      hideUmapSpinner();

      window.dispatchEvent(new CustomEvent("umapRedrawn"));

      await setUmapColorMode();
      let hoverTimer = null;
      let isHovering = false;

      gd.on("plotly_hover", (eventData) => {
        if (!hoverThumbnailsEnabled) {
          return;
        }
        if (!eventData || !eventData.points || !eventData.points.length) {
          return;
        }
        const pt = eventData.points[0];
        // Use customdata to get the actual index, then find the point
        const ptIndex = pt.customdata;
        const point = points.find((p) => p.index === ptIndex);
        const hoverCluster = point?.cluster ?? -1;
        isHovering = true;
        hoverTimer = setTimeout(() => {
          if (isHovering) {
            const landmarkCluster = findLandmarkCluster(pt);
            let index, cluster;
            if (landmarkCluster !== null) {
              const clusterPoints = points.filter((p) => p.cluster === landmarkCluster);
              const landmarkPoint = getLandmarkForCluster(clusterPoints);
              index = landmarkPoint.index;
              cluster = landmarkCluster;
            } else {
              index = ptIndex;
              cluster = hoverCluster;
            }
            createUmapThumbnail({
              x: eventData.event.clientX,
              y: eventData.event.clientY,
              index: index,
              cluster: cluster,
            });
          }
        }, 150);
      });

      gd.on("plotly_unhover", () => {
        isHovering = false;
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        removeUmapThumbnail();
      });

      gd.on("plotly_relayout", (eventData) => {
        if (suppressRelayoutEvent) {
          return;
        } // Prevent feedback loop

        // Auto-switch back to pan after zoom
        const isZoomEvent =
          eventData["xaxis.range[0]"] !== undefined ||
          eventData["yaxis.range[0]"] !== undefined ||
          eventData["xaxis.range"] !== undefined ||
          eventData["yaxis.range"] !== undefined;

        if (isZoomEvent && gd.layout.dragmode === "zoom") {
          // Small delay to avoid interfering with the zoom operation
          setTimeout(() => {
            Plotly.relayout(gd, { dragmode: "pan" });
          }, 100);
        }

        // Only update landmarks for actual user pan/zoom events, not our programmatic changes
        const isPanZoom =
          eventData["xaxis.range[0]"] !== undefined ||
          eventData["yaxis.range[0]"] !== undefined ||
          eventData["xaxis.range"] !== undefined ||
          eventData["yaxis.range"] !== undefined;

        const isResize = eventData.width !== undefined || eventData.height !== undefined;
        const isImageUpdate = eventData.images !== undefined;

        // Only update landmarks for pan/zoom, not for our own image updates or resizes
        if (isPanZoom && !isImageUpdate && !isResize) {
          debouncedUpdateLandmarkTrace();
        }
      });

      gd.on("plotly_redraw", () => {
        if (suppressRelayoutEvent) {
          return;
        }
        debouncedUpdateLandmarkTrace();
      });

      // Initial landmark update
      if (landmarksVisible) {
        setTimeout(updateLandmarkTrace, 500);
      }

      // Show the EPS spinner container now that the plot is ready
      const epsContainer = document.getElementById("umapEpsContainer");
      if (epsContainer) {
        epsContainer.style.display = "block";
      }

      // After adding traces (e.g., landmarks), move the marker trace to the end
      const plotDiv = document.getElementById("umapPlot");
      const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
      if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
        Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
      }
    });

    // Ensure the current image marker is visible after plot initialization
    setTimeout(() => updateCurrentImageMarker(), 0);

    // Cluster click: highlight cluster as search
    document.getElementById("umapPlot").on("plotly_click", async (data) => {
      // --- MODIFIED: Intercept click for Curation Lock Mode ---
      if (externalClickCallback) {
        const pt = data.points[0];
        let index = pt.customdata;
        if (index === undefined && points[pt.pointIndex]) {
          index = points[pt.pointIndex].index;
        }
        if (index !== undefined) {
          externalClickCallback(index);
          return; // Block normal search behavior
        }
      }
      // ---------------------------------------------------

      const clickedLandmarkCluster = findLandmarkCluster(data.points[0]);

      if (clickedLandmarkCluster !== null) {
        // Get all points in this cluster
        const clusterPoints = points.filter((p) => p.cluster === clickedLandmarkCluster);
        // Use the landmark placement algorithm to get the landmark point
        const landmarkPoint = getLandmarkForCluster(clusterPoints);
        if (landmarkPoint) {
          // Check if we should select cluster or image
          if (state.umapClickSelectsCluster) {
            await handleClusterClick(landmarkPoint.index);
          } else {
            await handleImageClick(landmarkPoint.index);
          }
        }
      } else {
        const pt = data.points[0];
        const traceName = pt.data?.name;
        // Main points or highlighted points behave the same
        if (traceName === "All Points" || traceName === "HighlightedPoints") {
          // Check if we should select cluster or image
          if (state.umapClickSelectsCluster) {
            await handleClusterClick(pt.customdata);
          } else {
            await handleImageClick(pt.customdata);
          }
        }
      }
    });

    window.umapPoints = points;
    state.dataChanged = false;

    // Dispatch event to notify that UMAP data has been loaded
    window.dispatchEvent(new CustomEvent("umapDataLoaded"));

    await setUmapColorMode();
  } finally {
    hideUmapSpinner();
  }

  mapExists = true;
}

function findLandmarkCluster(point) {
  const plotDiv = document.getElementById("umapPlot");
  const landmarkTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "LandmarkClickTargets");
  if (landmarkTraceIndex === -1) {
    return null;
  }

  const landmarkTrace = plotDiv.data[landmarkTraceIndex];
  const squareSize = Array.isArray(landmarkTrace.marker.size)
    ? landmarkTrace.marker.size[0]
    : landmarkTrace.marker.size;

  const plotWidthPx = plotDiv.offsetWidth || 800;
  const plotHeightPx = plotDiv.offsetHeight || 560;
  const xRange = plotDiv.layout.xaxis.range[1] - plotDiv.layout.xaxis.range[0];
  const yRange = plotDiv.layout.yaxis.range[1] - plotDiv.layout.yaxis.range[0];
  const halfSizeX = (squareSize / 2) * (xRange / plotWidthPx);
  const halfSizeY = (squareSize / 2) * (yRange / plotHeightPx);

  const landmarkXs = landmarkTrace.x;
  const landmarkYs = landmarkTrace.y;
  const landmarkClusters = landmarkTrace.customdata || [];

  let foundLandmark = null;
  for (let i = 0; i < landmarkXs.length; i++) {
    if (Math.abs(point.x - landmarkXs[i]) <= halfSizeX && Math.abs(point.y - landmarkYs[i]) <= halfSizeY) {
      foundLandmark = landmarkClusters[i] || null;
      break;
    }
  }
  return foundLandmark;
}

const plotDiv = document.getElementById("umapPlot");
plotDiv.addEventListener("mouseleave", () => {
  removeUmapThumbnail();
});

// --- Dynamic Colorization ---
export async function colorizeUmap({ highlight = false, searchResults = [] } = {}) {
  if (!points.length) {
    return;
  }

  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  // Yield to the browser to allow spinner to render before heavy Plotly operations
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (highlight && searchResults.length > 0) {
    const searchSet = new Set(searchResults.map((r) => r.index));

    // Split points into two groups
    const regularPoints = points.filter((p) => !searchSet.has(p.index));
    const highlightedPoints = points.filter((p) => searchSet.has(p.index));

    // Update main trace with only regular points
    await Plotly.restyle(
      "umapPlot",
      {
        x: [regularPoints.map((p) => p.x)],
        y: [regularPoints.map((p) => p.y)],
        "marker.color": [regularPoints.map((p) => getClusterColor(p.cluster))],
        "marker.opacity": [regularPoints.map((p) => (p.cluster === -1 ? 0.2 : 0.75))],
        "marker.size": [regularPoints.map(() => 5)],
        "marker.line.width": [0],
        customdata: [regularPoints.map((p) => p.index)],
      },
      [0]
    );

    // Add/update highlighted trace
    const highlightTraceIdx = plotDiv.data.findIndex((t) => t.name === "HighlightedPoints");
    const highlightTrace = {
      x: highlightedPoints.map((p) => p.x),
      y: highlightedPoints.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: highlightedPoints.map((p) => getClusterColor(p.cluster)),
        opacity: 1.0,
        size: 8,
        line: { width: 1, color: "#fff" },
      },
      customdata: highlightedPoints.map((p) => p.index),
      name: "HighlightedPoints",
      hoverinfo: "none",
    };

    if (highlightTraceIdx === -1) {
      await Plotly.addTraces(plotDiv, [highlightTrace]);
    } else {
      await Plotly.restyle(
        plotDiv,
        {
          x: [highlightTrace.x],
          y: [highlightTrace.y],
          "marker.color": [highlightTrace.marker.color],
          "marker.opacity": [highlightTrace.marker.opacity],
          "marker.size": [highlightTrace.marker.size],
          customdata: [highlightTrace.customdata],
        },
        highlightTraceIdx
      );
    }

    // Ensure Current Image marker stays on top
    const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
    if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
      await Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
    }
  } else {
    // Remove highlight trace if it exists
    const highlightTraceIdx = plotDiv.data?.findIndex((t) => t.name === "HighlightedPoints");
    if (highlightTraceIdx !== -1) {
      await Plotly.deleteTraces(plotDiv, highlightTraceIdx);
    }

    // Restore ALL points to main trace with normal coloring
    const markerColors = points.map((p) => getClusterColor(p.cluster));
    const markerAlphas = points.map((p) => (p.cluster === -1 ? 0.2 : 0.75));
    const markerSizes = points.map(() => 5);

    await Plotly.restyle(
      "umapPlot",
      {
        x: [points.map((p) => p.x)],
        y: [points.map((p) => p.y)],
        "marker.color": [markerColors],
        "marker.opacity": [markerAlphas],
        "marker.size": [markerSizes],
        "marker.line.width": [0],
        customdata: [points.map((p) => p.index)],
      },
      [0]
    );

    // Ensure Current Image marker stays on top after removing highlight
    const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
    if (markerTraceIndex !== -1 && markerTraceIndex !== plotDiv.data.length - 1) {
      await Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
    }
  }
}

// --- Checkbox event handler ---
// Wait for state to be ready before initializing checkboxes
window.addEventListener("stateReady", () => {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  if (highlightCheckbox) {
    highlightCheckbox.checked = false;
    highlightCheckbox.addEventListener("change", async () => {
      await setUmapColorMode();
    });
  }

  // Clear selection link
  const clearSelectionLink = document.getElementById("umapClearSelectionLink");
  if (clearSelectionLink) {
    clearSelectionLink.addEventListener("click", (e) => {
      e.preventDefault();
      exitSearchMode();
    });
  }

  // Hover thumbnails checkbox - initialize from state
  const hoverThumbCheckbox = document.getElementById("umapShowHoverThumbnails");
  if (hoverThumbCheckbox) {
    hoverThumbCheckbox.checked = state.umapShowHoverThumbnails;
    hoverThumbnailsEnabled = state.umapShowHoverThumbnails;
    hoverThumbCheckbox.addEventListener("change", (e) => {
      hoverThumbnailsEnabled = e.target.checked;
      setUmapShowHoverThumbnails(e.target.checked);
      // Remove any popup if disabling
      if (!hoverThumbnailsEnabled) {
        removeUmapThumbnail();
      }
    });
  }

  // Landmarks checkbox - initialize from state
  const landmarkCheckbox = document.getElementById("umapShowLandmarks");
  if (landmarkCheckbox) {
    landmarkCheckbox.checked = state.umapShowLandmarks;
    landmarksVisible = state.umapShowLandmarks;
    landmarkCheckbox.addEventListener("change", (e) => {
      landmarksVisible = e.target.checked;
      setUmapShowLandmarks(e.target.checked);
      updateLandmarkTrace();
    });
  }

  // Exit fullscreen on selection checkbox - initialize from state
  const exitFullscreenCheckbox = document.getElementById("umapExitFullscreenOnSelection");
  if (exitFullscreenCheckbox) {
    exitFullscreenCheckbox.checked = state.umapExitFullscreenOnSelection;
    exitFullscreenCheckbox.addEventListener("change", (e) => {
      setUmapExitFullscreenOnSelection(e.target.checked);
    });

    // Update enabled state based on fullscreen mode
    updateExitFullscreenCheckboxState();
  }

  // Click behavior radio buttons - initialize from state
  const clickSelectsClusterRadio = document.getElementById("umapClickSelectsClusterRadio");
  const clickSelectsImageRadio = document.getElementById("umapClickSelectsImageRadio");
  if (clickSelectsClusterRadio && clickSelectsImageRadio) {
    // Set initial state
    if (state.umapClickSelectsCluster) {
      clickSelectsClusterRadio.checked = true;
    } else {
      clickSelectsImageRadio.checked = true;
    }

    // Add event listeners
    clickSelectsClusterRadio.addEventListener("change", (e) => {
      if (e.target.checked) {
        setUmapClickSelectsCluster(true);
      }
    });

    clickSelectsImageRadio.addEventListener("change", (e) => {
      if (e.target.checked) {
        setUmapClickSelectsCluster(false);
      }
    });
  }
});

// Helper function to update the "Exit fullscreen on selection" checkbox state
function updateExitFullscreenCheckboxState() {
  const exitFullscreenCheckbox = document.getElementById("umapExitFullscreenOnSelection");
  const exitFullscreenLabel = document.getElementById("umapExitFullscreenLabel");

  if (exitFullscreenCheckbox && exitFullscreenLabel) {
    const shouldEnable = isFullscreen;
    exitFullscreenCheckbox.disabled = !shouldEnable;
    exitFullscreenLabel.style.opacity = shouldEnable ? "1" : "0.5";
  }
}

// --- Update colorization after search or cluster selection ---
window.addEventListener("searchResultsChanged", async (e) => {
  updateUmapColorModeAvailability(e.detail.results);
  await setUmapColorMode();
  // Hide spinner after colorization completes
  hideUmapSpinner();
  // deactivate fullscreen mode when search results have come in (if enabled)
  if (state.searchResults.length > 0 && isFullscreen && state.umapExitFullscreenOnSelection) {
    setTimeout(() => toggleFullscreen(false), 100); // slight delay to avoid flicker
  }
});

window.addEventListener("slideChanged", async () => {
  // Clear any existing pending update
  if (updateMarkerTimer) {
    clearTimeout(updateMarkerTimer);
  }

  updateMarkerTimer = setTimeout(() => {
    // If we are currently inside the "Ignore Window" triggered by Clear, skip this update.
    if (Date.now() < ignoreUpdatesUntil) {
      return;
    }
    updateCurrentImageMarker();
  }, 500);
});

// --- Update Current Image Marker ---
export async function updateCurrentImageMarker() {
  if (!points.length) {
    return;
  }
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  // Find the trace index for the current image marker
  const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");
  if (markerTraceIndex === -1) {
    return;
  }

  const [globalIndex] = await getCurrentSlideIndex();
  if (globalIndex === -1) {
    return;
  } // No current image
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) {
    return;
  }

  // Always show the marker trace regardless of curation panel state
  Plotly.restyle(
    "umapPlot",
    {
      x: [[currentPoint.x]],
      y: [[currentPoint.y]],
      "marker.opacity": 1,
    },
    markerTraceIndex // Use the found index
  );
  ensureCurrentMarkerInView(0.1);
}

// --- Ensure Current Marker in View ---
export async function ensureCurrentMarkerInView(padFraction = 0.1) {
  if (!points.length) {
    return;
  }
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) {
    return;
  }

  const [globalIndex] = await getCurrentSlideIndex();
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) {
    return;
  }

  const x = currentPoint.x;
  const y = currentPoint.y;
  let [xMin, xMax] = plotDiv.layout.xaxis.range;
  let [yMin, yMax] = plotDiv.layout.yaxis.range;

  let changed = false;
  // Add a small padding so the marker isn't right at the edge
  const xPad = (xMax - xMin) * padFraction;
  const yPad = (yMax - yMin) * padFraction;

  if (x < xMin + xPad || x > xMax - xPad) {
    const xCenter = x;
    const halfWidth = (xMax - xMin) / 2;
    xMin = xCenter - halfWidth;
    xMax = xCenter + halfWidth;
    changed = true;
  }
  if (y < yMin + yPad || y > yMax - yPad) {
    const yCenter = y;
    const halfHeight = (yMax - yMin) / 2;
    yMin = yCenter - halfHeight;
    yMax = yCenter + halfHeight;
    changed = true;
  }

  if (changed) {
    Plotly.relayout(plotDiv, {
      "xaxis.range": [xMin, xMax],
      "yaxis.range": [yMin, yMax],
    });
  }
}

function ensureUmapWindowInView() {
  const win = document.getElementById("umapFloatingWindow");
  if (!win) {
    return;
  }
  const rect = win.getBoundingClientRect();
  const left = rect.left;
  const top = rect.top;

  // Ensure left/top are not negative
  if (left < 0) {
    win.style.left = "0px";
  }
  if (top < 0) {
    win.style.top = "0px";
  }

  // Ensure top/left are not off-screen
  const maxLeft = window.innerWidth - rect.width;
  const maxTop = window.innerHeight - rect.height;
  if (left > maxLeft) {
    win.style.left = Math.max(0, maxLeft) + "px";
  }
  if (top > maxTop) {
    win.style.top = Math.max(0, maxTop) + "px";
  }
}

async function initializeUmapWindow() {
  // Fetch the album's default EPS value and update the spinner
  if (!state.album) {
    return;
  }
  const result = await fetch("get_umap_eps/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ album: state.album }),
  });
  const data = await result.json();
  if (data.success) {
    const epsSpinner = document.getElementById("umapEpsSpinner");
    if (epsSpinner) {
      epsSpinner.value = data.eps;
    }
  }
  state.dataChanged = true;
  lastUnshadedSize = "medium"; // Reset to medium on album change
  setSemanticMapTitle();
  fetchUmapData();
  toggleFullscreen(true); // Force fullscreen on album change
}

// --- Thumbnail Preview on Hover ---
let umapThumbnailDiv = null;

async function createUmapThumbnail({ x, y, index, cluster }) {
  // Always remove any existing thumbnail before creating a new one
  removeUmapThumbnail();

  const filename = await getImagePath(state.album, index);
  if (!filename) {
    return;
  } // No valid filename, exit early

  // Find cluster color and calculate cluster size
  const clusterColor = getClusterColor(cluster);
  const clusterSize = points.filter((p) => p.cluster === cluster).length;
  const clusterLabel = cluster === -1 ? "Unclustered" : `Cluster ${cluster} (size=${clusterSize})`;
  const textIsDark = isColorLight(clusterColor) ? "#222" : "#fff";
  const textShadow = isColorLight(clusterColor) ? "0 1px 2px #fff, 0 0px 8px #fff" : "0 1px 2px #000, 0 0px 8px #000";

  // Build image URL (use thumbnail endpoint)
  const imgUrl = `thumbnails/${state.album}/${index}?size=256`;

  // Create the thumbnail div
  umapThumbnailDiv = document.createElement("div");
  umapThumbnailDiv.className = "umap-thumbnail";
  umapThumbnailDiv.style.background = clusterColor; // keep dynamic color

  // Thumbnail image
  const img = document.createElement("img");
  img.src = imgUrl;
  img.alt = filename.split("/").pop();
  umapThumbnailDiv.appendChild(img);

  // Filename
  const fnameDiv = document.createElement("div");
  fnameDiv.className = "umap-thumbnail-filename";
  fnameDiv.textContent = filename.split("/").pop();
  fnameDiv.style.color = textIsDark;
  fnameDiv.style.textShadow = textShadow;
  umapThumbnailDiv.appendChild(fnameDiv);

  // Cluster label
  const clusterDiv = document.createElement("div");
  clusterDiv.className = "umap-thumbnail-cluster";
  clusterDiv.textContent = clusterLabel;
  clusterDiv.style.color = textIsDark;
  clusterDiv.style.textShadow = textShadow;
  umapThumbnailDiv.appendChild(clusterDiv);

  document.body.appendChild(umapThumbnailDiv);

  // Position the window near the mouse pointer, but not off-screen
  const pad = 12;
  let left = x + pad;
  let top = y + pad;

  // Wait for the image to load before showing the div
  img.onload = () => {
    // Make sure the thumbnail div is still present in the DOM
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) {
      return;
    }
    let rect = null;
    try {
      rect = umapThumbnailDiv.getBoundingClientRect();
    } catch (e) {
      console.warn("Error getting thumbnail div dimensions:", e);
      return; // Exit if we can't get dimensions
    }
    if (left + rect.width > window.innerWidth - 10) {
      left = x - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - 10) {
      top = y - rect.height - pad;
    }
    umapThumbnailDiv.style.left = `${Math.max(0, left)}px`;
    umapThumbnailDiv.style.top = `${Math.max(0, top)}px`;
    umapThumbnailDiv.style.visibility = "visible"; // <-- Show after loaded
  };

  // Handle image load error
  img.onerror = () => {
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) {
      return;
    }
    umapThumbnailDiv.style.visibility = "visible";
    img.alt = "Thumbnail not available";
  };
}

function removeUmapThumbnail() {
  // Remove all elements with the umap-thumbnail class
  document.querySelectorAll(".umap-thumbnail").forEach((div) => div.remove());
  umapThumbnailDiv = null;
}

export async function setUmapColorMode() {
  await colorizeUmap({
    highlight: document.getElementById("umapHighlightSelection")?.checked,
    searchResults: state.searchResults,
  });
}

// Ensure color mode is respected after search or cluster selection
window.addEventListener("searchResultsChanged", (e) => {
  updateUmapColorModeAvailability(e.detail.results);
});

function updateUmapColorModeAvailability(searchResults = []) {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  if (searchResults.length > 0) {
    highlightCheckbox.disabled = false;
    highlightCheckbox.parentElement.style.opacity = "1";
    highlightCheckbox.checked = true; // Enable checkbox if there are search results
  } else {
    highlightCheckbox.checked = false; // Uncheck if no results
    highlightCheckbox.disabled = true;
    highlightCheckbox.parentElement.style.opacity = "0.5";
  }
  // Note: setUmapColorMode is called by the searchResultsChanged event handler
}

// ------------- Handling Landmark Thumbnails -------------

// Landmark placement algorithm
function getLandmarkForCluster(pts) {
  // 1. Find X center
  const centerX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;

  // 2. Compute X spread (standard deviation and range)
  const xs = pts.map((p) => p.x);
  const xMean = centerX;
  const xStd = Math.sqrt(xs.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0) / xs.length);
  const xRange = Math.max(...xs) - Math.min(...xs);

  // 3. Filter points near centerX (within 0.5 * std or 0.2 * range)
  const threshold = Math.max(xStd * 0.5, xRange * 0.2);
  const candidates = pts.filter((p) => Math.abs(p.x - centerX) <= threshold);

  // 4. Pick highest Y among candidates
  let best = candidates[0] || pts[0];
  for (const p of candidates) {
    if (p.y > best.y) {
      best = p;
    }
  }
  return best;
}

// Helper: get cluster centers and representatives
function getLargestClustersInView(maxLandmarks = 10) {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) {
    return [];
  }
  const [xMin, xMax] = plotDiv.layout.xaxis.range;
  const [yMin, yMax] = plotDiv.layout.yaxis.range;

  // Group points by cluster
  const clusterMap = new Map();
  points.forEach((p) => {
    if (p.cluster === -1) {
      return;
    }
    if (!clusterMap.has(p.cluster)) {
      clusterMap.set(p.cluster, []);
    }
    clusterMap.get(p.cluster).push(p);
  });

  const clustersInView = [];
  for (const [cluster, pts] of clusterMap.entries()) {
    const landmark = getLandmarkForCluster(pts);
    // Only include if landmark is in view
    if (landmark.x >= xMin && landmark.x <= xMax && landmark.y >= yMin && landmark.y <= yMax) {
      clustersInView.push({
        cluster,
        center: { x: landmark.x, y: landmark.y },
        representative: landmark.index,
        color: getClusterColor(cluster),
        size: pts.length,
      });
    }
  }

  clustersInView.sort((a, b) => b.size - a.size);
  return clustersInView.slice(0, maxLandmarks);
}

// --- Update Landmark Trace ---
let isRenderingLandmarks = false;
let lastImagesJSON = null;
let suppressRelayoutEvent = false; // Add this flag

function updateLandmarkTrace() {
  if (isRenderingLandmarks) {
    return;
  }
  isRenderingLandmarks = true;

  try {
    const plotDiv = document.getElementById("umapPlot");
    if (!plotDiv || !plotDiv.layout) {
      return;
    }

    // Remove previous landmark traces (both triangles and click targets)
    const landmarkTraceIdx = plotDiv.data?.findIndex((t) => t.name === "Landmarks");
    let clickTargetTraceIdx = plotDiv.data?.findIndex((t) => t.name === "LandmarkClickTargets");

    // Only delete if index is valid
    if (typeof landmarkTraceIdx === "number" && landmarkTraceIdx >= 0 && landmarkTraceIdx < plotDiv.data.length) {
      suppressRelayoutEvent = true;
      Plotly.deleteTraces(plotDiv, landmarkTraceIdx).then(() => {
        suppressRelayoutEvent = false;
      });
    }

    // Recompute clickTargetTraceIdx after possible deletion above
    clickTargetTraceIdx = plotDiv.data?.findIndex((t) => t.name === "LandmarkClickTargets");
    if (
      typeof clickTargetTraceIdx === "number" &&
      clickTargetTraceIdx >= 0 &&
      clickTargetTraceIdx < plotDiv.data.length
    ) {
      suppressRelayoutEvent = true;
      Plotly.deleteTraces(plotDiv, clickTargetTraceIdx).then(() => {
        suppressRelayoutEvent = false;
      });
    }

    if (!landmarksVisible) {
      if (lastImagesJSON !== null) {
        suppressRelayoutEvent = true;
        Plotly.relayout(plotDiv, { images: [] }).then(() => {
          suppressRelayoutEvent = false;
          lastImagesJSON = null;
        });
      }
      return;
    }

    // Get clusters in view
    const clusters = getLargestClustersInView(100);
    if (!clusters.length) {
      return;
    }

    // Get current axis ranges
    const [xMin, xMax] = plotDiv.layout.xaxis.range;
    const xRange = xMax - xMin;

    // Calculate thumbnail size in data units (adjust multiplier as needed)
    const imageSize = Math.max(0.2, Math.min(2.0, xRange / 10));

    // Estimate thumbnail size in pixels based on plot width and zoom
    const plotWidthPx = plotDiv.offsetWidth || 800;
    const thumbPx = Math.round((imageSize / xRange) * plotWidthPx);

    // Cap thumbnail size at 256 pixels maximum (and keep 64 minimum)
    const thumbSize = Math.max(64, Math.min(256, thumbPx));

    // Triangle marker size in pixels (constant)
    const triangleSize = 32;

    // Calculate offset in data units to move up by 24 pixels
    const plotHeightPx = plotDiv.offsetHeight || 560;
    const yRange = plotDiv.layout.yaxis.range[1] - plotDiv.layout.yaxis.range[0];
    const pixelToData = yRange / plotHeightPx;
    const verticalOffset = 24 * pixelToData;

    // Prepare trace data
    const clustersInView = getNonOverlappingLandmarks(clusters, imageSize, landmarkCount);
    const x = clustersInView.map((c) => c.center.x);
    const y = clustersInView.map((c) => c.center.y + verticalOffset);
    const markerColors = clustersInView.map((c) => c.color);

    // Triangle-down markers at bottom of thumbnails
    const landmarkTrace = {
      x,
      y,
      mode: "markers",
      type: "scatter",
      marker: {
        size: triangleSize,
        color: markerColors,
        symbol: "triangle-down",
        line: { width: 2, color: "#000" },
      },
      hoverinfo: "none",
      showlegend: false,
      name: "Landmarks",
    };

    // Invisible clickable points over thumbnails
    const clickableTrace = {
      x: clustersInView.map((c, i) => x[i]),
      y: clustersInView.map((c, i) => y[i] + imageSize / 2), // center of image
      mode: "markers",
      type: "scatter",
      marker: {
        color: "rgba(0, 0, 0, 0.0)", // invisible but clickable
        symbol: "square",
        size: thumbSize,
        line: { width: 0 },
      },
      customdata: clustersInView.map((c) => c.cluster), // <-- store cluster ID, not representative index
      hoverinfo: "none",
      showlegend: false,
      name: "LandmarkClickTargets",
    };

    // Add thumbnail images
    const images = clustersInView.map((c, i) => ({
      source: `thumbnails/${state.album}/${c.representative}?size=${thumbSize}&color=${encodeURIComponent(c.color)}`,
      x: x[i],
      y: y[i],
      xref: "x",
      yref: "y",
      sizex: imageSize,
      sizey: imageSize,
      xanchor: "center",
      yanchor: "bottom",
      layer: "above",
    }));

    // Only update if images changed, and set suppressRelayoutEvent properly
    const imagesJSON = JSON.stringify(images);
    if (imagesJSON !== lastImagesJSON) {
      suppressRelayoutEvent = true;
      Plotly.addTraces(plotDiv, [landmarkTrace, clickableTrace])
        .then(() => {
          return Plotly.relayout(plotDiv, { images });
        })
        .then(() => {
          suppressRelayoutEvent = false;
          lastImagesJSON = imagesJSON;
        });
    } else {
      suppressRelayoutEvent = true;
      Plotly.addTraces(plotDiv, [landmarkTrace, clickableTrace]).then(() => {
        suppressRelayoutEvent = false;
      });
    }
  } finally {
    isRenderingLandmarks = false;
  }

  // Move the clickableTrace to the top to ensure it captures clicks
  const plotDiv = document.getElementById("umapPlot");
  const clickableTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "LandmarkClickTargets");
  if (clickableTraceIndex !== -1 && clickableTraceIndex !== plotDiv.data.length - 1) {
    Plotly.moveTraces(plotDiv, clickableTraceIndex, plotDiv.data.length - 1);
  }
}

// Debounced version for event handlers
const debouncedUpdateLandmarkTrace = debounce(updateLandmarkTrace, 500);

// Helper function to get non-overlapping landmarks
function getNonOverlappingLandmarks(clusters, imageSize, landmarkCount = landmarkCount) {
  const placed = [];
  let i = 0;
  while (i < clusters.length && placed.length < landmarkCount) {
    const c = clusters[i];
    const { x, y } = c.center;
    // Check overlap with already placed landmarks
    let overlaps = false;
    for (const p of placed) {
      const dx = Math.abs(x - p.x);
      const dy = Math.abs(y - p.y);
      if (dx < imageSize && dy < imageSize) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      placed.push({ ...c, x, y });
    }
    i++;
  }
  return placed;
}

// --- Greedy random walk ordering for cluster points ---
function randomWalkClusterOrder(clusterIndices, points, startIndex) {
  const indexToPoint = Object.fromEntries(points.map((p) => [p.index, p]));
  const unvisited = new Set(clusterIndices);
  const walk = [startIndex];
  unvisited.delete(startIndex);
  let current = startIndex;

  while (unvisited.size > 0) {
    let nearest = null;
    let nearestDist = Infinity;
    const currentPoint = indexToPoint[current];
    for (const idx of unvisited) {
      const pt = indexToPoint[idx];
      const dist = Math.hypot(pt.x - currentPoint.x, pt.y - currentPoint.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = idx;
      }
    }
    if (nearest !== null) {
      walk.push(nearest);
      unvisited.delete(nearest);
      current = nearest;
    } else {
      break;
    }
  }
  return walk;
}

// -- Fallback ordering of cluster points by proximity to clicked point ---
function proximityClusterOrder(clusterIndices, points, startIndex) {
  const indexToPoint = Object.fromEntries(points.map((p) => [p.index, p]));
  const startPoint = indexToPoint[startIndex];
  return clusterIndices
    .map((idx) => ({
      index: idx,
      dist: Math.hypot(indexToPoint[idx].x - startPoint.x, indexToPoint[idx].y - startPoint.y),
    }))
    .sort((a, b) => a.dist - b.dist)
    .map((item) => item.index);
}

// Shared function for cluster clicks
async function handleClusterClick(clickedIndex) {
  const clickedPoint = points.find((p) => p.index === clickedIndex);
  if (!clickedPoint) {
    return;
  }

  // Show spinner immediately to provide visual feedback
  showUmapSpinner();

  // Yield to the browser to allow spinner to render before heavy computation
  await new Promise((resolve) => setTimeout(resolve, 0));

  const clickedCluster = clickedPoint.cluster;
  const clusterColor = getClusterColor(clickedCluster);
  let clusterIndices = points.filter((p) => p.cluster === clickedCluster).map((p) => p.index);

  // Remove clickedFilename from the list
  clusterIndices = clusterIndices.filter((fn) => fn !== clickedIndex);

  // --- Greedy random walk order from clicked point ---
  const sort_algorithm = clusterIndices.length > randomWalkMaxSize ? proximityClusterOrder : randomWalkClusterOrder;
  const sortedClusterIndices = sort_algorithm([clickedIndex, ...clusterIndices], points, clickedIndex);

  const clusterMembers = sortedClusterIndices.map((index) => ({
    index: index,
    cluster: clickedCluster === -1 ? "unclustered" : clickedCluster,
    color: clusterColor,
  }));

  setSearchResults(clusterMembers, "cluster");
  // Note: spinner is hidden by searchResultsChanged event handler after colorization completes
}

// Handle single image selection (navigate to clicked image)
async function handleImageClick(clickedIndex) {
  const clickedPoint = points.find((p) => p.index === clickedIndex);
  if (!clickedPoint) {
    return;
  }

  // Show spinner immediately to provide visual feedback
  showUmapSpinner();

  // Yield to the browser to allow spinner to render before heavy computation
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Clear any existing search selection
  exitSearchMode();

  // Navigate directly to the clicked image without entering search mode
  slideState.navigateToIndex(clickedIndex, false);

  // Exit fullscreen mode if enabled
  if (isFullscreen && state.umapExitFullscreenOnSelection) {
    setTimeout(() => toggleFullscreen(false), 100); // slight delay to avoid flicker
  }
  // Note: spinner is hidden by searchResultsChanged event handler after colorization completes
}

// -------------------- Window Management --------------------

// --- Show/Hide UMAP Window ---
export async function toggleUmapWindow(show = null) {
  const umapWindow = document.getElementById("umapFloatingWindow");

  if (show === null) {
    show = document.getElementById("umapFloatingWindow").style.display !== "block";
  }

  if (show === false) {
    umapWindow.style.display = "none";
  } else {
    umapWindow.style.display = "block";
    ensureUmapWindowInView();
    if (!umapWindowHasBeenShown) {
      umapWindowHasBeenShown = true;
      setUmapWindowSize("fullscreen");
    }

    if (state.album === null) {
      return;
    }

    // Fetch configured eps value from server
    const result = await fetch("get_umap_eps/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album: state.album }),
    });
    const data = await result.json();
    if (!data.success) {
      console.error("Failed to fetch UMAP EPS value:", data.message);
      return;
    }
    const epsSpinner = document.getElementById("umapEpsSpinner");
    if (epsSpinner) {
      epsSpinner.value = data.eps;
    }
    await fetchUmapData();
  }
}

document.getElementById("showUmapBtn").onclick = () => toggleUmapWindow();
document.getElementById("umapCloseBtn").onclick = () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
};

// --- Draggable Window ---
function makeDraggable(dragHandleId, windowId) {
  const dragHandle = document.getElementById(dragHandleId);
  const win = document.getElementById(windowId);
  let offsetX = 0,
    offsetY = 0,
    dragging = false;

  dragHandle.addEventListener("mousedown", startDrag);
  dragHandle.addEventListener("touchstart", startDrag, { passive: false });

  function startDrag(e) {
    // Prevent drag if touching a button in the titlebar
    if (e.target.closest(".icon-btn") || e.target.id === "umapCloseBtn") {
      return; // Don't start drag
    }
    dragging = true;
    const rect = win.getBoundingClientRect();
    if (e.type === "touchstart") {
      offsetX = e.touches[0].clientX - rect.left;
      offsetY = e.touches[0].clientY - rect.top;
      document.addEventListener("touchmove", onDrag, { passive: false });
      document.addEventListener("touchend", stopDrag);
    } else {
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      document.addEventListener("mousemove", onDrag);
      document.addEventListener("mouseup", stopDrag);
    }
    e.preventDefault();
  }

  function onDrag(e) {
    if (!dragging) {
      return;
    }
    let clientX, clientY;
    if (e.type === "touchmove") {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    win.style.left = `${clientX - offsetX}px`;
    win.style.top = `${clientY - offsetY}px`;
    win.style.right = "auto"; // Prevent CSS conflicts
    win.style.bottom = "auto";
    win.style.position = "fixed";
    e.preventDefault();
  }

  function stopDrag() {
    dragging = false;
    document.removeEventListener("mousemove", onDrag);
    document.removeEventListener("mouseup", stopDrag);
    document.removeEventListener("touchmove", onDrag);
    document.removeEventListener("touchend", stopDrag);
  }
}

function setActiveResizeIcon(sizeKey) {
  // Remove 'active' from all resize icons
  document.getElementById("umapResizeBig").classList.remove("active");
  document.getElementById("umapResizeMedium").classList.remove("active");
  document.getElementById("umapResizeSmall").classList.remove("active");
  document.getElementById("umapResizeFullscreen").classList.remove("active");
  document.getElementById("umapResizeShaded").classList.remove("active");

  // Add 'active' to the current icon
  if (sizeKey === "big") {
    document.getElementById("umapResizeBig").classList.add("active");
  } else if (sizeKey === "medium") {
    document.getElementById("umapResizeMedium").classList.add("active");
  } else if (sizeKey === "small") {
    document.getElementById("umapResizeSmall").classList.add("active");
  } else if (sizeKey === "fullscreen") {
    document.getElementById("umapResizeFullscreen").classList.add("active");
  } else if (sizeKey === "shaded") {
    document.getElementById("umapResizeShaded").classList.add("active");
  }
}

// Call setActiveResizeIcon whenever you change the window size
// For example, at the end of setUmapWindowSize:
function setUmapWindowSize(sizeKey) {
  const win = document.getElementById("umapFloatingWindow");
  const plotDiv = document.getElementById("umapPlot");
  const contentDiv = document.getElementById("umapContent");
  const landmarkCheckbox = document.getElementById("umapShowLandmarks");
  const controlsDiv = document.getElementById("umapControls");

  win.style.opacity = "0.75"; // default opacity for all sizes
  contentDiv.style.position = "relative";
  controlsDiv.style.position = "";
  controlsDiv.style.bottom = "";
  controlsDiv.style.height = "";

  if (sizeKey === "shaded") {
    // Do not change landmarksVisible or checkbox
    if (contentDiv) {
      contentDiv.style.display = "none";
    }
    // Preserve current width
    const currentWidth = win.style.width || win.getBoundingClientRect().width + "px";
    win.style.width = currentWidth;
    win.style.height = "48px"; // Just enough for titlebar (adjust as needed)
    win.style.minHeight = "0";
    plotDiv.style.width = currentWidth;
    plotDiv.style.height = "0px";
  } else if (sizeKey === "fullscreen") {
    const narrowScreen = window.innerWidth <= 600;
    if (contentDiv) {
      contentDiv.style.display = "block";
    }
    // controlsHeight: space reserved below plot for UMAP controls (~120px with radio buttons)
    // plus clearance for bottom ControlPanel/SearchPanel (~110px)
    const controlsHeight = 230;
    win.style.left = "0px";
    win.style.top = "0px";
    win.style.width = window.innerWidth + "px";
    win.style.height = (narrowScreen ? window.innerHeight - 120 : window.innerHeight) + "px";
    win.style.minHeight = "200px";
    win.style.maxWidth = "100vw";
    win.style.maxHeight = "100vh";
    win.style.opacity = "1";
    plotDiv.style.width = window.innerWidth - 32 + "px";
    plotDiv.style.height = window.innerHeight - controlsHeight + "px";
    if (narrowScreen) {
      // Change positioning of the controls
      contentDiv.style.position = "relative";
      controlsDiv.style.position = "absolute";
      controlsDiv.style.bottom = "60px";
      controlsDiv.style.height = "60px";
    }

    if (plotDiv.data && plotDiv.data.length > 0) {
      Plotly.relayout(plotDiv, {
        width: window.innerWidth - 32,
        height: window.innerHeight - controlsHeight,
        "xaxis.scaleanchor": "y",
      });
    }
  } else {
    if (contentDiv) {
      contentDiv.style.display = "block";
    }
    const { width, height } = UMAP_SIZES[sizeKey];
    const bottomPadding = 8; // add breathing room under plot
    win.style.width = width + 60 + "px";
    win.style.height = height + 120 + bottomPadding + "px"; // window taller
    win.style.minHeight = "200px";
    plotDiv.style.width = width + "px";
    plotDiv.style.height = height - bottomPadding + "px"; // plot area shorter
    Plotly.relayout(plotDiv, { width, height: height - bottomPadding });

    // Turn landmarks OFF in small
    if (sizeKey === "small" && landmarkCheckbox) {
      landmarkCheckbox.checked = false;
      landmarksVisible = false;
      updateLandmarkTrace();
    }
  }

  // Only update position if not shading
  if (sizeKey !== "shaded") {
    if (lastUnshadedPosition.left === null || lastUnshadedPosition.top === null) {
      // Place near top-right with 8px gap
      const winRect = win.getBoundingClientRect();
      const width = winRect.width || win.offsetWidth || 600;
      win.style.top = "8px";
      win.style.left = `${window.innerWidth - width - 8}px`;
    } else {
      win.style.left = lastUnshadedPosition.left;
      win.style.top = lastUnshadedPosition.top;
    }
  }

  if (sizeKey !== "fullscreen") {
    saveCurrentPosition();
  }
  setActiveResizeIcon(sizeKey);
  ensureUmapWindowInView();
  removeUmapThumbnail(); // just in case
}

// Titlebar resizing/dragging code is here.
// Initialize draggable UMAP window a fter DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  updateUmapColorModeAvailability();
  makeDraggable("umapTitlebar", "umapFloatingWindow");
  toggleUmapWindow();
});

// Shading/restoring
function toggleShade() {
  if (isShaded) {
    setUmapWindowSize(lastUnshadedSize);
    isShaded = false;
  } else {
    lastUnshadedSize = getCurrentWindowSize();
    setUmapWindowSize("shaded");
    isShaded = true;
  }
}

// Double-click titlebar to toggle shaded mode
document.getElementById("umapTitlebar").ondblclick = toggleShade;

// Shade icon toggles shaded/unshaded
document.getElementById("umapResizeShaded").onclick = toggleShade;

// Resize buttons
function addButtonHandlers(id, handler) {
  const btn = document.getElementById(id);
  btn.onclick = handler;
  btn.ontouchend = function (e) {
    e.preventDefault();
    handler(e);
  };
}

addButtonHandlers("umapResizeBig", () => {
  setUmapWindowSize("big");
  lastUnshadedSize = "big";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
});
addButtonHandlers("umapResizeMedium", () => {
  setUmapWindowSize("medium");
  lastUnshadedSize = "medium";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
});
addButtonHandlers("umapResizeSmall", () => {
  setUmapWindowSize("small");
  lastUnshadedSize = "small";
  saveCurrentPosition();
  isFullscreen = false;
  updateExitFullscreenCheckboxState();
});
function toggleFullscreen(turnOn = null) {
  const win = document.getElementById("umapFloatingWindow");
  if (turnOn === null) {
    turnOn = !isFullscreen;
  }
  if (turnOn && isFullscreen) {
    return;
  } // already in fullscreen

  if (turnOn) {
    lastUnshadedSize = getCurrentWindowSize();
    lastUnshadedPosition.left = win.style.left;
    lastUnshadedPosition.top = win.style.top;
    setUmapWindowSize("fullscreen");
    win.style.left = "0px";
    win.style.top = "0px";
    isFullscreen = true;
  } else {
    setUmapWindowSize(lastUnshadedSize);
    isFullscreen = false;
  }
  // if any hover thumbnail is visible, remove it
  removeUmapThumbnail();
  // Update checkbox state when fullscreen mode changes
  updateExitFullscreenCheckboxState();
}

addButtonHandlers("umapResizeFullscreen", toggleFullscreen);
addButtonHandlers("umapCloseBtn", () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
});

window.addEventListener("resize", () => {
  // Only resize if UMAP window is in fullscreen mode
  const win = document.getElementById("umapFloatingWindow");
  if (!win || win.style.display !== "block") {
    return;
  }
  if (isFullscreen) {
    setUmapWindowSize("fullscreen");
    // Optionally, update landmarks and current image marker
    updateLandmarkTrace();
    updateCurrentImageMarker();
  }
});

window.addEventListener("slideshowStartRequested", () => {
  toggleUmapWindow(false);
});

// Helper to set the semantic map window title to the album display name
function setSemanticMapTitle() {
  const titleSpan = document.getElementById("semanticMapTitle");
  if (!titleSpan) {
    return;
  }
  getCachedAlbum().then((album) => {
    if (album && album.name) {
      titleSpan.textContent = album.name;
    } else if (state.album) {
      titleSpan.textContent = state.album;
    } else {
      titleSpan.textContent = "Semantic Map";
    }
  });
}

// Expose function to check if UMAP is in fullscreen mode.
export function isUmapFullscreen() {
  return isFullscreen;
}

// Set initial title on DOMContentLoaded
document.addEventListener("DOMContentLoaded", initializeUmapWindow);
window.addEventListener("albumChanged", initializeUmapWindow);

// ========================================================
// Toggle Curation Mode (Grey out all points)
// ========================================================
export function setCurationMode(isActive) {
  isCurationModeActive = isActive;
  updateUmapColors();
}

function updateUmapColors() {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data || !points || points.length === 0) {
    return;
  }

  // Find the "All Points" trace
  const allPointsTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "All Points");
  if (allPointsTraceIndex === -1) {
    return;
  }

  // Set colors and opacity based on curation mode
  let markerColors;
  let markerOpacity;

  if (isCurationModeActive) {
    // Grey out all points when in curation mode
    markerColors = points.map(() => "#888888");
    // Increase opacity of unclustered points to match clustered ones
    markerOpacity = points.map(() => 0.75);
  } else {
    // Use cluster colors
    markerColors = points.map((p) => getClusterColor(p.cluster));
    // Default opacity: unclustered = 0.08, clustered = 0.75
    markerOpacity = points.map((p) => (p.cluster === -1 ? 0.08 : 0.75));
  }

  Plotly.restyle(
    "umapPlot",
    {
      "marker.color": [markerColors],
      "marker.opacity": [markerOpacity],
    },
    allPointsTraceIndex
  );
}

// ========================================================
// Curation Highlighting (Heatmap + Locks)
// ========================================================
export function highlightCurationSelection(highIndices, medIndices, lowIndices, lockedIndices) {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !points || points.length === 0) {
    return;
  }

  // 1. Remove old curation traces
  const tracesToRemove = [];
  if (plotDiv.data) {
    plotDiv.data.forEach((t, i) => {
      if (t.name.startsWith("Curation")) {
        tracesToRemove.push(i);
      }
    });
  }
  if (tracesToRemove.length > 0) {
    Plotly.deleteTraces(plotDiv, tracesToRemove);
  }

  const newTraces = [];
  const lockedSet = new Set(lockedIndices || []);

  // Helper to build trace
  const createTrace = (indices, color, name, size = 8) => {
    if (!indices || indices.length === 0) {
      return null;
    }

    // STRICT FILTER: Never draw a dot in this trace if it is also Locked
    // This prevents Cyan/Magenta from painting over Red
    const validIndices = indices.filter((i) => !lockedSet.has(i));
    if (validIndices.length === 0) {
      return null;
    }

    const idxSet = new Set(validIndices);
    const pts = points.filter((p) => idxSet.has(p.index));

    return {
      x: pts.map((p) => p.x),
      y: pts.map((p) => p.y),
      mode: "markers",
      type: "scattergl",
      name: name,
      marker: {
        color: color,
        size: size,
        symbol: "circle",
        opacity: 1,
        line: { color: "#ffffff", width: 1 },
      },
      hoverinfo: "none",
    };
  };

  // Draw Heatmap Layers FIRST (Bottom)
  const tLow = createTrace(lowIndices, "#00ff00", "CurationLow");
  if (tLow) {
    newTraces.push(tLow);
  }

  const tMed = createTrace(medIndices, "#00ffff", "CurationMed");
  if (tMed) {
    newTraces.push(tMed);
  }

  const tHigh = createTrace(highIndices, "#ff00ff", "CurationHigh");
  if (tHigh) {
    newTraces.push(tHigh);
  }

  // Draw Locked Layer LAST (Top) - No filtering needed here
  if (lockedIndices && lockedIndices.length > 0) {
    const lockedPts = points.filter((p) => lockedSet.has(p.index));
    if (lockedPts.length > 0) {
      newTraces.push({
        x: lockedPts.map((p) => p.x),
        y: lockedPts.map((p) => p.y),
        mode: "markers",
        type: "scattergl",
        name: "CurationLocked",
        marker: {
          color: "#ff0000", // Red
          size: 8,
          symbol: "circle",
          opacity: 1,
          line: { color: "#ffffff", width: 1 },
        },
        hoverinfo: "none",
      });
    }
  }

  if (newTraces.length > 0) {
    Plotly.addTraces(plotDiv, newTraces);
  }
}

// ========================================================
// Clear the Yellow "Current Image" Dot
// ========================================================
export function hideCurrentImageMarker() {
  // 1. Stop any pending updates from the race condition
  if (updateMarkerTimer) {
    clearTimeout(updateMarkerTimer);
  }

  // 2. Set a "Dead Zone" to ignore updates during manual navigation.
  // Any slideChange events occurring in the next period will be ignored.
  ignoreUpdatesUntil = Date.now() + MARKER_UPDATE_IGNORE_WINDOW_MS;

  // 3. Force hide the dot immediately
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) {
    return;
  }

  const markerTraceIndex = plotDiv.data.findIndex((trace) => trace.name === "Current Image");

  if (markerTraceIndex !== -1) {
    Plotly.restyle("umapPlot", { x: [[]], y: [[]] }, markerTraceIndex);
  }
}
