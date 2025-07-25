// umap.js
// This file handles the UMAP visualization and interaction logic.
import { albumManager } from "./album-management.js";
import { state } from "./state.js";

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

// Add event listener to spinner
document.getElementById("umapEpsSpinner").oninput = async () => {
  const eps =
    parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;

  await fetch("set_umap_eps/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ album: state.album, eps }),
  });
  fetchUmapData();
};

function showUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "block";
}
function hideUmapSpinner() {
  document.getElementById("umapSpinner").style.display = "none";
}

async function fetchUmapData() {
  showUmapSpinner();
  try {
    const eps =
      parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
    const response = await fetch(
      `umap_data/?album=${encodeURIComponent(state.album)}&cluster_eps=${eps}`
    );
    const points = await response.json();

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

    // If searchResults is not empty, highlight those points in red, others in gray
    if (state.searchResults && state.searchResults.length > 0) {
      const searchSet = new Set(
        state.searchResults.map((r) => (typeof r === "string" ? r : r.filename))
      );
      let album = await albumManager.getCurrentAlbum();

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
          color: "rgba(204,204,204,0.1)",
          size: 5,
        },
        customdata: background.map((p) => p.filename),
        name: "Other Points",
        hoverinfo: "text",
        opacity: 0.75,
      };

      const redTrace = {
        x: highlighted.map((p) => p.x),
        y: highlighted.map((p) => p.y),
        text: highlighted.map((p) => p.filename.split("/").pop()),
        mode: "markers",
        type: "scattergl",
        marker: {
          color: "#e41a1c",
          size: 5,
        },
        customdata: highlighted.map((p) => p.filename),
        name: "Search Results",
        hoverinfo: "text",
        opacity: 0.75,
      };

      Plotly.newPlot("umapPlot", [grayTrace, redTrace], {
        title: "UMAP Embeddings",
        dragmode: "pan",
        height: 500,
        width: 600,
        plot_bgcolor: "rgba(255,255,255,0.25)", // plot area background
        paper_bgcolor: "rgba(255,255,255,0.5)", // entire plot background
      });
    } else {
      // Default: color by cluster
      const traces = clusters.map((cluster, i) => {
        const isNoise = cluster === -1;
        return {
          x: points.filter((p) => p.cluster === cluster).map((p) => p.x),
          y: points.filter((p) => p.cluster === cluster).map((p) => p.y),
          text: points
            .filter((p) => p.cluster === cluster)
            .map((p) => p.filename.split("/").pop()),
          mode: "markers",
          type: "scattergl",
          name: isNoise ? "Unclustered" : `Cluster ${cluster}`,
          marker: { color: isNoise ? "#cccccc" : colors[i], size: 5 },
          customdata: points
            .filter((p) => p.cluster === cluster)
            .map((p) => p.filename),
          opacity: 0.75,
        };
      });
      Plotly.newPlot("umapPlot", traces, {
        title: "UMAP Embeddings",
        dragmode: "pan",
        height: 500,
        width: 600,
        plot_bgcolor: "rgba(255,255,255,0.25)", // plot area background
        paper_bgcolor: "rgba(255,255,255,0.5)", // entire plot background
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
  } finally {
    hideUmapSpinner();
  }
}

// Update the map when the search results have changed.
window.addEventListener("searchResultsChanged", () => {
  fetchUmapData();
});
