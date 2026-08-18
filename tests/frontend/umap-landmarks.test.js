// Landmark rendering in umap.js, driven through the real module.
//
// See umap-harness.js for why this needs a harness at all: umap.js wires DOM
// handlers at import time, so the document has to be standing before the
// dynamic import below.
//
// The regression under test: a landmark is two separate things — a triangle
// marker *trace* and a thumbnail in `layout.images`. Deleting the traces does
// not remove the thumbnails, so any path that bails out of drawing landmarks
// must clear the images too. When the media filter hid every point of the only
// cluster in view, the thumbnail was left hovering over empty space.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
  currentLandmarkImages,
  currentLandmarkTrace,
  installFetchMock,
  installPlotlyMock,
  loadUmapDom,
  removePlotlyMock,
} from "./umap-harness.js";

const JS = "../../photomap/frontend/static/javascript";

// One cluster of images and one of videos, far enough apart that both
// landmarks can be brought into view independently.
const POINTS = [
  ...Array.from({ length: 12 }, (_, i) => ({
    x: -20 + i * 0.05,
    y: 1 + i * 0.05,
    index: i,
    cluster: 1,
    media: "image",
  })),
  ...Array.from({ length: 12 }, (_, i) => ({
    x: 6 + i * 0.05,
    y: 2 + i * 0.05,
    index: 100 + i,
    cluster: 0,
    media: "video",
  })),
];

const mockState = {
  album: "test-album",
  dataChanged: true,
  autotaggingEnabled: false,
  umapMediaFilter: "both",
  umapShowLandmarks: true,
  umapShowHoverThumbnails: false,
  umapExitFullscreenOnSelection: true,
  umapClickSelectsCluster: true,
  umapControlsVisible: true,
  umapClickSelectsImage: false,
  searchType: "clear",
  searchResults: [],
};

const setUmapMediaFilter = jest.fn((v) => {
  mockState.umapMediaFilter = v;
});
const setUmapShowLandmarks = jest.fn((v) => {
  mockState.umapShowLandmarks = v;
});

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setUmapMediaFilter,
  setUmapShowLandmarks,
  setUmapClickSelectsCluster: jest.fn(),
  setUmapControlsVisible: jest.fn(),
  setUmapExitFullscreenOnSelection: jest.fn(),
  setUmapShowHoverThumbnails: jest.fn(),
  saveSettingsToLocalStorage: jest.fn(),
}));

jest.unstable_mockModule(`${JS}/album-manager.js`, () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])), setSwiperManager: jest.fn() },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/back-stack.js`, () => ({
  backStack: { markNextAsJump: jest.fn(), popOne: jest.fn(), init: jest.fn(), setNavigator: jest.fn() },
}));
jest.unstable_mockModule(`${JS}/cluster-utils.js`, () => ({
  CLUSTER_PALETTE: ["#ff0000", "#00ff00", "#0000ff"],
  getClusterLabelInfo: jest.fn(() => null),
  getImageLabelInfo: jest.fn(() => null),
  setClusterLabels: jest.fn(),
  trackVocabBuildRequest: jest.fn((p) => p),
}));
jest.unstable_mockModule(`${JS}/search-ui.js`, () => ({ exitSearchMode: jest.fn() }));
jest.unstable_mockModule(`${JS}/search.js`, () => ({
  getImagePath: jest.fn(() => Promise.resolve("/photos/example.jpg")),
  setSearchResults: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/settings.js`, () => ({ switchAlbum: jest.fn() }));
jest.unstable_mockModule(`${JS}/slide-state.js`, () => ({
  slideState: { navigateToIndex: jest.fn(), getCurrentSlide: jest.fn(() => ({ globalIndex: 0 })) },
  getCurrentSlideIndex: jest.fn(() => [-1, 24, null]),
}));
jest.unstable_mockModule(`${JS}/umap-reindex.js`, () => ({
  checkUmapReindexOngoing: jest.fn(),
  initUmapReindexButton: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  // The real debounce implementation, so the 500ms coalescing is genuinely
  // exercised rather than stubbed away.
  // The real debounce implementation, so rapid calls genuinely coalesce — but
  // with the delay capped, because umap.js debounces landmark redraws by 500ms
  // and waiting that out on every assertion would put this file an order of
  // magnitude above the rest of the suite. The coalescing is what matters
  // here; the exact interval is not what these tests are about.
  debounce: (fn, delay) => {
    const wait = Math.min(delay, 10);
    let timer = null;
    return function (...args) {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  },
  getPercentile: (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(((p / 100) * (sorted.length - 1)) | 0)] ?? 0;
  },
  isColorLight: () => false,
  makeDraggable: jest.fn(),
  showToast: jest.fn(),
}));

describe("umap.js landmarks", () => {
  let umap;
  let plotly;

  /** Bring both cluster landmarks into view and redraw them. */
  async function showLandmarksAcross(xRange, yRange) {
    const plotDiv = document.getElementById("umapPlot");
    plotDiv.layout.xaxis.range = xRange;
    plotDiv.layout.yaxis.range = yRange;

    const checkbox = document.getElementById("umapShowLandmarks");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await settle();
  }

  /**
   * Let the landmark debounce fire and the Plotly promise chains settle.
   *
   * Real timers rather than fake ones: umap.js awaits `setTimeout(..., 0)` in
   * a couple of places to yield to the browser, and under fake timers those
   * awaits deadlock unless every advance is interleaved with a microtask
   * drain. A real wait is both simpler and closer to what actually happens —
   * cheap here only because the mocked debounce caps its delay.
   */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  async function selectFilter(value) {
    const radio = document.getElementById(
      { both: "umapMediaFilterBothRadio", images: "umapMediaFilterImagesRadio", videos: "umapMediaFilterVideosRadio" }[
        value
      ]
    );
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    await settle();
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    Object.assign(mockState, {
      umapMediaFilter: "both",
      umapShowLandmarks: true,
      dataChanged: true,
      searchType: "clear",
      searchResults: [],
    });

    loadUmapDom();
    plotly = installPlotlyMock();
    installFetchMock(POINTS);

    umap = await import(`${JS}/umap.js`);
    window.dispatchEvent(new CustomEvent("stateReady"));

    await umap.fetchUmapData();
    await settle();
  });

  afterEach(() => {
    removePlotlyMock();
    delete global.fetch;
    document.body.innerHTML = "";
    jest.resetModules();
  });

  it("plots every point when the filter is Both", () => {
    expect(document.getElementById("umapPlot").data[0].x).toHaveLength(POINTS.length);
  });

  describe("with both cluster landmarks in view", () => {
    beforeEach(async () => {
      await showLandmarksAcross([-40, 30], [-20, 35]);
    });

    it("draws one landmark per cluster", () => {
      expect(currentLandmarkTrace().x).toHaveLength(2);
      expect(currentLandmarkImages()).toHaveLength(2);
    });

    it("drops the video cluster's landmark when showing images only", async () => {
      await selectFilter("images");

      expect(currentLandmarkTrace().x).toHaveLength(1);
      expect(currentLandmarkImages()).toHaveLength(1);
      // The one left is the image cluster, over on the negative side.
      expect(currentLandmarkTrace().x[0]).toBeLessThan(0);
    });

    it("drops the image cluster's landmark when showing videos only", async () => {
      await selectFilter("videos");

      expect(currentLandmarkTrace().x).toHaveLength(1);
      expect(currentLandmarkImages()).toHaveLength(1);
      expect(currentLandmarkTrace().x[0]).toBeGreaterThan(0);
    });

    it("restores both landmarks on the way back to Both", async () => {
      await selectFilter("videos");
      await selectFilter("both");

      expect(currentLandmarkTrace().x).toHaveLength(2);
      expect(currentLandmarkImages()).toHaveLength(2);
    });
  });

  describe("when the filter empties the view", () => {
    beforeEach(async () => {
      // A window around the image cluster only, so the video cluster's
      // landmark is off-screen. Selecting Videos then leaves nothing to draw.
      await showLandmarksAcross([-30, -10], [-5, 10]);
    });

    it("starts with just the image cluster's landmark", () => {
      expect(currentLandmarkTrace().x).toHaveLength(1);
      expect(currentLandmarkImages()).toHaveLength(1);
    });

    it("removes the thumbnail, not just the triangle", async () => {
      // The regression. Deleting the traces left layout.images untouched, so
      // the thumbnail stayed put over a region with no points under it.
      await selectFilter("videos");

      expect(currentLandmarkTrace()).toBeNull();
      expect(currentLandmarkImages()).toHaveLength(0);
    });

    it("clears the thumbnail via a relayout rather than by luck", async () => {
      await selectFilter("videos");

      const cleared = plotly.calls.relayout.filter((u) => Array.isArray(u.images) && u.images.length === 0);
      expect(cleared.length).toBeGreaterThan(0);
    });

    it("brings the landmark back when the filter is widened again", async () => {
      await selectFilter("videos");
      await selectFilter("both");

      expect(currentLandmarkTrace().x).toHaveLength(1);
      expect(currentLandmarkImages()).toHaveLength(1);
    });
  });

  describe("turning landmarks off", () => {
    beforeEach(async () => {
      await showLandmarksAcross([-40, 30], [-20, 35]);
    });

    it("removes both the triangles and the thumbnails", async () => {
      expect(currentLandmarkImages()).toHaveLength(2);

      const checkbox = document.getElementById("umapShowLandmarks");
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event("change"));
      await settle();

      expect(currentLandmarkTrace()).toBeNull();
      expect(currentLandmarkImages()).toHaveLength(0);
    });
  });
});
