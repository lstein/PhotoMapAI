// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-management.js";
import { getCurrentFilepath } from "./api.js";
import { state } from "./state.js";
import { getPercentile } from "./utils.js";

const PLOT_HEIGHT= 300;
const PLOT_WIDTH = 400;

// Umap drawing and interaction logic
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

  fetchUmapData();
};
document.getElementById("umapCloseBtn").onclick = () => {
  document.getElementById("umapFloatingWindow").style.display = "none";
};

let epsUpdateTimer = null;

// Add event listener to spinner
document.getElementById("umapEpsSpinner").oninput = async () => {
  const eps =
    parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;

  // Cancel any previous timer
  if (epsUpdateTimer) clearTimeout(epsUpdateTimer);

  // Set a new timer
  epsUpdateTimer = setTimeout(async () => {
    await fetch("set_umap_eps/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album: state.album, eps }),
    });
    state.dataChanged = true; // Mark state as changed
    fetchUmapData();
  }, 1000); // 1000ms debounce delay
};

function showUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "block";
}
function hideUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "none";
}

async function fetchUmapData() {
  if (!state.dataChanged) return;
  showUmapSpinner();
  try {
    const eps =
      parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(
      `umap_data/?album=${encodeURIComponent(state.album)}&cluster_eps=${eps}`
    );
    const points = await response.json();

    // Calculate bounding box to capture 98% of points
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);

    const xMin = getPercentile(xs, 1);
    const xMax = getPercentile(xs, 99);
    const yMin = getPercentile(ys, 1);
    const yMax = getPercentile(ys, 99);

    // Always define clusters, palette, and colors
    const clusters = [...new Set(points.map((p) => p.cluster))];
    const palette = [
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
    const colors = clusters.map((c, i) => palette[i % palette.length]);
    let album = await albumManager.getCurrentAlbum();

    // Current image trace
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
            symbol: "circle-dot", // This is the closest to a map pin
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
            symbol: "marker", // This is the closest to a map pin
            line: { color: "#000", width: 2 },
          },
          name: "Current Image",
          hoverinfo: "text",
        };

    // If searchResults is not empty, highlight those points in red, others in gray
    if (state.searchResults && state.searchResults.length > 0) {
      const searchSet = new Set(
        state.searchResults.map((r) => (typeof r === "string" ? r : r.filename))
      );

      // Map points to include their relative path once
      const pointsWithRel = points.map((p) => ({
        ...p,
        relPath: albumManager.relativePath(p.filename, album),
      }));

      const highlighted = pointsWithRel.filter((p) => searchSet.has(p.relPath));
      const background = pointsWithRel.filter((p) => !searchSet.has(p.relPath));

      const grayTrace = {
        x: background.map((p) => p.x),
        y: background.map((p) => p.y),
        text: background.map((p) => p.filename.split("/").pop()),
        mode: "markers",
        type: "scattergl",
        marker: {
          color: "rgba(200,200,200,0.18)", // lighter gray for dark bg
          size: 5,
        },
        customdata: background.map((p) => p.filename),
        name: "Other Points",
        hoverinfo: "text",
        opacity: 0.75,
      };

      const highlightColor =
        state.searchResults.length > 0 && state.searchResults[0].color
          ? state.searchResults[0].color
          : "#ff4b4bda"; // fallback to red if not set

      const redTrace = {
        x: highlighted.map((p) => p.x),
        y: highlighted.map((p) => p.y),
        text: highlighted.map((p) => p.filename.split("/").pop()),
        mode: "markers",
        type: "scattergl",
        marker: {
          color: highlightColor,
          size: 5,
        },
        customdata: highlighted.map((p) => p.filename),
        name: "Search Results",
        hoverinfo: "text",
        opacity: 0.75,
      };

      // When plotting:
      const traces = [grayTrace, redTrace, currentImageTrace];

      Plotly.newPlot("umapPlot", traces, {
        title: {
          text: "UMAP Embeddings",
          font: { color: "#eee" },
          x: 0,           // Align to left
          xanchor: "left" // Anchor to left
        },
        dragmode: "pan",
        height: PLOT_HEIGHT,
        width: PLOT_WIDTH,
        plot_bgcolor: "rgba(32,32,48,0.95)", // dark plot area
        paper_bgcolor: "rgba(24,24,32,0.97)", // dark outer background
        font: { color: "#eee" }, // light text for axes, legend, etc.
        xaxis: {
          gridcolor: "rgba(255,255,255,0.1)",
          zerolinecolor: "rgba(255,255,255,0.2)",
          color: "#eee",
          linecolor: "#888",
          tickcolor: "#888",
          range: [xMin, xMax], // Set x-axis range
        },
        yaxis: {
          gridcolor: "rgba(255,255,255,0.1)",
          zerolinecolor: "rgba(255,255,255,0.2)",
          color: "#eee",
          linecolor: "#888",
          tickcolor: "#888",
          range: [yMin, yMax], // Set y-axis range
        },
        margin: {
          t: 30, // top margin
          r: 30, // right margin
          b: 30, // bottom margin
          l: 30, // left margin
          pad: 0, // padding
        },
      });

      // Color by cluster if no search results
    } else {
      const traces = clusters.map((cluster, i) => {
        const isNoise = cluster === -1;
        const clusterPoints = points.filter((p) => p.cluster === cluster);
        return {
          x: clusterPoints.map((p) => p.x),
          y: clusterPoints.map((p) => p.y),
          text: clusterPoints.map(
            (p) =>
              `${isNoise ? "Unclustered" : `Cluster ${cluster}`}<br>${p.filename
                .split("/")
                .pop()}`
          ),
          mode: "markers",
          type: "scattergl",
          name: isNoise ? "Unclustered" : `Cluster ${cluster}`,
          marker: { color: isNoise ? "#cccccc" : colors[i], size: 5 },
          customdata: clusterPoints.map((p) => p.filename),
          opacity: 0.75,
          hoverinfo: "text",
        };
      });
      traces.push(currentImageTrace);
      Plotly.newPlot("umapPlot", traces, {
        title: {
          text: "Semantic Map",
          font: { color: "#eee" },
          x: 0,           // Align to left
          xanchor: "left" // Anchor to left
        },
        dragmode: "pan",
        height: PLOT_HEIGHT,
        width: PLOT_WIDTH,
        plot_bgcolor: "rgba(32,32,48,0.95)", // dark plot area
        paper_bgcolor: "rgba(24,24,32,0.97)", // dark outer background
        font: { color: "#eee" }, // light text for axes, legend, etc.
        xaxis: {
          gridcolor: "rgba(255,255,255,0.1)",
          zerolinecolor: "rgba(255,255,255,0.2)",
          color: "#eee",
          linecolor: "#888",
          tickcolor: "#888",
          range: [xMin, xMax], // Set x-axis range
        },
        yaxis: {
          gridcolor: "rgba(255,255,255,0.1)",
          zerolinecolor: "rgba(255,255,255,0.2)",
          color: "#eee",
          linecolor: "#888",
          tickcolor: "#888",
          range: [yMin, yMax], // Set y-axis range
        },
        margin: {
          t: 30, // top margin
          r: 30, // right margin
          b: 30, // bottom margin
          l: 30, // left margin
          pad: 0, // padding
        },
      });
    }

    document
      .getElementById("umapPlot")
      .on("plotly_click", async function (data) {
        // Get the cluster of the clicked point
        const clickedFilename = data.points[0].customdata;
        const clickedPoint = points.find((p) => p.filename === clickedFilename);
        if (!clickedPoint) return;
        const clickedCluster = clickedPoint.cluster;

        // Find the color for this cluster
        const clusterIndex = clusters.indexOf(clickedCluster);
        const clusterColor = colors[clusterIndex % colors.length];

        // Get all filenames in the same cluster as relative paths
        let album = await albumManager.getCurrentAlbum();
        const clusterFilenames = points
          .filter((p) => p.cluster === clickedCluster)
          .map((p) => albumManager.relativePath(p.filename, album));

        // Convert clusterFilenames into an array of search results, including color
        const clusterMembers = clusterFilenames.map((filename) => ({
          filename: filename,
          cluster: clickedCluster === -1 ? "Unclustered" : clickedCluster,
          color: clusterColor,
        }));

        window.dispatchEvent(
          new CustomEvent("umapClusterSelected", { detail: clusterMembers })
        );
      });

    // Stash the points so that they can passed to swiper.js for slide changes:
    window.umapPoints = points;
  } finally {
    hideUmapSpinner();
    state.dataChanged = false; // Reset the flag after fetching
  }
}

// Update the map when the search results have changed.
window.addEventListener("searchResultsChanged", () => {
  state.dataChanged = true; // Set the flag to true when search results change
  fetchUmapData();
});

export async function updateCurrentImageMarker(points) {
  if (!points || points.length === 0) return;
  const plotDiv = document.getElementById("umapPlot");
  if (!plotDiv || !plotDiv.data || plotDiv.data.length === 0) return;

  const currentImageFilename = getCurrentFilepath();
  const currentPoint = points.find((p) => p.filename === currentImageFilename);
  if (!currentPoint) return;

  // Find the trace index for the current image marker by name
  const traceIndex = plotDiv.data.findIndex(
    (trace) => trace.name === "Current Image"
  );
  if (traceIndex === -1) return; // No marker trace to update

  Plotly.restyle(
    "umapPlot",
    {
      x: [[currentPoint.x]],
      y: [[currentPoint.y]],
      text: [[currentPoint.filename.split("/").pop()]],
    },
    traceIndex
  );
}
