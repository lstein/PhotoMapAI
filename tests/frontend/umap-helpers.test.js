/**
 * @jest-environment jsdom
 */

import { findLandmarkClusterAt } from "../../photomap/frontend/static/javascript/umap-helpers.js";

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
