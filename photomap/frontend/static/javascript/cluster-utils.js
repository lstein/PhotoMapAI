// cluster-utils.js
// Shared utilities for cluster color management and calculations

// Standard cluster color palette used across the application
export const CLUSTER_PALETTE = [
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

// Color for unclustered images
export const UNCLUSTERED_COLOR = "#cccccc";

/**
 * Get the color for a specific cluster based on UMAP points
 * @param {number} cluster - The cluster number (-1 for unclustered)
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {string} - Hex color code for the cluster
 */
export function getClusterColorFromPoints(cluster, umapPoints) {
  if (cluster === -1) {
    return UNCLUSTERED_COLOR;
  }

  if (!umapPoints || umapPoints.length === 0) {
    return UNCLUSTERED_COLOR;
  }

  // Get all unique clusters and find the index of the target cluster
  const uniqueClusters = [...new Set(umapPoints.map((p) => p.cluster))];
  const clusterIdx = uniqueClusters.indexOf(cluster);

  if (clusterIdx === -1) {
    return UNCLUSTERED_COLOR;
  }

  return CLUSTER_PALETTE[clusterIdx % CLUSTER_PALETTE.length];
}

/**
 * Get the size of a cluster based on UMAP points
 * @param {number} cluster - The cluster number
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {number} - Number of points in the cluster
 */
export function getClusterSize(cluster, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return 0;
  }

  return umapPoints.filter((p) => p.cluster === cluster).length;
}

/**
 * Get cluster information for a specific image index
 * @param {number} globalIndex - The global index of the image
 * @param {Array} umapPoints - Array of UMAP points with cluster information
 * @returns {Object|null} - Object with cluster, color, and size, or null if not found
 */
export function getClusterInfoForImage(globalIndex, umapPoints) {
  if (!umapPoints || umapPoints.length === 0) {
    return null;
  }

  const point = umapPoints.find((p) => p.index === globalIndex);
  if (!point) {
    return null;
  }

  const cluster = point.cluster;
  const color = getClusterColorFromPoints(cluster, umapPoints);
  const size = getClusterSize(cluster, umapPoints);

  return { cluster, color, size };
}
