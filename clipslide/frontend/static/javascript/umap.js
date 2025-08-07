// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album.js";
import { getCurrentFilepath, setSearchResults } from "./search.js";
import { state } from "./state.js";
import { getPercentile, isColorLight } from "./utils.js";

const UMAP_SIZES = {
  big: { width: 800, height: 560 },
  medium: { width: 440, height: 280 },
  small: { width: 340, height: 180 },
  fullscreen: { width: window.innerWidth, height: window.innerHeight },
};

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
let umapColorMode = "cluster"; // Default mode
let isShaded = false;
let isFullscreen = false;
let lastUnshadedSize = "medium"; // Track last non-fullscreen size
let lastUnshadedPosition = { left: null, top: null }; // Track last position

// Helper to get current window size
function getCurrentWindowSize() {
  const win = document.getElementById("umapFloatingWindow");
  const width = parseInt(win.style.width, 10);
  if (width === UMAP_SIZES.big.width + 60) return "big";
  return "medium";
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

// --- Show/Hide UMAP Window ---
document.getElementById("showUmapBtn").onclick = async () => {
  const umapWindow = document.getElementById("umapFloatingWindow");
  const labelDiv = document.querySelector("#showUmapBtn + .button-label");
  if (umapWindow.style.display === "block") {
    umapWindow.style.display = "none";
  } else {
    umapWindow.style.display = "block";
    ensureUmapWindowInView();
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
};
document.getElementById("umapCloseBtn").onclick = () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
};

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
  showUmapSpinner();
  try {
    const eps =
      parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(
      `umap_data/${encodeURIComponent(state.album)}?cluster_eps=${eps}`
    );
    points = await response.json();

    // The point filenames returned by umap_data are absolute paths, but we need relative paths
    // So we do a one-time call to the API to fix this
    let album = await getCachedAlbum();
    if (album) {
      // Convert absolute paths to relative paths}
      points.forEach((point) => {
        point.filename = albumManager.relativePath(point.filename, album);
      });
    }

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

    // Prepare hover text
    const hoverText = points.map(
      (p) =>
        `${
          p.cluster === -1 ? "Unclustered" : `Cluster ${p.cluster}`
        }<br>${p.filename.split("/").pop()}`
    );

    // Main trace: all points
    const allPointsTrace = {
      x: points.map((p) => p.x),
      y: points.map((p) => p.y),
      text: hoverText,
      mode: "markers",
      type: "scattergl",
      marker: {
        color: markerColors,
        opacity: markerAlphas,
        size: 5,
      },
      customdata: points.map((p) => p.filename),
      name: "All Points",
      hoverinfo: "none",
    };

    // Current image marker trace
    const currentImageFilename = getCurrentFilepath();
    const currentPoint = points.find(
      (p) => p.filename === currentImageFilename
    );
    const currentImageTrace = currentPoint
      ? {
          x: [currentPoint.x],
          y: [currentPoint.y],
          text: [currentPoint.filename.split("/").pop()],
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
          hoverinfo: "text",
        };

    Plotly.newPlot(
      "umapPlot",
      [allPointsTrace, currentImageTrace],
      {
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
          scaleanchor: "y", // <-- Add this line
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
      },
      {
        modeBarButtonsToRemove: ["select2d", "lasso2d"],
        scrollZoom: true, // <--- Enable scroll wheel zoom
      }
    ).then((gd) => {
      document.getElementById("umapContent").style.display = "block";
      setUmapWindowSize("medium");
      hideUmapSpinner();

      setUmapColorMode();
      let hoverTimer = null;

      gd.on("plotly_hover", function (eventData) {
        if (!eventData || !eventData.points || !eventData.points.length) return;
        const pt = eventData.points[0];
        if (pt.curveNumber !== 0) return;
        const filename = pt.customdata;
        const cluster = points[pt.pointIndex]?.cluster ?? -1;
        // Add hover delay
        hoverTimer = setTimeout(() => {
          createUmapThumbnail({
            x: eventData.event.clientX,
            y: eventData.event.clientY,
            filename,
            cluster,
          });
        }, 200); // 200ms delay (adjust as desired)
      });

      gd.on("plotly_unhover", function () {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        removeUmapThumbnail();
      });

      gd.on("plotly_selected", function (eventData) {
        if (!eventData || !eventData.points || !eventData.points.length) return;
        const selectedFilenames = eventData.points
          .filter((pt) => pt.curveNumber === 0)
          .map((pt) => pt.customdata);

        const selectedResults = selectedFilenames.map((filename) => {
          const point = points.find((p) => p.filename === filename);
          return {
            filename,
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

      // Show the EPS spinner container now that the plot is ready
      const epsContainer = document.getElementById("umapEpsContainer");
      if (epsContainer) epsContainer.style.display = "block";

      // Fix: Remove Plotly's wheel event and re-add as passive
      const plotDiv = document.getElementById("umapPlot");
      // Remove all wheel listeners (Plotly may add more than one)
      plotDiv.removeEventListener('wheel', Plotly.Plots.wheelListener);
      // Add a passive wheel listener (dummy handler, Plotly will still work)
      plotDiv.addEventListener('wheel', function(e) {}, { passive: true });
    });

    // Ensure the current image marker is visible after plot initialization
    setTimeout(() => updateCurrentImageMarker(), 0);

    // Cluster click: highlight cluster as search
    document
      .getElementById("umapPlot")
      .on("plotly_click", async function (data) {
        const clickedFilename = data.points[0].customdata;
        const clickedPoint = points.find((p) => p.filename === clickedFilename);
        if (!clickedPoint) return;
        const clickedCluster = clickedPoint.cluster;
        const clusterIndex = clusters.indexOf(clickedCluster);
        const clusterColor = colors[clusterIndex % colors.length];
        let clusterFilenames = points
          .filter((p) => p.cluster === clickedCluster)
          .map((p) => p.filename);

        // Remove clickedFilename from the list
        clusterFilenames = clusterFilenames.filter(
          (fn) => fn !== clickedFilename
        );

        // --- Sort by ascending distance from clicked point ---
        const clickedCoords = [clickedPoint.x, clickedPoint.y];
        // Build a lookup map once
        const filenameToPoint = Object.fromEntries(
          points.map((p) => [p.filename, p])
        );
        clusterFilenames.sort((a, b) => {
          const pa = filenameToPoint[a];
          const pb = filenameToPoint[b];
          const da = pa
            ? Math.hypot(pa.x - clickedCoords[0], pa.y - clickedCoords[1])
            : Infinity;
          const db = pb
            ? Math.hypot(pb.x - clickedCoords[0], pb.y - clickedCoords[1])
            : Infinity;
          return da - db;
        });

        // Promote the clicked filename to the first position
        const sortedClusterFilenames = [clickedFilename, ...clusterFilenames];

        const clusterMembers = sortedClusterFilenames.map((filename) => ({
          filename: filename,
          cluster: clickedCluster === -1 ? "Unclustered" : clickedCluster,
          color: clusterColor,
        }));
        setSearchResults(clusterMembers, "cluster");
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
    const searchSet = new Set(
      searchResults.map((r) => (typeof r === "string" ? r : r.filename))
    );
    markerColors = points.map((p) => getClusterColor(p.cluster));
    markerAlphas = points.map((p) => (p.cluster === -1 ? 0.1 : searchSet.has(p.filename) ? 1.0 : 0.2));
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
});

// --- Update colorization after search or cluster selection ---
window.addEventListener("searchResultsChanged", function (e) {
  const highlightCheckbox = document.getElementById("umapHighlightSelection");
  const highlight = highlightCheckbox && highlightCheckbox.checked;
  setUmapColorMode();
});

// --- Update Current Image Marker ---
export async function updateCurrentImageMarker() {
  if (!points.length) return;
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data || plotDiv.data.length < 2) return;
  let currentImageFilename = getCurrentFilepath();
  // Use cached album to avoid repeated API calls
  const album = await getCachedAlbum();
  currentImageFilename = albumManager.relativePath(currentImageFilename, album);
  const currentPoint = points.find((p) => p.filename === currentImageFilename);
  if (!currentPoint) return;
  Plotly.restyle(
    "umapPlot",
    {
      x: [[currentPoint.x]],
      y: [[currentPoint.y]],
      text: [[currentPoint.filename.split("/").pop()]],
    },
    1 // current image marker trace is always index 1
  );
  ensureCurrentMarkerInView(0.1); // Ensure it's in view with 10% padding
}

// --- Ensure Current Marker in View ---
export async function ensureCurrentMarkerInView(padFraction = 0.1) {
  if (!points.length) return;
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.layout) return;

  let currentImageFilename = getCurrentFilepath();
  const album = await getCachedAlbum();
  currentImageFilename = albumManager.relativePath(currentImageFilename, album);
  const currentPoint = points.find((p) => p.filename === currentImageFilename);
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

  // Optionally, ensure right/bottom are not off-screen
  const maxLeft = window.innerWidth - rect.width;
  const maxTop = window.innerHeight - rect.height;
  if (left > maxLeft) {
    win.style.left = Math.max(0, maxLeft) + "px";
  }
  if (top > maxTop) {
    win.style.top = Math.max(0, maxTop) + "px";
  }
}

window.addEventListener("albumChanged", async () => {
  // Fetch the album's default EPS value and update the spinner
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
  fetchUmapData();
});

// --- Thumbnail Preview on Hover ---
let umapThumbnailDiv = null;

function createUmapThumbnail({ x, y, filename, cluster }) {
  // Remove any existing thumbnail
  if (umapThumbnailDiv) {
    umapThumbnailDiv.remove();
    umapThumbnailDiv = null;
  }

  // Find cluster color and label
  const clusterIdx = clusters.indexOf(cluster);
  const clusterColor = getClusterColor(cluster);
  const clusterLabel = cluster === -1 ? "Unclustered" : `Cluster ${cluster}`;
  const textIsDark = isColorLight(clusterColor) ? "#222" : "#fff";
  const textShadow = isColorLight(clusterColor)
    ? "0 1px 2px #fff, 0 0px 8px #fff"
    : "0 1px 2px #000, 0 0px 8px #000";

  // Build image URL (use thumbnail endpoint)
  const imgUrl = `thumbnails/${state.album}/${filename}?size=256`;

  // Create the thumbnail div
  umapThumbnailDiv = document.createElement("div");
  umapThumbnailDiv.style.position = "fixed";
  umapThumbnailDiv.style.zIndex = 99999;
  umapThumbnailDiv.style.background = clusterColor;
  umapThumbnailDiv.style.border = "2px solid #222";
  umapThumbnailDiv.style.borderRadius = "10px";
  umapThumbnailDiv.style.boxShadow = "0 4px 24px rgba(0,0,0,0.7)";
  umapThumbnailDiv.style.padding = "12px 12px 0 12px";
  umapThumbnailDiv.style.pointerEvents = "none";
  umapThumbnailDiv.style.transition = "opacity 0.1s";
  umapThumbnailDiv.style.opacity = "0.98";
  umapThumbnailDiv.style.minWidth = "160px";
  umapThumbnailDiv.style.maxWidth = "260px";
  umapThumbnailDiv.style.maxHeight = "400px";
  umapThumbnailDiv.style.display = "flex";
  umapThumbnailDiv.style.flexDirection = "column";
  umapThumbnailDiv.style.alignItems = "center";
  umapThumbnailDiv.style.fontFamily = "inherit";

  // Thumbnail image
  const img = document.createElement("img");
  img.src = imgUrl;
  img.alt = filename.split("/").pop();
  img.style.maxWidth = "240px";
  img.style.maxHeight = "360px";
  img.style.borderRadius = "8px";
  img.style.display = "block";
  img.style.margin = "0 auto";
  img.style.background = "#222";
  img.style.boxShadow = "0 2px 8px rgba(0,0,0,0.4)";
  umapThumbnailDiv.appendChild(img);

  // Filename
  const fnameDiv = document.createElement("div");
  fnameDiv.textContent = filename.split("/").pop();
  fnameDiv.style.fontSize = "0.95em";
  fnameDiv.style.color = textIsDark;
  fnameDiv.style.textShadow = textShadow;
  fnameDiv.style.marginTop = "6px";
  fnameDiv.style.marginBottom = "2px";
  fnameDiv.style.textAlign = "center";
  fnameDiv.style.wordBreak = "break-all";
  umapThumbnailDiv.appendChild(fnameDiv);

  // Cluster label
  const clusterDiv = document.createElement("div");
  clusterDiv.textContent = clusterLabel;
  clusterDiv.style.fontSize = "0.95em";
  clusterDiv.style.fontWeight = "bold";
  clusterDiv.style.color = textIsDark;
  clusterDiv.style.textShadow = textShadow;
  clusterDiv.style.background = "rgba(0,0,0,0.25)";
  clusterDiv.style.width = "100%";
  clusterDiv.style.textAlign = "center";
  clusterDiv.style.borderRadius = "0 0 8px 8px";
  clusterDiv.style.padding = "2px 0 4px 0";
  clusterDiv.style.marginTop = "2px";
  umapThumbnailDiv.appendChild(clusterDiv);

  document.body.appendChild(umapThumbnailDiv);

  // Position the window near the mouse pointer, but not off-screen
  const pad = 12;
  let left = x + pad;
  let top = y + pad;
  const rect = umapThumbnailDiv.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 10) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 10) top = y - rect.height - pad;
  umapThumbnailDiv.style.left = `${Math.max(0, left)}px`;
  umapThumbnailDiv.style.top = `${Math.max(0, top)}px`;
}

function removeUmapThumbnail() {
  if (umapThumbnailDiv) {
    umapThumbnailDiv.remove();
    umapThumbnailDiv = null;
  }
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
  if (sizeKey === "shaded") {
    if (contentDiv) contentDiv.style.display = "none";
    win.style.width = "";
    win.style.height = "";
    win.style.minHeight = "0";
    plotDiv.style.width = "";
    plotDiv.style.height = "";
  } else if (sizeKey === "fullscreen") {
    if (contentDiv) contentDiv.style.display = "block";
    const controlsHeight = 180;
    win.style.left = "0px";
    win.style.top = "0px";
    win.style.width = window.innerWidth + "px";
    win.style.height = window.innerHeight - controlsHeight + "px";
    win.style.minHeight = "200px";
    win.style.maxWidth = "100vw";
    win.style.maxHeight = window.innerHeight - controlsHeight + "px";
    plotDiv.style.width = window.innerWidth - 32 + "px";
    plotDiv.style.height = window.innerHeight - controlsHeight - 128 + "px";

    Plotly.relayout(plotDiv, {
      width: window.innerWidth - 32,
      height: window.innerHeight - controlsHeight - 128,
      "xaxis.scaleanchor": "y", // <-- Add this line for equal axis scale
    });
  } else {
    if (contentDiv) contentDiv.style.display = "block";
    const { width, height } = UMAP_SIZES[sizeKey];
    win.style.width = width + 60 + "px";
    win.style.height = height + 120 + "px";
    win.style.minHeight = "200px";
    plotDiv.style.width = width + "px";
    plotDiv.style.height = height + "px";
    Plotly.relayout(plotDiv, { width, height });

    setTimeout(() => {
      const rect = win.getBoundingClientRect();
      let left = rect.left;
      let top = rect.top;
      const rightEdge = left + rect.width;
      const bottomEdge = top + rect.height;
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;

      if (rightEdge > window.innerWidth) {
        left = Math.max(0, maxLeft);
        win.style.left = left + "px";
      }
      if (bottomEdge > window.innerHeight) {
        top = Math.max(0, maxTop);
        win.style.top = top + "px";
      }
    }, 0);
  }
  setActiveResizeIcon(sizeKey);
  ensureUmapWindowInView();
}

// Titlebar resizing/dragging code is here.
// Initialize draggable UMAP window a fter DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  updateUmapColorModeAvailability();
  makeDraggable("umapTitlebar", "umapFloatingWindow");
});

// Double-click titlebar to toggle shaded mode
document.getElementById("umapTitlebar").ondblclick = () => {
  const win = document.getElementById("umapFloatingWindow");
  if (isShaded) {
    setUmapWindowSize(lastUnshadedSize);
    isShaded = false;
  } else {
    lastUnshadedSize = getCurrentWindowSize();
    setUmapWindowSize("shaded");
    isShaded = true;
  }
};

// Shade icon toggles shaded/unshaded
document.getElementById("umapResizeShaded").onclick = () => {
  const win = document.getElementById("umapFloatingWindow");
  if (isShaded) {
    setUmapWindowSize(lastUnshadedSize);
    isShaded = false;
  } else {
    lastUnshadedSize = getCurrentWindowSize();
    setUmapWindowSize("shaded");
    isShaded = true;
  }
};

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
addButtonHandlers("umapResizeFullscreen", () => {
  const win = document.getElementById("umapFloatingWindow");
  if (isFullscreen) {
    setUmapWindowSize(lastUnshadedSize);
    if (
      lastUnshadedPosition.left !== null &&
      lastUnshadedPosition.top !== null
    ) {
      win.style.left = lastUnshadedPosition.left;
      win.style.top = lastUnshadedPosition.top;
    }
    isFullscreen = false;
  } else {
    lastUnshadedSize = getCurrentWindowSize();
    lastUnshadedPosition.left = win.style.left;
    lastUnshadedPosition.top = win.style.top;
    setUmapWindowSize("fullscreen");
    win.style.left = "0px";
    win.style.top = "0px";
    isFullscreen = true;
  }
});
addButtonHandlers("umapCloseBtn", () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
});
