// The media filter's effect on everything downstream of the plot.
//
// umap-helpers.test.js covers the pure predicate and umap-landmarks.test.js
// covers landmark rendering. What was left untested is the part the filter is
// actually dangerous in: the paths that turn a click into a *selection*. A
// filtered map must never hand a hidden point to the swiper, and the trace must
// survive a colorize/clear cycle — the else-branch of colorizeUmap restores
// trace 0 from scratch on every "clear selection".
//
// See umap-harness.js for why umap.js needs a harness to be importable at all.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { installFetchMock, installPlotlyMock, loadUmapDom, removePlotlyMock } from "./umap-harness.js";

const JS = "../../photomap/frontend/static/javascript";

// One cluster deliberately MIXED — 10 images and 3 videos sitting together.
// This is the shape that breaks: a landmark is placed from the cluster's
// visible members, so it appears under any filter, but resolving what to open
// used to consider every member.
// Indices below 100 are images; 100+ are videos.
const MIXED_POINTS = [
  ...Array.from({ length: 10 }, (_, i) => ({
    x: 1 + i * 0.02,
    y: 1 + i * 0.02,
    index: i,
    cluster: 1,
    media: "image",
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    x: 1.5 + i * 0.02,
    y: 1.5 + i * 0.02,
    index: 100 + i,
    cluster: 1,
    media: "video",
  })),
];

const IMAGE_ONLY_POINTS = Array.from({ length: 12 }, (_, i) => ({
  x: i * 0.05,
  y: 1 + i * 0.05,
  index: i,
  cluster: 1,
  media: "image",
}));

const mockState = {
  album: "test-album",
  dataChanged: true,
  autotaggingEnabled: false,
  umapMediaFilter: "both",
  umapShowLandmarks: false,
  umapShowHoverThumbnails: false,
  umapExitFullscreenOnSelection: false,
  umapClickSelectsCluster: true,
  umapControlsVisible: true,
  umapClickSelectsImage: false,
  searchType: "clear",
  searchResults: [],
};

const setUmapMediaFilter = jest.fn((v) => {
  mockState.umapMediaFilter = v;
});
const setSearchResults = jest.fn();
// Mutable so a test can put the swiper on a specific image.
let currentSlideIndex = [-1, MIXED_POINTS.length, null];

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setUmapMediaFilter,
  setUmapShowLandmarks: jest.fn((v) => {
    mockState.umapShowLandmarks = v;
  }),
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
  setSearchResults,
}));
jest.unstable_mockModule(`${JS}/settings.js`, () => ({ switchAlbum: jest.fn() }));
jest.unstable_mockModule(`${JS}/slide-state.js`, () => ({
  slideState: { navigateToIndex: jest.fn(), getCurrentSlide: jest.fn(() => ({ globalIndex: 0 })) },
  getCurrentSlideIndex: jest.fn(() => currentSlideIndex),
}));
jest.unstable_mockModule(`${JS}/umap-reindex.js`, () => ({
  checkUmapReindexOngoing: jest.fn(),
  initUmapReindexButton: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  // Real debounce, capped so the 500ms landmark coalescing doesn't dominate
  // the suite's runtime.
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

/** Real timers: umap.js awaits setTimeout(…, 0) in places that deadlock under fake ones. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

const plotDiv = () => document.getElementById("umapPlot");
const mainTrace = () => plotDiv().data[0];

function selectFilter(value) {
  const radio = document.getElementById(
    { both: "umapMediaFilterBothRadio", images: "umapMediaFilterImagesRadio", videos: "umapMediaFilterVideosRadio" }[
      value
    ]
  );
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
}

/** Indices handed to setSearchResults by the most recent selection. */
function selectedIndices() {
  const members = setSearchResults.mock.calls.at(-1)[0];
  return members.map((m) => (typeof m === "number" ? m : m.index));
}

async function boot(points) {
  loadUmapDom();
  installPlotlyMock();
  installFetchMock(points);
  const umap = await import(`${JS}/umap.js`);
  window.dispatchEvent(new CustomEvent("stateReady"));
  await umap.fetchUmapData();
  await settle();
  return umap;
}

afterEach(() => {
  removePlotlyMock();
  delete global.fetch;
  document.body.innerHTML = "";
  jest.resetModules();
});

describe("selecting from a filtered map", () => {
  let umap;

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.assign(mockState, {
      umapMediaFilter: "both",
      umapShowLandmarks: false,
      umapClickSelectsCluster: true,
      dataChanged: true,
      searchType: "clear",
      searchResults: [],
    });
    currentSlideIndex = [-1, MIXED_POINTS.length, null];
    umap = await boot(MIXED_POINTS);
  });

  it("plots only the videos once the filter is set to Videos", async () => {
    selectFilter("videos");
    await settle();
    expect(mainTrace().x).toHaveLength(3);
    expect(mainTrace().customdata).toEqual([100, 101, 102]);
  });

  it("keeps images out of a cluster selection made by clicking a point", async () => {
    selectFilter("videos");
    await settle();

    plotDiv().emit("plotly_click", {
      points: [{ x: 1.5, y: 1.5, customdata: 100, pointIndex: 0, data: { name: "All Points" } }],
    });
    await settle();

    expect(setSearchResults).toHaveBeenCalled();
    expect(selectedIndices().every((i) => i >= 100)).toBe(true);
  });

  describe("clicking a landmark", () => {
    beforeEach(async () => {
      // Bring the cluster into view and draw its landmark, then hide the
      // images so the cluster is mixed but only partly drawn.
      plotDiv().layout.xaxis.range = [-5, 8];
      plotDiv().layout.yaxis.range = [-5, 8];
      const checkbox = document.getElementById("umapShowLandmarks");
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change"));
      await settle();

      selectFilter("videos");
      await settle();
    });

    it("still offers a landmark for the partly-hidden cluster", () => {
      const targets = plotDiv().data.find((t) => t.name === "LandmarkClickTargets");
      expect(targets?.x?.length).toBeGreaterThan(0);
    });

    it("selects only drawn points, and does not throw", async () => {
      // The regression: the landmark's click target was resolved from every
      // member of the cluster, so it came back an image. handleClusterClick
      // then built its walk over the visible set with that hidden point as the
      // start and threw on the first distance calculation — which left
      // setSearchResults uncalled, and with it the spinner (only hidden by the
      // searchResultsChanged handler) up for good.
      const targets = plotDiv().data.find((t) => t.name === "LandmarkClickTargets");
      plotDiv().emit("plotly_click", {
        points: [{ x: targets.x[0], y: targets.y[0], data: { name: "LandmarkClickTargets" } }],
      });
      await settle();

      expect(setSearchResults).toHaveBeenCalled();
      expect(selectedIndices()).not.toHaveLength(0);
      expect(selectedIndices().every((i) => i >= 100)).toBe(true);
    });

    it("ignores a server-supplied medoid that the filter is hiding", async () => {
      // getLandmarkImageIndex short-circuits on labelInfo.medoid_index, which
      // the labels endpoint computes over the whole cluster.
      const { getClusterLabelInfo } = await import(`${JS}/cluster-utils.js`);
      getClusterLabelInfo.mockReturnValue({ medoid_index: 3 }); // an image

      const targets = plotDiv().data.find((t) => t.name === "LandmarkClickTargets");
      plotDiv().emit("plotly_click", {
        points: [{ x: targets.x[0], y: targets.y[0], data: { name: "LandmarkClickTargets" } }],
      });
      await settle();

      expect(setSearchResults).toHaveBeenCalled();
      expect(selectedIndices()).not.toContain(3);
      expect(selectedIndices().every((i) => i >= 100)).toBe(true);
    });
  });

  it("hides the current-image marker when the filter hides that slide", async () => {
    currentSlideIndex = [0, MIXED_POINTS.length, null]; // an image
    selectFilter("videos");
    await settle();
    await umap.updateCurrentImageMarker();

    const marker = plotDiv().data.find((t) => t.name === "Current Image");
    expect(marker.x).toEqual([]);
  });

  it("shows the current-image marker when that slide is still drawn", async () => {
    currentSlideIndex = [100, MIXED_POINTS.length, null]; // a video
    selectFilter("videos");
    await settle();
    await umap.updateCurrentImageMarker();

    const marker = plotDiv().data.find((t) => t.name === "Current Image");
    expect(marker.x).toEqual([MIXED_POINTS.find((p) => p.index === 100).x]);
  });

  it("survives a colorize/clear cycle", async () => {
    // colorizeUmap's else-branch rebuilds trace 0 from scratch on every
    // "clear selection", which is the path that would silently restore the
    // hidden points.
    selectFilter("videos");
    await settle();

    await umap.colorizeUmap({ highlight: true, searchResults: [{ index: 100 }] });
    await umap.colorizeUmap({ highlight: false, searchResults: [] });

    expect(mainTrace().x).toHaveLength(3);
    expect(mainTrace().customdata).toEqual([100, 101, 102]);
  });

  it("never highlights a point the filter is hiding", async () => {
    selectFilter("videos");
    await settle();

    await umap.colorizeUmap({ highlight: true, searchResults: [{ index: 3 }, { index: 100 }] });

    const highlighted = plotDiv().data.find((t) => t.name === "HighlightedPoints");
    expect(highlighted.customdata).toEqual([100]);
  });
});

describe("an album with no videos", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    Object.assign(mockState, {
      // What localStorage restores after the user picked Videos elsewhere.
      umapMediaFilter: "videos",
      umapShowLandmarks: false,
      dataChanged: true,
      searchType: "clear",
      searchResults: [],
    });
    currentSlideIndex = [-1, IMAGE_ONLY_POINTS.length, null];
    await boot(IMAGE_ONLY_POINTS);
  });

  it("plots every point rather than an empty map", () => {
    // Reconciling the filter has to happen before the trace is built. Doing it
    // afterwards still looked right, but only because the colorize at the end
    // of fetchUmapData happened to redraw trace 0 from the corrected filter.
    expect(plotDiv().data[0].x).toHaveLength(IMAGE_ONLY_POINTS.length);
  });

  it("plots every point on the very first newPlot", () => {
    const firstPlot = window.Plotly.calls.newPlot[0];
    expect(firstPlot.data[0].x).toHaveLength(IMAGE_ONLY_POINTS.length);
  });

  it("resets the stored filter to both", () => {
    expect(setUmapMediaFilter).toHaveBeenCalledWith("both");
    expect(mockState.umapMediaFilter).toBe("both");
  });

  it("disables the radios and checks Both", () => {
    expect(document.getElementById("umapMediaFilterVideosRadio").disabled).toBe(true);
    expect(document.getElementById("umapMediaFilterImagesRadio").disabled).toBe(true);
    expect(document.getElementById("umapMediaFilterBothRadio").checked).toBe(true);
  });

  it("explains why the control is unavailable", () => {
    expect(document.getElementById("umapMediaFilterContainer").title).toMatch(/no videos/i);
  });
});
