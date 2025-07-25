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

async function fetchUmapData() {
  const eps =
    parseFloat(document.getElementById("umapEpsSpinner").value) || 0.07;
  const response = await fetch(
    `umap_data/?album=${encodeURIComponent(state.album)}&cluster_eps=${eps}`
  );
  const points = await response.json();

  // Always define clusters, palette, and colors
  const clusters = [...new Set(points.map((p) => p.cluster))];
  const palette = [
    "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
    "#ffff33", "#a65628", "#f781bf", "#999999", "#66c2a5",
    "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f",
    "#e5c494", "#b3b3b3",
  ];
  const colors = clusters.map((c, i) => palette[i % palette.length]);

  // If searchResults is not empty, highlight those points in red, others in gray
  if (state.searchResults && state.searchResults.length > 0) {
    const searchSet = new Set(
      state.searchResults.map(r => typeof r === "string" ? r : r.filename)
    );
    let album = await albumManager.getCurrentAlbum();
    const trace = {
      x: points.map(p => p.x),
      y: points.map(p => p.y),
      text: points.map(p => p.filename.split('/').pop()),
      mode: "markers",
      type: "scattergl",
      marker: {
        color: points.map(p =>
          searchSet.has(albumManager.relativePath(p.filename, album)) ? "#e41a1c" : "#cccccc"
        ),
        size: 5,
      },
      customdata: points.map(p => p.filename),
      name: "UMAP Points",
    };
    Plotly.newPlot("umapPlot", [trace], {
      title: "UMAP Embeddings",
      dragmode: "pan",
      height: 500,
      width: 600,
    });
  } else {
    // Default: color by cluster
    const traces = clusters.map((cluster, i) => ({
      x: points.filter((p) => p.cluster === cluster).map((p) => p.x),
      y: points.filter((p) => p.cluster === cluster).map((p) => p.y),
      text: points.filter((p) => p.cluster === cluster).map((p) => p.filename.split('/').pop()),
      mode: "markers",
      type: "scattergl",
      name: `Cluster ${cluster}`,
      marker: { color: colors[i], size: 5 },
      customdata: points
        .filter((p) => p.cluster === cluster)
        .map((p) => p.filename),
    }));
    Plotly.newPlot("umapPlot", traces, {
      title: "UMAP Embeddings",
      dragmode: "pan",
      height: 500,
      width: 600,
    });
  }

  document.getElementById("umapPlot").on("plotly_click", function (data) {
    // Get the cluster of the clicked point
    const clickedFilename = data.points[0].customdata;
    const clickedPoint = points.find(p => p.filename === clickedFilename);
    if (!clickedPoint) return;
    const clickedCluster = clickedPoint.cluster;

    // Find the color for this cluster
    const clusterIndex = clusters.indexOf(clickedCluster);
    const clusterColor = colors[clusterIndex % colors.length];

    // Get all filenames in the same cluster
    const clusterFilenames = points
      .filter(p => p.cluster === clickedCluster)
      .map(p => p.filename);

    // Convert clusterFilenames into an array of search results, including color
    const clusterMembers = clusterFilenames.map(filename => ({
      filename: filename,
      cluster: clickedCluster === -1 ? "Unclustered" : clickedCluster,
      color: clusterColor,
    }));

    window.dispatchEvent(
      new CustomEvent("umapClusterSelected", { detail: clusterMembers })
    );
  });
}

// Update the map when the search results have changed.
window.addEventListener("searchResultsChanged", () => {
  fetchUmapData();
});
