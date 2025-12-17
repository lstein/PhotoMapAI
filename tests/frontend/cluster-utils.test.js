/**
 * @jest-environment jsdom
 */

import {
  CLUSTER_PALETTE,
  UNCLUSTERED_COLOR,
  getClusterColorFromPoints,
  getClusterSize,
  getClusterInfoForImage,
} from '../../photomap/frontend/static/javascript/cluster-utils.js';

describe('cluster-utils.js', () => {
  const mockUmapPoints = [
    { index: 0, cluster: 0, x: 0.1, y: 0.2 },
    { index: 1, cluster: 0, x: 0.3, y: 0.4 },
    { index: 2, cluster: 1, x: 0.5, y: 0.6 },
    { index: 3, cluster: 1, x: 0.7, y: 0.8 },
    { index: 4, cluster: 1, x: 0.9, y: 1.0 },
    { index: 5, cluster: -1, x: 1.1, y: 1.2 },
    { index: 6, cluster: 2, x: 1.3, y: 1.4 },
  ];

  describe('CLUSTER_PALETTE', () => {
    it('should be an array of color hex codes', () => {
      expect(Array.isArray(CLUSTER_PALETTE)).toBe(true);
      expect(CLUSTER_PALETTE.length).toBeGreaterThan(0);
      expect(CLUSTER_PALETTE[0]).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('UNCLUSTERED_COLOR', () => {
    it('should be a hex color code', () => {
      expect(UNCLUSTERED_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('getClusterColorFromPoints', () => {
    it('should return unclustered color for cluster -1', () => {
      const color = getClusterColorFromPoints(-1, mockUmapPoints);
      expect(color).toBe(UNCLUSTERED_COLOR);
    });

    it('should return a color from the palette for valid cluster', () => {
      const color = getClusterColorFromPoints(0, mockUmapPoints);
      expect(CLUSTER_PALETTE).toContain(color);
    });

    it('should return different colors for different clusters', () => {
      const color0 = getClusterColorFromPoints(0, mockUmapPoints);
      const color1 = getClusterColorFromPoints(1, mockUmapPoints);
      expect(color0).not.toBe(color1);
    });

    it('should return unclustered color when umapPoints is null', () => {
      const color = getClusterColorFromPoints(0, null);
      expect(color).toBe(UNCLUSTERED_COLOR);
    });

    it('should return unclustered color when umapPoints is empty', () => {
      const color = getClusterColorFromPoints(0, []);
      expect(color).toBe(UNCLUSTERED_COLOR);
    });

    it('should return unclustered color for non-existent cluster', () => {
      const color = getClusterColorFromPoints(999, mockUmapPoints);
      expect(color).toBe(UNCLUSTERED_COLOR);
    });
  });

  describe('getClusterSize', () => {
    it('should return correct size for cluster with multiple points', () => {
      const size = getClusterSize(1, mockUmapPoints);
      expect(size).toBe(3);
    });

    it('should return correct size for cluster with one point', () => {
      const size = getClusterSize(2, mockUmapPoints);
      expect(size).toBe(1);
    });

    it('should return correct size for unclustered points', () => {
      const size = getClusterSize(-1, mockUmapPoints);
      expect(size).toBe(1);
    });

    it('should return 0 when umapPoints is null', () => {
      const size = getClusterSize(0, null);
      expect(size).toBe(0);
    });

    it('should return 0 when umapPoints is empty', () => {
      const size = getClusterSize(0, []);
      expect(size).toBe(0);
    });

    it('should return 0 for non-existent cluster', () => {
      const size = getClusterSize(999, mockUmapPoints);
      expect(size).toBe(0);
    });
  });

  describe('getClusterInfoForImage', () => {
    it('should return correct cluster info for valid image', () => {
      const info = getClusterInfoForImage(1, mockUmapPoints);
      expect(info).not.toBeNull();
      expect(info.cluster).toBe(0);
      expect(info.size).toBe(2);
      expect(CLUSTER_PALETTE).toContain(info.color);
    });

    it('should return correct info for unclustered image', () => {
      const info = getClusterInfoForImage(5, mockUmapPoints);
      expect(info).not.toBeNull();
      expect(info.cluster).toBe(-1);
      expect(info.size).toBe(1);
      expect(info.color).toBe(UNCLUSTERED_COLOR);
    });

    it('should return null when umapPoints is null', () => {
      const info = getClusterInfoForImage(0, null);
      expect(info).toBeNull();
    });

    it('should return null when umapPoints is empty', () => {
      const info = getClusterInfoForImage(0, []);
      expect(info).toBeNull();
    });

    it('should return null for non-existent image index', () => {
      const info = getClusterInfoForImage(999, mockUmapPoints);
      expect(info).toBeNull();
    });

    it('should return object with cluster, color, and size properties', () => {
      const info = getClusterInfoForImage(2, mockUmapPoints);
      expect(info).toHaveProperty('cluster');
      expect(info).toHaveProperty('color');
      expect(info).toHaveProperty('size');
    });
  });
});
