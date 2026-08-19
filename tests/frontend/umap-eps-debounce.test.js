// The Cluster Strength debounce: what reaches set_umap_eps, and when.
//
// An empty field is a deliberate signal here -- it means "go back to a
// derived strength". The trap is that `<input type="number">` also reports an
// empty value for anything it cannot parse *yet*: "0.", "-", "1e". So a pause
// of one second while retyping looked exactly like asking for a derived
// value, and threw the album's tuned number away.
//
// `validity.badInput` is what separates them, and it is the one thing here
// jsdom cannot produce: it sets value to "" for unparseable input but never
// sets badInput (verified -- see the `stubs` helper). The tests below drive it
// with a stub, so they pin THIS MODULE's logic; that badInput is really set by
// a browser for a half-typed number is a platform guarantee, not something
// this suite proves.
//
// See umap-harness.js for why umap.js needs a harness to be importable.

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

const setUmapMediaFilter = jest.fn((v) => {
  mockState.umapMediaFilter = v;
});
const setSearchResults = jest.fn();
// Mutable so a test can put the swiper on a specific image.
const currentSlideIndex = [-1, 0, null];

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

const SAVE_DEBOUNCE_MS = 1000;

const spinner = () => document.getElementById("umapEpsSpinner");

/** Everything POSTed to set_umap_eps, in order. */
let savedEps;

function installEpsFetchMock() {
  savedEps = [];
  global.fetch = (url, options) => {
    const href = String(url);
    if (href.startsWith("set_umap_eps")) {
      savedEps.push(JSON.parse(options.body).eps);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    if (href.startsWith("umap_data/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, eps: 0.35 }) });
  };
}

/** Type into the spinner the way a user does: set the value, fire input. */
function type(value) {
  spinner().value = value;
  spinner().dispatchEvent(new Event("input"));
}

/**
 * Type something the browser cannot parse into a number yet.
 *
 * A real number input reports value "" and sets validity.badInput. jsdom does
 * the first but not the second, so the flag is stubbed for the dispatch.
 */
function typeUnparseable() {
  const el = spinner();
  const real = el.validity;
  Object.defineProperty(el, "validity", { value: { ...real, badInput: true }, configurable: true });
  el.value = "";
  el.dispatchEvent(new Event("input"));
  Object.defineProperty(el, "validity", { value: real, configurable: true });
}

const pastTheDebounce = () => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 150));

describe("Cluster Strength debounce", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    loadUmapDom();
    installPlotlyMock();
    installFetchMock([]);
    await import(`${JS}/umap.js`);
    installEpsFetchMock();
  });

  afterEach(() => {
    removePlotlyMock();
    delete global.fetch;
    document.body.innerHTML = "";
    jest.resetModules();
  });

  it("does not clear the album's strength when the user pauses mid-number", async () => {
    // The bug: "0." sanitizes to "", which is the deliberate-clear signal,
    // so hesitating for a second threw away the tuned value and put the
    // album back on a derived one.
    type("0.4");
    await pastTheDebounce();
    savedEps.length = 0;

    typeUnparseable();
    await pastTheDebounce();

    expect(savedEps).toEqual([]);
  });

  it("still treats a genuinely emptied field as a request to derive one", async () => {
    // The other half: this must keep working, or clearing the field stops
    // being a way back to an automatic strength.
    type("");
    await pastTheDebounce();

    expect(savedEps).toEqual([null]);
  });

  it("saves the number once the user finishes typing it", async () => {
    typeUnparseable();
    type("0.4");
    await pastTheDebounce();

    expect(savedEps).toEqual([0.4]);
  });

  it("does not let a pending save land after the field goes unparseable", async () => {
    // The save armed by "0.4" must not fire a second later: the field no
    // longer shows that number. This is why the timer is cleared before the
    // early return rather than after it.
    type("0.4");
    typeUnparseable();
    await pastTheDebounce();

    expect(savedEps).toEqual([]);
  });

  it("refuses to save a strength DBSCAN cannot use", async () => {
    // A stored 0 or negative leaves the map clustering at the floor while
    // the spinner and the info modal both report the number the user typed.
    type("0");
    await pastTheDebounce();
    type("-2");
    await pastTheDebounce();

    expect(savedEps).toEqual([]);
  });
});
