// The "auto" marker beside Cluster Strength.
//
// The number in that spinner now has two possible origins — a value the user
// saved, or one the server derived from the album's coordinates — and the
// badge is the only thing that tells them apart. What matters is that the
// badge can never disagree with the number next to it: it must appear with a
// derived value, stay away from a stored one, and vanish the moment the user
// takes the number over.
//
// See umap-harness.js for why umap.js needs a harness to be importable at all.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { installFetchMock, installPlotlyMock, loadUmapDom, removePlotlyMock } from "./umap-harness.js";

const JS = "../../photomap/frontend/static/javascript";

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

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setUmapMediaFilter: jest.fn(),
  setUmapShowLandmarks: jest.fn(),
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
  getCurrentSlideIndex: jest.fn(() => [-1, 0, null]),
}));
jest.unstable_mockModule(`${JS}/umap-reindex.js`, () => ({
  checkUmapReindexOngoing: jest.fn(),
  initUmapReindexButton: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  debounce: (fn) => fn,
  getPercentile: (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(((p / 100) * (sorted.length - 1)) | 0)] ?? 0;
  },
  isColorLight: () => false,
  makeDraggable: jest.fn(),
  showToast: jest.fn(),
}));

const spinner = () => document.getElementById("umapEpsSpinner");
const badge = () => document.getElementById("umapEpsAutoBadge");

async function boot() {
  loadUmapDom();
  installPlotlyMock();
  installFetchMock([]);
  return import(`${JS}/umap.js`);
}

afterEach(() => {
  removePlotlyMock();
  delete global.fetch;
  document.body.innerHTML = "";
  jest.resetModules();
});

describe("Cluster Strength auto badge", () => {
  let umap;

  beforeEach(async () => {
    jest.clearAllMocks();
    umap = await boot();
  });

  it("shows the derived value and marks it auto", () => {
    umap.applyResolvedEps({ success: true, eps: 0.49, auto: true });

    expect(spinner().value).toBe("0.49");
    expect(badge().hidden).toBe(false);
  });

  it("leaves the badge off for a value the user stored", () => {
    umap.applyResolvedEps({ success: true, eps: 0.2, auto: false });

    expect(spinner().value).toBe("0.2");
    expect(badge().hidden).toBe(true);
  });

  it("clears the badge as soon as the spinner is edited", () => {
    umap.applyResolvedEps({ success: true, eps: 0.49, auto: true });
    expect(badge().hidden).toBe(false);

    spinner().value = "0.3";
    spinner().dispatchEvent(new Event("input"));

    // Immediately, not after the debounced save: from the keystroke on, the
    // number on screen is the user's.
    expect(badge().hidden).toBe(true);
  });

  it("re-marks a derived value after the user's album switch", () => {
    umap.applyResolvedEps({ success: true, eps: 0.2, auto: false });
    umap.applyResolvedEps({ success: true, eps: 0.49, auto: true });

    expect(badge().hidden).toBe(false);
  });

  it("sends null when the field is cleared, and shows what comes back", async () => {
    // The way back to a derived strength. `|| 0.07` here used to turn an
    // empty field into a stored 0.07 — the very number that leaves small
    // albums with no clusters.
    const calls = [];
    global.fetch = (url, options) => {
      calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
      if (String(url).startsWith("get_umap_eps")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, eps: 0.49, auto: true }) });
      }
      if (String(url).startsWith("umap_data/")) {
        // The redraw that follows the save; it needs a points array.
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    };

    umap.applyResolvedEps({ success: true, eps: 0.2, auto: false });
    spinner().value = "";
    spinner().dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Matched on the payload rather than on "the only save": a debounced
    // save from an earlier test's module instance can still land here.
    const cleared = calls.find((c) => c.url.startsWith("set_umap_eps") && c.body.eps === null);
    expect(cleared).toBeDefined();
    expect(spinner().value).toBe("0.49");
    expect(badge().hidden).toBe(false);
  });

  it("accepts a derived value above the old 1.0 ceiling", () => {
    // Small albums legitimately derive past it; the spinner must not silently
    // display something other than what the map clustered with.
    umap.applyResolvedEps({ success: true, eps: 1.19, auto: true });

    expect(spinner().value).toBe("1.19");
    expect(Number(spinner().max)).toBeGreaterThanOrEqual(1.19);
  });
});
