// umap-helpers.js
// Small pure helpers extracted from umap.js so they can be unit-tested without
// pulling in the full UMAP module (which has DOM side effects at load time).

// Find which landmark cluster a point falls inside, given the landmark trace's
// coordinates and the half-extent of the clickable square (in plot units).
// Returns the cluster id at the first match, or null if no landmark contains
// the point. Uses `??` (not `||`) so that a cluster id of 0 — a valid cluster
// that is falsy — is not silently coerced to null.
export function findLandmarkClusterAt(point, landmarkXs, landmarkYs, landmarkClusters, halfSizeX, halfSizeY) {
  for (let i = 0; i < landmarkXs.length; i++) {
    if (Math.abs(point.x - landmarkXs[i]) <= halfSizeX && Math.abs(point.y - landmarkYs[i]) <= halfSizeY) {
      return landmarkClusters[i] ?? null;
    }
  }
  return null;
}
