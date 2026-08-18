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

// Valid values for the semantic map's media filter.
export const MEDIA_FILTERS = ["both", "images", "videos"];

// Restrict `points` to one media type.
//
// A point with no `media` field counts as an image: /umap_data only started
// reporting it when video support landed, and a cached response from an older
// build should keep behaving exactly as it did.
//
// Anything other than "images"/"videos" — including a persisted value from a
// future build — falls through to showing everything, which is the safe
// failure mode for a filter.
export function filterPointsByMediaType(points, filter) {
  if (!Array.isArray(points)) {
    return [];
  }
  if (filter === "images") {
    return points.filter((p) => (p?.media ?? "image") === "image");
  }
  if (filter === "videos") {
    return points.filter((p) => p?.media === "video");
  }
  return points;
}

// True if any point is a video. Drives whether the filter is offered at all —
// a "videos only" radio on an all-photo album can only produce a blank map.
export function hasVideoPoints(points) {
  return Array.isArray(points) && points.some((p) => p?.media === "video");
}
