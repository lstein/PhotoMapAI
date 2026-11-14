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
  currentLandmarkAnnotations,
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
  mediaFilter: "both",
  umapLandmarkStyle: "thumbnails",
  umapShowHoverThumbnails: false,
  umapExitFullscreenOnSelection: true,
  umapClickSelectsCluster: true,
  umapControlsVisible: true,
  umapClickSelectsImage: false,
  searchType: "clear",
  searchResults: [],
};

// Mirrors the real setter (state.js `_makeSetter` + the mediaFilter spec's
// onSet): no-op when unchanged, otherwise assign and announce. umap.js redraws
// off that event, so a mock that only assigned would leave the filter changing
// nothing.
const setMediaFilter = jest.fn((v) => {
  if (mockState.mediaFilter === v) {
    return;
  }
  mockState.mediaFilter = v;
  window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: v } }));
});
const setUmapLandmarkStyle = jest.fn((v) => {
  mockState.umapLandmarkStyle = v;
});

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setMediaFilter,
  setUmapLandmarkStyle,
  setUmapClickSelectsCluster: jest.fn(),
  setUmapControlsVisible: jest.fn(),
  setUmapExitFullscreenOnSelection: jest.fn(),
  setUmapShowHoverThumbnails: jest.fn(),
  persistSettings: jest.fn(),
  persistSlidePosition: jest.fn(),
}));

jest.unstable_mockModule(`${JS}/album-manager.js`, () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])), setSwiperManager: jest.fn() },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/back-stack.js`, () => ({
  backStack: { markNextAsJump: jest.fn(), popOne: jest.fn(), init: jest.fn(), setNavigator: jest.fn() },
}));
// Cluster id -> what /cluster_labels would have said about it. Empty by
// default, so labels fall back to "Cluster N"; individual tests fill it in.
const clusterLabels = {};
jest.unstable_mockModule(`${JS}/cluster-utils.js`, () => ({
  CLUSTER_PALETTE: ["#ff0000", "#00ff00", "#0000ff"],
  getClusterLabelInfo: jest.fn((c) => clusterLabels[c] ?? null),
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
  async function showLandmarksAcross(xRange, yRange, style = "thumbnails") {
    const plotDiv = document.getElementById("umapPlot");
    plotDiv.layout.xaxis.range = xRange;
    plotDiv.layout.yaxis.range = yRange;

    await chooseStyle(style);
  }

  /** Pick a landmark style from the pulldown, as the user would. */
  async function chooseStyle(style) {
    const select = document.getElementById("umapLandmarkStyle");
    select.value = style;
    select.dispatchEvent(new Event("change"));
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
    setMediaFilter(value);
    await settle();
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    Object.assign(mockState, {
      mediaFilter: "both",
      umapLandmarkStyle: "thumbnails",
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

      await chooseStyle("none");

      expect(currentLandmarkTrace()).toBeNull();
      expect(currentLandmarkImages()).toHaveLength(0);
    });
  });

  describe("tiles", () => {
    beforeEach(async () => {
      for (const key of Object.keys(clusterLabels)) {
        delete clusterLabels[key];
      }
      await showLandmarksAcross([-40, 30], [-20, 35], "tiles");
    });

    it("fills each cluster's label with its colour, with no thumbnails or triangles", () => {
      const labels = currentLandmarkAnnotations();
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        // Filled with the cluster colour (the mocked palette), text in a
        // contrasting black or white (isColorLight is mocked dark -> white).
        expect(["#ff0000", "#00ff00", "#0000ff"]).toContain(label.bgcolor);
        expect(label.font.color).toBe("#fff");
        expect(label.captureevents).toBe(true);
      }
      expect(currentLandmarkImages()).toHaveLength(0);
      expect(currentLandmarkTrace()).toBeNull();
    });

    it("falls back to the cluster number without autotag labels", () => {
      const texts = currentLandmarkAnnotations().map((a) => a.text);
      expect(texts).toEqual(expect.arrayContaining(["<b>Cluster 0</b>", "<b>Cluster 1</b>"]));
    });

    it("uses the cluster's autotag phrase once the labels arrive, escaped", async () => {
      clusterLabels[1] = { label: "cats & <dogs>", alternates: [] };
      window.dispatchEvent(new CustomEvent("clusterLabelsUpdated", { detail: { count: 1 } }));
      await settle();

      const texts = currentLandmarkAnnotations().map((a) => a.text);
      expect(texts).toContain("<b>cats &amp; &lt;dogs&gt;</b>");
    });

    it("follows the media filter like thumbnails do", async () => {
      await selectFilter("videos");

      const labels = currentLandmarkAnnotations();
      expect(labels).toHaveLength(1);
      expect(labels[0].x).toBeGreaterThan(0);
    });

    it("removes the labels when the filter empties the view", async () => {
      const plotDiv = document.getElementById("umapPlot");
      plotDiv.layout.xaxis.range = [-30, -10];
      plotDiv.layout.yaxis.range = [-5, 10];
      await chooseStyle("tiles");
      expect(currentLandmarkAnnotations()).toHaveLength(1);

      await selectFilter("videos");

      expect(currentLandmarkAnnotations()).toHaveLength(0);
    });

    it("swaps cleanly to thumbnails and back", async () => {
      await chooseStyle("thumbnails");
      expect(currentLandmarkAnnotations()).toHaveLength(0);
      expect(currentLandmarkImages()).toHaveLength(2);

      await chooseStyle("tiles");
      expect(currentLandmarkAnnotations()).toHaveLength(2);
      expect(currentLandmarkImages()).toHaveLength(0);
      expect(currentLandmarkTrace()).toBeNull();
    });

    it("clears the labels when landmarks are turned off", async () => {
      await chooseStyle("none");

      expect(currentLandmarkAnnotations()).toHaveLength(0);
      expect(currentLandmarkImages()).toHaveLength(0);
    });

    it("redraws the labels after the map is re-plotted", async () => {
      // newPlot wipes layout.annotations; the same labels must come back
      // rather than being skipped as unchanged.
      mockState.dataChanged = true;
      await umap.fetchUmapData();
      await settle();
      const plotDiv = document.getElementById("umapPlot");
      plotDiv.layout.xaxis.range = [-40, 30];
      plotDiv.layout.yaxis.range = [-20, 35];
      plotDiv.emit("plotly_relayout", { "xaxis.range[0]": -40 });
      await settle();

      expect(currentLandmarkAnnotations()).toHaveLength(2);
    });

    it("persists the chosen style", () => {
      expect(setUmapLandmarkStyle).toHaveBeenLastCalledWith("tiles");
    });

    it("navigates to the cluster's representative when a label is clicked", async () => {
      const { slideState } = await import(`${JS}/slide-state.js`);
      mockState.umapClickSelectsCluster = false;
      const plotDiv = document.getElementById("umapPlot");
      const labels = currentLandmarkAnnotations();
      const videoLabel = labels.findIndex((a) => a.x > 0);

      plotDiv.emit("plotly_clickannotation", { index: videoLabel });
      await settle();

      const target = slideState.navigateToIndex.mock.calls.at(-1)?.[0];
      expect(target).toBeGreaterThanOrEqual(100);
      mockState.umapClickSelectsCluster = true;
    });
  });
  describe("text labels", () => {
    beforeEach(async () => {
      for (const key of Object.keys(clusterLabels)) {
        delete clusterLabels[key];
      }
      await showLandmarksAcross([-40, 30], [-20, 35], "text");
    });

    it("draws bare text in the cluster's colour, with no box", () => {
      const labels = currentLandmarkAnnotations();
      expect(labels).toHaveLength(2);
      for (const label of labels) {
        expect(["#ff0000", "#00ff00", "#0000ff"]).toContain(label.font.color);
        expect(label.bgcolor).toBe("rgba(0, 0, 0, 0)");
        expect(label.borderwidth).toBe(0);
        // A dark halo stands in for the box, for legibility over the dots.
        expect(label.font.shadow).toBeTruthy();
        expect(label.captureevents).toBe(true);
      }
      expect(currentLandmarkImages()).toHaveLength(0);
      expect(currentLandmarkTrace()).toBeNull();
    });

    it("restyles in place when switching to tiles and back", async () => {
      await chooseStyle("tiles");
      let labels = currentLandmarkAnnotations();
      expect(labels).toHaveLength(2);
      expect(labels.every((a) => a.bgcolor !== "rgba(0, 0, 0, 0)")).toBe(true);

      await chooseStyle("text");
      labels = currentLandmarkAnnotations();
      expect(labels).toHaveLength(2);
      expect(labels.every((a) => a.bgcolor === "rgba(0, 0, 0, 0)")).toBe(true);
    });

    it("clears the labels when landmarks are turned off", async () => {
      await chooseStyle("none");

      expect(currentLandmarkAnnotations()).toHaveLength(0);
    });

    it("persists the chosen style", () => {
      expect(setUmapLandmarkStyle).toHaveBeenLastCalledWith("text");
    });

    it("navigates to the cluster's representative when a label is clicked", async () => {
      const { slideState } = await import(`${JS}/slide-state.js`);
      mockState.umapClickSelectsCluster = false;
      const plotDiv = document.getElementById("umapPlot");
      const imageLabel = currentLandmarkAnnotations().findIndex((a) => a.x < 0);

      plotDiv.emit("plotly_clickannotation", { index: imageLabel });
      await settle();

      const target = slideState.navigateToIndex.mock.calls.at(-1)?.[0];
      expect(target).toBeLessThan(100);
      mockState.umapClickSelectsCluster = true;
    });
  });
});
