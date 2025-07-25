// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-management.js";
import { getCurrentFilepath } from "./api.js";
import { state } from "./state.js";
import { getPercentile } from "./utils.js";

const PLOT_HEIGHT = 300;
const PLOT_WIDTH = 400;

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
  document.getElementById("umapFloatingWindow").style.display = "block";
  // Update spinner value
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
  state.dataChanged = true;
  await fetchUmapData();
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
  if (!state.dataChanged) return;
  showUmapSpinner();
  try {
    const eps =
      parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(
      `umap_data/?album=${encodeURIComponent(state.album)}&cluster_eps=${eps}`
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
      hoverinfo: "text",
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

    Plotly.newPlot("umapPlot", [allPointsTrace, currentImageTrace], {
      title: {
        text: "Semantic Map",
        font: { color: "#eee" },
        x: 0,
        xanchor: "left",
      },
      showlegend: false,
      dragmode: "pan",
      height: PLOT_HEIGHT,
      width: PLOT_WIDTH,
      plot_bgcolor: "rgba(32,32,48,0.95)",
      paper_bgcolor: "rgba(24,24,32,0.97)",
      font: { color: "#eee" },
      xaxis: {
        gridcolor: "rgba(255,255,255,0.1)",
        zerolinecolor: "rgba(255,255,255,0.2)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [xMin, xMax],
      },
      yaxis: {
        gridcolor: "rgba(255,255,255,0.1)",
        zerolinecolor: "rgba(255,255,255,0.2)",
        color: "#eee",
        linecolor: "#888",
        tickcolor: "#888",
        range: [yMin, yMax],
      },
      margin: {
        t: 30,
        r: 30,
        b: 30,
        l: 30,
        pad: 0,
      },
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
        const clusterFilenames = points
          .filter((p) => p.cluster === clickedCluster)
          .map((p) => p.filename);

        console.log(clickedFilename);
        // If the clicked cluster is unclustered, we treat it as a special case
        // Promote the clicked filename to the first position
        const sortedClusterFilenames = [
          clickedFilename,
          ...clusterFilenames.filter((fn) => fn !== clickedFilename),
        ];

        const clusterMembers = sortedClusterFilenames.map((filename) => ({
          filename: filename,
          cluster: clickedCluster === -1 ? "Unclustered" : clickedCluster,
          color: clusterColor,
        }));
        window.dispatchEvent(
          new CustomEvent("umapClusterSelected", { detail: clusterMembers })
        );
      });

    window.umapPoints = points;
    state.dataChanged = false;
  } finally {
    hideUmapSpinner();
  }
}

// --- Dynamic Colorization ---
export function colorizeUmap({ mode = "cluster", searchResults = [] } = {}) {
  if (!points.length) return;
  let markerColors, markerAlphas;
  if (mode === "search" && searchResults.length > 0) {
    const searchSet = new Set(
      searchResults.map((r) => (typeof r === "string" ? r : r.filename))
    );
    // markerColors = points.map((p) => getClusterColor(p.cluster));
    markerColors = points.map(
      (p) => (searchSet.has(p.filename) ? "#fa4913ff" : "#cccccc") // Highlight search results)
    );
    markerAlphas = points.map((p) => (searchSet.has(p.filename) ? 1.0 : 0.08));
  } else {
    markerColors = points.map((p) => getClusterColor(p.cluster));
    markerAlphas = points.map((p) => (p.cluster === -1 ? 0.01 : 0.5));
  }
  Plotly.restyle(
    "umapPlot",
    {
      "marker.color": [markerColors],
      "marker.opacity": [markerAlphas],
    },
    [0]
  ); // Only update the main points trace
}

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

// --- React to Search/Cluster Selection ---
window.addEventListener("searchResultsChanged", () => {
  state.dataChanged = false; // Don't refetch, just recolor
  colorizeUmap({
    mode:
      state.searchResults && state.searchResults.length > 0
        ? "search"
        : "cluster",
    searchResults: state.searchResults,
  });
});

// --- Initial Data Fetch on Show ---
document.addEventListener("DOMContentLoaded", () => {
  // Optionally, fetch data on load or when needed
});

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
