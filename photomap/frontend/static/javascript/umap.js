// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-manager.js";
import { getImagePath, setSearchResults } from "./search.js";
import { getCurrentSlideIndex } from "./slide-state.js";
import { state } from "./state.js";
import { debounce, getPercentile, isColorLight } from "./utils.js";

const UMAP_SIZES = {
  big: { width: 800, height: 560 },
  medium: { width: 440, height: 280 },
  small: { width: 340, height: 180 },
  fullscreen: { width: window.innerWidth, height: window.innerHeight },
};
const landmarkCount = 18; // Maximum number of non-overlapping landmarks to show at any time
const randomWalkMaxSize = 2000; // Max cluster size to use random walk ordering

let points = [];
let clusters = [];
let colors = [];
let palette = [
  "#e41a1c",
  "#377eb8",
  "#4daf4a",
  "#984ea3",
  "#ff7f00",
  "#ffff33",
  "#a65628",
  "#f781bf",
  "#999999",
  "#66c2a5",
  "#fc8d62",
  "#8da0cb",
  "#e78ac3",
  "#a6d854",
  "#ffd92f",
  "#e5c494",
  "#b3b3b3",
];
let mapExists = false;
let isShaded = false;
let umapWindowHasBeenShown = false; // Track if window has been shown at least once
let isFullscreen = true;
let lastUnshadedSize = "medium"; // Track last non-fullscreen size
let lastUnshadedPosition = { left: null, top: null }; // Track last position
let landmarksVisible = false;
let hoverThumbnailsEnabled = true; // default ON

// Track current zoom level to detect zoom changes
let currentZoomLevel = null;

// Helper to get current window size
function getCurrentWindowSize() {
  const win = document.getElementById("umapFloatingWindow");
  const width = parseInt(win.style.width, 10);
  if (isFullscreen) return "fullscreen";
  if (width >= UMAP_SIZES.big.width) return "big";
  if (width >= UMAP_SIZES.medium.width) return "medium";
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
  if (cluster === -1) return "#cccccc";
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
  const eps =
    parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
  if (epsUpdateTimer) clearTimeout(epsUpdateTimer);
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
  if (mapExists && !state.dataChanged) return;
  if (!state.album) return;
  showUmapSpinner();
  try {
    const eps =
      parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(
      `umap_data/${encodeURIComponent(state.album)}?cluster_eps=${eps}`
    );
    points = await response.json();

    // Compute clusters and colors
    clusters = [...new Set(points.map((p) => p.cluster))];
    colors = clusters.map((c, i) => palette[i % palette.length]);

    // Compute axis ranges (1st to 99th percentile)
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = getPercentile(xs, 1);
    const xMax = getPercentile(xs, 99);
    const yMin = getPercentile(ys, 1);
    const yMax = getPercentile(ys, 99);

    // Prepare marker arrays
    const markerColors = points.map((p) => getClusterColor(p.cluster));
    const markerAlphas = points.map((p) => (p.cluster === -1 ? 0.08 : 0.5));

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
    const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
    const currentPoint = points.find((p) => p.index === globalIndex);
    const currentImageTrace = currentPoint
      ? {
          x: [currentPoint.x],
          y: [currentPoint.y],
          text: [
            "Current slide: " +
              (await getImagePath(state.album, currentPoint.index))
                .split("/")
                .pop(),
          ],
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
      modeBarButtonsToRemove: ["select2d", "lasso2d"],
      scrollZoom: true,
    };

    Plotly.newPlot(
      "umapPlot",
      [allPointsTrace, currentImageTrace],
      layout,
      config
    ).then((gd) => {
      document.getElementById("umapContent").style.display = "block";
      setUmapWindowSize("fullscreen");
      hideUmapSpinner();

      setUmapColorMode();
      let hoverTimer = null;
      let isHovering = false;

      gd.on("plotly_hover", function (eventData) {
        if (!hoverThumbnailsEnabled) return;
        if (!eventData || !eventData.points || !eventData.points.length) return;
        const pt = eventData.points[0];
        if (pt.curveNumber !== 0) return;
        const index = pt.customdata;
        const cluster = points[pt.pointIndex]?.cluster ?? -1;
        isHovering = true;
        hoverTimer = setTimeout(() => {
          if (isHovering) {
            createUmapThumbnail({
              x: eventData.event.clientX,
              y: eventData.event.clientY,
              index: index,
              cluster: cluster,
            });
          }
        }, 150);
      });

      gd.on("plotly_unhover", function () {
        isHovering = false;
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        removeUmapThumbnail();
      });

      gd.on("plotly_selected", function (eventData) {
        if (!eventData || !eventData.points || !eventData.points.length) return;
        const selectedIndexes = eventData.points
          .filter((pt) => pt.curveNumber === 0)
          .map((pt) => pt.customdata);

        const selectedResults = selectedIndexes.map((index) => {
          const point = points.find((p) => p.index === index);
          return {
            index: index,
            color: getClusterColor(point?.cluster ?? -1),
            score: point?.score ?? 1.0,
          };
        });

        window.dispatchEvent(
          new CustomEvent("searchResultsChanged", {
            detail: { results: selectedResults, searchType: "cluster" },
          })
        );
      });

      gd.on("plotly_relayout", (eventData) => {
        if (suppressRelayoutEvent) return; // Prevent feedback loop

        // Only update landmarks for actual user pan/zoom events, not our programmatic changes
        const isPanZoom =
          eventData["xaxis.range[0]"] !== undefined ||
          eventData["yaxis.range[0]"] !== undefined ||
          eventData["xaxis.range"] !== undefined ||
          eventData["yaxis.range"] !== undefined;

        const isResize =
          eventData.width !== undefined || eventData.height !== undefined;
        const isImageUpdate = eventData.images !== undefined;

        // Only update landmarks for pan/zoom, not for our own image updates or resizes
        if (isPanZoom && !isImageUpdate && !isResize) {
          debouncedUpdateLandmarkTrace();
        }
      });

      gd.on("plotly_redraw", () => {
        if (suppressRelayoutEvent) return;
        debouncedUpdateLandmarkTrace();
      });

      // Initial landmark update
      if (landmarksVisible) {
        setTimeout(updateLandmarkTrace, 500);
      }

      // Show the EPS spinner container now that the plot is ready
      const epsContainer = document.getElementById("umapEpsContainer");
      if (epsContainer) epsContainer.style.display = "block";

      // Add triangle trace and images after plot is created
      if (landmarksVisible && typeof landmarkTrace != "undefined") {
        setTimeout(() => {
          Plotly.addTraces(gd, [landmarkTrace]);
          Plotly.relayout(gd, { images });
        }, 500);
      }

      // After adding traces (e.g., landmarks), move the marker trace to the end
      const plotDiv = document.getElementById("umapPlot");
      const markerTraceIndex = plotDiv.data.findIndex(
        (trace) => trace.name === "Current Image"
      );
      if (
        markerTraceIndex !== -1 &&
        markerTraceIndex !== plotDiv.data.length - 1
      ) {
        Plotly.moveTraces(plotDiv, markerTraceIndex, plotDiv.data.length - 1);
      }
    });

    // Ensure the current image marker is visible after plot initialization
    setTimeout(() => updateCurrentImageMarker(), 0);

    // Cluster click: highlight cluster as search
    document
      .getElementById("umapPlot")
      .on("plotly_click", async function (data) {
        const traceName = data.points[0].fullData.name;
        if (traceName === "LandmarkClickTargets") {
          // Get cluster ID from customdata
          const clusterId = data.points[0].customdata;
          // Get all points in this cluster
          const clusterPoints = points.filter((p) => p.cluster === clusterId);
          // Use the landmark placement algorithm to get the landmark point
          const landmarkPoint = getLandmarkForCluster(clusterPoints);
          if (landmarkPoint) {
            await handleClusterClick(landmarkPoint.index);
          }
        } else if (data.points[0].curveNumber === 0) {
          // Regular scatter plot click
          await handleClusterClick(data.points[0].customdata);
        }
      });

    window.umapPoints = points;
    state.dataChanged = false;

    setUmapColorMode();
  } finally {
    hideUmapSpinner();
  }

  mapExists = true;
}

// --- Dynamic Colorization ---
export function colorizeUmap({ highlight = false, searchResults = [] } = {}) {
  if (!points.length) return;
  let markerColors, markerAlphas;

  if (highlight && searchResults.length > 0) {
    const searchSet = new Set(searchResults.map((r) => r.index));
    markerColors = points.map((p) => getClusterColor(p.cluster));
    markerAlphas = points.map((p) =>
      p.cluster === -1 ? 0.1 : searchSet.has(p.index) ? 1.0 : 0.2
    );
  } else {
    markerColors = points.map((p) => getClusterColor(p.cluster));
    markerAlphas = points.map((p) => (p.cluster === -1 ? 0.1 : 0.5));
  }
  Plotly.restyle(
    "umapPlot",
    {
      "marker.color": [markerColors],
      "marker.opacity": [markerAlphas],
    },
    [0]
  );
}

// --- Checkbox event handler ---
document.addEventListener("DOMContentLoaded", () => {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  if (highlightCheckbox) {
    highlightCheckbox.checked = false;
    highlightCheckbox.addEventListener("change", () => {
      setUmapColorMode();
    });
  }

  // Hover thumbnails checkbox
  const hoverThumbCheckbox = document.getElementById("umapShowHoverThumbnails");
  if (hoverThumbCheckbox) {
    hoverThumbCheckbox.checked = true;
    hoverThumbnailsEnabled = true;
    hoverThumbCheckbox.addEventListener("change", (e) => {
      hoverThumbnailsEnabled = e.target.checked;
      // Remove any popup if disabling
      if (!hoverThumbnailsEnabled) removeUmapThumbnail();
    });
  }

  // Landmarks checkbox
  const landmarkCheckbox = document.getElementById("umapShowLandmarks");
  if (landmarkCheckbox) {
    landmarkCheckbox.checked = false;
    landmarksVisible = false;
    landmarkCheckbox.addEventListener("change", (e) => {
      landmarksVisible = e.target.checked;
      updateLandmarkTrace();
    });
  }
});

// --- Update colorization after search or cluster selection ---
window.addEventListener("searchResultsChanged", function (e) {
  setUmapColorMode();
  // deactivate fullscreen mode when search results have come in
  if (state.searchResults.length > 0 && isFullscreen) {
    setTimeout(() => toggleFullscreen(false), 100); // slight delay to avoid flicker
  }
});

window.addEventListener("slideChanged", async () => {
  // Ensure the current image marker is updated when the slide changes
  // add a slight timeout to ensure the slide is fully loaded.
  setTimeout(() => updateCurrentImageMarker(), 500);
});

// --- Update Current Image Marker ---
export async function updateCurrentImageMarker() {
  if (!points.length) return;
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data) return;

  // Find the trace index for the current image marker
  const markerTraceIndex = plotDiv.data.findIndex(
    (trace) => trace.name === "Current Image"
  );
  if (markerTraceIndex === -1) return;

  const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
  if (globalIndex === -1) return; // No current image
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) return;

  Plotly.restyle(
    "umapPlot",
    {
      x: [[currentPoint.x]],
      y: [[currentPoint.y]],
    },
    markerTraceIndex // Use the found index
  );
  ensureCurrentMarkerInView(0.1);
}

// --- Ensure Current Marker in View ---
export async function ensureCurrentMarkerInView(padFraction = 0.1) {
  if (!points.length) return;
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) return;

  const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
  const currentPoint = points.find((p) => p.index === globalIndex);
  if (!currentPoint) return;

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
  if (!win) return;
  const rect = win.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;

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
  if (!state.album) return;
  const result = await fetch("get_umap_eps/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ album: state.album }),
  });
  const data = await result.json();
  if (data.success) {
    const epsSpinner = document.getElementById("umapEpsSpinner");
    if (epsSpinner) epsSpinner.value = data.eps;
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
  if (!filename) return; // No valid filename, exit early

  // Find cluster color and label
  const clusterColor = getClusterColor(cluster);
  const clusterLabel = cluster === -1 ? "Unclustered" : `Cluster ${cluster}`;
  const textIsDark = isColorLight(clusterColor) ? "#222" : "#fff";
  const textShadow = isColorLight(clusterColor)
    ? "0 1px 2px #fff, 0 0px 8px #fff"
    : "0 1px 2px #000, 0 0px 8px #000";

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
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) return;
    let rect = null;
    try {
      rect = umapThumbnailDiv.getBoundingClientRect();
    } catch (e) {
      console.warn("Error getting thumbnail div dimensions:", e);
      return; // Exit if we can't get dimensions
    }
    if (left + rect.width > window.innerWidth - 10) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 10)
      top = y - rect.height - pad;
    umapThumbnailDiv.style.left = `${Math.max(0, left)}px`;
    umapThumbnailDiv.style.top = `${Math.max(0, top)}px`;
    umapThumbnailDiv.style.visibility = "visible"; // <-- Show after loaded
  };

  // Handle image load error
  img.onerror = () => {
    if (!umapThumbnailDiv || !document.body.contains(umapThumbnailDiv)) return;
    umapThumbnailDiv.style.visibility = "visible";
    img.alt = "Thumbnail not available";
  };
}

function removeUmapThumbnail() {
  // Remove all elements with the umap-thumbnail class
  document.querySelectorAll(".umap-thumbnail").forEach((div) => div.remove());
  umapThumbnailDiv = null;
}

export function setUmapColorMode() {
  colorizeUmap({
    highlight: document.getElementById("umapHighlightSelection")?.checked,
    searchResults: state.searchResults,
  });
}

// Ensure color mode is respected after search or cluster selection
window.addEventListener("searchResultsChanged", function (e) {
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
  setUmapColorMode();
}

// ------------- Handling Landmark Thumbnails -------------

// Landmark placement algorithm
function getLandmarkForCluster(pts) {
  // 1. Find X center
  const centerX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;

  // 2. Compute X spread (standard deviation and range)
  const xs = pts.map((p) => p.x);
  const xMean = centerX;
  const xStd = Math.sqrt(
    xs.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0) / xs.length
  );
  const xRange = Math.max(...xs) - Math.min(...xs);

  // 3. Filter points near centerX (within 0.5 * std or 0.2 * range)
  const threshold = Math.max(xStd * 0.5, xRange * 0.2);
  const candidates = pts.filter((p) => Math.abs(p.x - centerX) <= threshold);

  // 4. Pick highest Y among candidates
  let best = candidates[0] || pts[0];
  for (const p of candidates) {
    if (p.y > best.y) best = p;
  }
  return best;
}

// Helper: get cluster centers and representatives
function getLargestClustersInView(maxLandmarks = 10) {
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) return [];
  const [xMin, xMax] = plotDiv.layout.xaxis.range;
  const [yMin, yMax] = plotDiv.layout.yaxis.range;

  // Group points by cluster
  const clusterMap = new Map();
  points.forEach((p) => {
    if (p.cluster === -1) return;
    if (!clusterMap.has(p.cluster)) clusterMap.set(p.cluster, []);
    clusterMap.get(p.cluster).push(p);
  });

  let clustersInView = [];
  for (const [cluster, pts] of clusterMap.entries()) {
    const landmark = getLandmarkForCluster(pts);
    // Only include if landmark is in view
    if (
      landmark.x >= xMin &&
      landmark.x <= xMax &&
      landmark.y >= yMin &&
      landmark.y <= yMax
    ) {
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
  if (isRenderingLandmarks) return;
  isRenderingLandmarks = true;

  try {
    const plotDiv = document.getElementById("umapPlot");
    if (!plotDiv || !plotDiv.layout) return;

    // Remove previous landmark traces (both triangles and click targets)
    let landmarkTraceIdx = plotDiv.data?.findIndex(
      (t) => t.name === "Landmarks"
    );
    let clickTargetTraceIdx = plotDiv.data?.findIndex(
      (t) => t.name === "LandmarkClickTargets"
    );

    // Only delete if index is valid
    if (
      typeof landmarkTraceIdx === "number" &&
      landmarkTraceIdx >= 0 &&
      landmarkTraceIdx < plotDiv.data.length
    ) {
      suppressRelayoutEvent = true;
      Plotly.deleteTraces(plotDiv, landmarkTraceIdx).then(() => {
        suppressRelayoutEvent = false;
      });
    }

    // Recompute clickTargetTraceIdx after possible deletion above
    clickTargetTraceIdx = plotDiv.data?.findIndex(
      (t) => t.name === "LandmarkClickTargets"
    );
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
    if (!clusters.length) return;

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
    const yRange =
      plotDiv.layout.yaxis.range[1] - plotDiv.layout.yaxis.range[0];
    const pixelToData = yRange / plotHeightPx;
    const verticalOffset = 24 * pixelToData;

    // Prepare trace data
    const clustersInView = getNonOverlappingLandmarks(
      clusters,
      imageSize,
      landmarkCount
    );
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
        color: "rgba(0, 0, 0, 0)",
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
      source: `thumbnails/${state.album}/${
        c.representative
      }?size=${thumbSize}&color=${encodeURIComponent(c.color)}`,
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
}

// Debounced version for event handlers
const debouncedUpdateLandmarkTrace = debounce(updateLandmarkTrace, 500);

// Helper function to get non-overlapping landmarks
function getNonOverlappingLandmarks(
  clusters,
  imageSize,
  landmarkCount = landmarkCount
) {
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
      dist: Math.hypot(
        indexToPoint[idx].x - startPoint.x,
        indexToPoint[idx].y - startPoint.y
      ),
    }))
    .sort((a, b) => a.dist - b.dist)
    .map((item) => item.index);
}

// Shared function for cluster clicks
async function handleClusterClick(clickedIndex) {
  const clickedPoint = points.find((p) => p.index === clickedIndex);
  if (!clickedPoint) return;

  const clickedCluster = clickedPoint.cluster;
  const clusterIndex = clusters.indexOf(clickedCluster);
  const clusterColor = colors[clusterIndex % colors.length];
  let clusterIndices = points
    .filter((p) => p.cluster === clickedCluster)
    .map((p) => p.index);

  // Remove clickedFilename from the list
  clusterIndices = clusterIndices.filter((fn) => fn !== clickedIndex);

  // --- Greedy random walk order from clicked point ---
  const sort_algorithm =
    clusterIndices.length > randomWalkMaxSize
      ? proximityClusterOrder
      : randomWalkClusterOrder;
  const sortedClusterIndices = sort_algorithm(
    [clickedIndex, ...clusterIndices],
    points,
    clickedIndex
  );

  const clusterMembers = sortedClusterIndices.map((index) => ({
    index: index,
    cluster: clickedCluster === -1 ? "Unclustered" : clickedCluster,
    color: clusterColor,
  }));

  setSearchResults(clusterMembers, "cluster");
}

// -------------------- Window Management --------------------

// --- Show/Hide UMAP Window ---
export async function toggleUmapWindow(show = null) {
  const umapWindow = document.getElementById("umapFloatingWindow");

  if (show === null)
    show =
      document.getElementById("umapFloatingWindow").style.display !== "block";

  if (show === false) {
    umapWindow.style.display = "none";
  } else {
    umapWindow.style.display = "block";
    ensureUmapWindowInView();
    if (!umapWindowHasBeenShown) {
      umapWindowHasBeenShown = true;
      setUmapWindowSize("fullscreen");
    }

    if (state.album === null) return;
    
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
    if (epsSpinner) epsSpinner.value = data.eps;
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
    if (!dragging) return;
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
  const hoverThumbCheckbox = document.getElementById("umapShowHoverThumbnails");
  const controlsDiv = document.getElementById("umapControls");

  win.style.opacity = "0.75"; // default opacity for all sizes
  contentDiv.style.position = "relative";
  controlsDiv.style.position = "";
  controlsDiv.style.bottom = "";
  controlsDiv.style.height = "";

  if (sizeKey === "shaded") {
    // Do not change landmarksVisible or checkbox
    if (contentDiv) contentDiv.style.display = "none";
    // Preserve current width
    const currentWidth =
      win.style.width || win.getBoundingClientRect().width + "px";
    win.style.width = currentWidth;
    win.style.height = "48px"; // Just enough for titlebar (adjust as needed)
    win.style.minHeight = "0";
    plotDiv.style.width = currentWidth;
    plotDiv.style.height = "0px";
  } else if (sizeKey === "fullscreen") {
    const narrowScreen = window.innerWidth <= 600;
    if (contentDiv) contentDiv.style.display = "block";
    const controlsHeight = 180;
    win.style.left = "0px";
    win.style.top = "0px";
    win.style.width = window.innerWidth + "px";
    win.style.height =
      (narrowScreen ? window.innerHeight - 120 : window.innerHeight) + "px";
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

    // Turn landmarks ON in fullscreen
    if (landmarkCheckbox) {
      landmarkCheckbox.checked = true;
      landmarksVisible = true;
      updateLandmarkTrace();
    }
    // Turn hover thumbnails OFF in fullscreen
    if (hoverThumbCheckbox) {
      hoverThumbCheckbox.checked = false;
      hoverThumbnailsEnabled = false;
    }
  } else {
    if (contentDiv) contentDiv.style.display = "block";
    const { width, height } = UMAP_SIZES[sizeKey];
    win.style.width = width + 60 + "px";
    win.style.height = height + 120 + "px";
    win.style.minHeight = "200px";
    plotDiv.style.width = width + "px";
    plotDiv.style.height = height + "px";
    Plotly.relayout(plotDiv, { width, height });

    // Turn landmarks OFF in big, medium, small
    if (landmarkCheckbox) {
      landmarkCheckbox.checked = false;
      landmarksVisible = false;
      updateLandmarkTrace();
    }
    // Turn hover thumbnails ON in big, medium, small
    if (hoverThumbCheckbox) {
      hoverThumbCheckbox.checked = true;
      hoverThumbnailsEnabled = true;
    }
  }

  // Only update position if not shading
  if (sizeKey !== "shaded") {
    if (
      lastUnshadedPosition.left === null ||
      lastUnshadedPosition.top === null
    ) {
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

  if (sizeKey !== "fullscreen") saveCurrentPosition();
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
});
addButtonHandlers("umapResizeMedium", () => {
  setUmapWindowSize("medium");
  lastUnshadedSize = "medium";
  saveCurrentPosition();
  isFullscreen = false;
});
addButtonHandlers("umapResizeSmall", () => {
  setUmapWindowSize("small");
  lastUnshadedSize = "small";
  saveCurrentPosition();
  isFullscreen = false;
});
function toggleFullscreen(turnOn = null) {
  const win = document.getElementById("umapFloatingWindow");
  if (turnOn === null) {
    turnOn = !isFullscreen;
  }
  if (turnOn && isFullscreen) return; // already in fullscreen

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
}

addButtonHandlers("umapResizeFullscreen", toggleFullscreen);
addButtonHandlers("umapCloseBtn", () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
});

window.addEventListener("resize", () => {
  // Only resize if UMAP window is in fullscreen mode
  const win = document.getElementById("umapFloatingWindow");
  if (!win || win.style.display !== "block") return;
  if (isFullscreen) {
    setUmapWindowSize("fullscreen");
    // Optionally, update landmarks and current image marker
    updateLandmarkTrace();
    updateCurrentImageMarker();
  }
});

// Helper to set the semantic map window title to the album display name
function setSemanticMapTitle() {
  const titleSpan = document.getElementById("semanticMapTitle");
  if (!titleSpan) return;
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
