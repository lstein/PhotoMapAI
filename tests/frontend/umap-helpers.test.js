/**
 * @jest-environment jsdom
 */

import {
  MEDIA_FILTERS,
  filterPointsByMediaType,
  findLandmarkClusterAt,
  hasVideoPoints,
} from "../../photomap/frontend/static/javascript/umap-helpers.js";

describe("findLandmarkClusterAt", () => {
  // Three landmarks at distinct positions, deliberately covering cluster ids
  // 0, 1, and 2 so we can pin down the cluster-0 falsy-coercion regression.
  const landmarkXs = [10, 20, 30];
  const landmarkYs = [10, 20, 30];
  const landmarkClusters = [0, 1, 2];
  const halfSizeX = 2;
  const halfSizeY = 2;

  it("returns the matching cluster id when the point is inside a landmark square", () => {
    const result = findLandmarkClusterAt(
      { x: 20, y: 20 },
      landmarkXs,
      landmarkYs,
      landmarkClusters,
      halfSizeX,
      halfSizeY
    );
    expect(result).toBe(1);
  });

  // Regression: previously the production code used `landmarkClusters[i] || null`,
  // which coerced cluster id 0 to null. That made hover/click for Cluster 0's
  // landmark fall through to the "regular point" branch and pop up info for
  // Image 0 instead of the cluster medoid.
  it("returns 0 (not null) when the matching landmark is Cluster 0", () => {
    const result = findLandmarkClusterAt(
      { x: 10, y: 10 },
      landmarkXs,
      landmarkYs,
      landmarkClusters,
      halfSizeX,
      halfSizeY
    );
    expect(result).toBe(0);
    expect(result).not.toBeNull();
  });

  it("returns null when no landmark contains the point", () => {
    const result = findLandmarkClusterAt(
      { x: 100, y: 100 },
      landmarkXs,
      landmarkYs,
      landmarkClusters,
      halfSizeX,
      halfSizeY
    );
    expect(result).toBeNull();
  });

  it("returns the first match when a point falls inside multiple landmark squares", () => {
    // Overlapping landmarks at the same coordinates; first one wins, matching
    // the existing loop semantics.
    const xs = [10, 10];
    const ys = [10, 10];
    const clusters = [0, 5];
    const result = findLandmarkClusterAt({ x: 10, y: 10 }, xs, ys, clusters, 2, 2);
    expect(result).toBe(0);
  });

  it("returns null when customdata is missing for a matched landmark", () => {
    const result = findLandmarkClusterAt({ x: 10, y: 10 }, landmarkXs, landmarkYs, [], halfSizeX, halfSizeY);
    expect(result).toBeNull();
  });
});

describe("filterPointsByMediaType", () => {
  const IMAGE = { index: 0, media: "image" };
  const VIDEO = { index: 1, media: "video" };
  const LEGACY = { index: 2 }; // no media field
  const points = [IMAGE, VIDEO, LEGACY];

  it("returns everything for 'both'", () => {
    expect(filterPointsByMediaType(points, "both")).toEqual(points);
  });

  it("keeps only images for 'images'", () => {
    expect(filterPointsByMediaType(points, "images")).toEqual([IMAGE, LEGACY]);
  });

  it("keeps only videos for 'videos'", () => {
    expect(filterPointsByMediaType(points, "videos")).toEqual([VIDEO]);
  });

  it("treats a point with no media field as an image", () => {
    // /umap_data only started reporting `media` when video support landed; a
    // response cached from an older build must behave exactly as before.
    expect(filterPointsByMediaType([LEGACY], "images")).toEqual([LEGACY]);
    expect(filterPointsByMediaType([LEGACY], "videos")).toEqual([]);
  });

  it("shows everything for an unrecognized filter", () => {
    // The safe failure mode for a filter — e.g. a value persisted by a newer
    // build than the one now running.
    expect(filterPointsByMediaType(points, "sideways")).toEqual(points);
    expect(filterPointsByMediaType(points, undefined)).toEqual(points);
  });

  it("returns an empty array for a missing point list", () => {
    expect(filterPointsByMediaType(undefined, "both")).toEqual([]);
    expect(filterPointsByMediaType(null, "videos")).toEqual([]);
    expect(filterPointsByMediaType([], "images")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const original = [...points];
    filterPointsByMediaType(points, "videos");
    expect(points).toEqual(original);
  });

  it("is one of the documented filter values", () => {
    expect(MEDIA_FILTERS).toEqual(["both", "images", "videos"]);
  });
});

describe("hasVideoPoints", () => {
  it("detects a video among the points", () => {
    expect(hasVideoPoints([{ media: "image" }, { media: "video" }])).toBe(true);
  });

  it("reports false for an all-image album", () => {
    // Drives disabling the filter: a "videos only" radio on an all-photo
    // album can only ever produce a blank map.
    expect(hasVideoPoints([{ media: "image" }, {}])).toBe(false);
  });

  it("reports false for empty or missing input", () => {
    expect(hasVideoPoints([])).toBe(false);
    expect(hasVideoPoints(undefined)).toBe(false);
  });
});
