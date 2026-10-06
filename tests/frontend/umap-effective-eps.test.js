// The Cluster Strength the map was *drawn* with, as opposed to the one the
// spinner holds (#380, #381).
//
// The server shrinks any strength an album cannot afford within its memory
// budget, typed or derived, and that ceiling depends on the point cloud — the
// client cannot predict it. /umap_data now reports the eps it clustered with,
// and the UI must show that rather than the request wherever it claims to
// describe the map.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { installFetchMock, installPlotlyMock, loadUmapDom, removePlotlyMock } from "./umap-harness.js";

const JS = "../../photomap/frontend/static/javascript";

// Two clusters plus one unclustered point; the layout is irrelevant here.
const POINTS = [
  ...Array.from({ length: 12 }, (_, i) => ({ x: i * 0.05, y: i * 0.05, index: i, cluster: 0, media: "image" })),
  ...Array.from({ length: 12 }, (_, i) => ({ x: 6 + i * 0.05, y: 2, index: 100 + i, cluster: 1, media: "image" })),
  { x: 20, y: 20, index: 500, cluster: -1, media: "image" },
];

const mockState = {
  album: "test-album",
  dataChanged: true,
  autotaggingEnabled: false,
  mediaFilter: "both",
  umapShowLandmarks: true,
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
// off that event, so a mock that only assigned would leave the radios changing
// nothing.
const setMediaFilter = jest.fn((v) => {
  if (mockState.mediaFilter === v) {
    return;
  }
  mockState.mediaFilter = v;
  window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: v } }));
});
const setUmapShowLandmarks = jest.fn((v) => {
  mockState.umapShowLandmarks = v;
});

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setMediaFilter,
  setUmapShowLandmarks,
  setUmapClickSelectsCluster: jest.fn(),
  setUmapControlsVisible: jest.fn(),
  setUmapExitFullscreenOnSelection: jest.fn(),
  setUmapShowHoverThumbnails: jest.fn(),
  persistSettings: jest.fn(),
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

describe("umap.js reports the strength the map was drawn with", () => {
  let umap;

  const note = () => document.getElementById("umapEpsEffective");
  const spinner = () => document.getElementById("umapEpsSpinner");
  const modalEps = () => {
    document.getElementById("umapClusterInfoBtn").click();
    return document.getElementById("umapInfoEps").textContent;
  };

  async function draw(meta) {
    installFetchMock(POINTS, meta);
    mockState.dataChanged = true;
    await umap.fetchUmapData();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.assign(mockState, { mediaFilter: "both", umapShowLandmarks: false, dataChanged: true });
    loadUmapDom();
    installPlotlyMock();
    installFetchMock(POINTS);
    umap = await import(`${JS}/umap.js`);
    window.dispatchEvent(new CustomEvent("stateReady"));
  });

  afterEach(() => {
    removePlotlyMock();
    jest.resetModules();
  });

  it("shows nothing extra when the map was clustered at the requested strength", async () => {
    spinner().value = "0.5";
    await draw({ eps: 0.5, requestedEps: 0.5 });

    expect(note().hidden).toBe(true);
    expect(modalEps()).toBe("0.5");
  });

  it("names the strength actually used when the server shrank the request", async () => {
    spinner().value = "2";
    await draw({ eps: 1.4, requestedEps: 2 });

    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain("1.4");
    expect(note().title).toContain("2");
    // The spinner keeps the request: it is what the album stores and what the
    // next fetch asks for.
    expect(spinner().value).toBe("2");
    expect(modalEps()).toBe("1.4");
  });

  it("clears the note once a redraw is no longer shrunk", async () => {
    await draw({ eps: 1.4, requestedEps: 2 });
    await draw({ eps: 0.8, requestedEps: 0.8 });

    expect(note().hidden).toBe(true);
    expect(note().textContent).toBe("");
  });

  it("does not report a derived strength as shrunk", async () => {
    await draw({ eps: 0.12, requestedEps: null });

    expect(note().hidden).toBe(true);
    expect(modalEps()).toBe("0.12");
  });

  it("prints a strength shrunk below 0.005 as a number in the modal", async () => {
    await draw({ eps: 0.00412, requestedEps: 0.05 });

    expect(modalEps()).toBe("0.0041");
    expect(note().textContent).toContain("0.0041");
  });

  it("has the modal describe the drawn map, not an unsaved or half-typed edit", async () => {
    spinner().value = "0.4";
    await draw({ eps: 0.4, requestedEps: 0.4 });

    // Mid-debounce, a refused value, and text the browser cannot parse.
    for (const typed of ["0.9", "0.005", ""]) {
      spinner().value = typed;
      expect(modalEps()).toBe("0.4");
    }
  });

  it("keeps describing the old map when a redraw fails", async () => {
    await draw({ eps: 0.4, requestedEps: 0.4 });
    global.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    mockState.dataChanged = true;
    await expect(umap.fetchUmapData()).rejects.toThrow("umap_data 500");

    expect(modalEps()).toBe("0.4");
  });
});
