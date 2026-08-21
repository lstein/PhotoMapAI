// What the semantic map does when the album it is showing finishes indexing.
//
// The listener re-resolves the Cluster Strength before redrawing, because new
// coordinates invalidate a derived one and the redraw sends whatever the
// spinner holds. That resolve is a round trip which, on a large album, means
// deriving from scratch — so everything checked before it has to be checked
// again after it. These tests are each one thing that can move in that window.
//
// Separate file, and the module is imported exactly ONCE: umap.js registers
// window listeners at module scope and nothing unregisters them, so a
// per-test re-import would leave several live listeners all reacting to one
// dispatched event and racing each other through the shared spinner.

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";

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
const mapWindow = () => document.getElementById("umapFloatingWindow");

// Let the async listener settle: it awaits a fetch before redrawing, so a
// bare dispatch returns long before any of it has happened.
const flushAsync = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const reindexed = (albumKey) => window.dispatchEvent(new CustomEvent("albumIndexUpdated", { detail: { albumKey } }));

/**
 * Type something the browser cannot parse into a number yet ("0.", "-").
 *
 * A real number input reports value "" and sets validity.badInput; jsdom does
 * the first but not the second, so the flag is stubbed for the dispatch. See
 * umap-eps-debounce.test.js for what that stub does and does not prove.
 */
function typeUnparseable() {
  const el = spinner();
  const real = el.validity;
  Object.defineProperty(el, "validity", { value: { ...real, badInput: true }, configurable: true });
  el.value = "";
  el.dispatchEvent(new Event("input"));
  Object.defineProperty(el, "validity", { value: real, configurable: true });
}

// A fetch mock whose get_umap_eps reply is held open until released, so a
// test can act inside the window the real resolve leaves open.
function deferredEpsFetch(eps) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("get_umap_eps")) {
      await held;
      return { ok: true, json: () => Promise.resolve({ success: true, eps, auto: true }) };
    }
    return { ok: true, json: () => Promise.resolve([]) };
  };
  return { calls, release: () => release() };
}

function immediateFetch({ eps = 0.49, epsFails = false } = {}) {
  const calls = [];
  global.fetch = (url) => {
    calls.push(String(url));
    if (String(url).startsWith("get_umap_eps")) {
      return epsFails
        ? Promise.reject(new Error("connection lost"))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, eps, auto: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  };
  return calls;
}

const drewMap = (calls) => calls.some((u) => u.startsWith("umap_data/"));

let umap;

beforeAll(async () => {
  loadUmapDom();
  installPlotlyMock();
  installFetchMock([]);
  umap = await import(`${JS}/umap.js`);
});

afterAll(() => {
  removePlotlyMock();
  delete global.fetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.album = "test-album";
  mockState.dataChanged = true;
  mapWindow().style.display = "block";
  // The map is showing a derived strength for an album that had none.
  umap.applyResolvedEps({ success: true, eps: 0.2, auto: true });
});

describe("albumIndexUpdated on the album being shown", () => {
  it("re-resolves the strength and redraws with it", async () => {
    const calls = immediateFetch({ eps: 0.49 });

    reindexed("test-album");
    await flushAsync();

    expect(calls.some((u) => u.startsWith("get_umap_eps"))).toBe(true);
    expect(spinner().value).toBe("0.49");
    expect(badge().hidden).toBe(false);
    // The redraw must carry the freshly resolved number, not the stale one.
    expect(calls.find((u) => u.startsWith("umap_data/"))).toContain("cluster_eps=0.49");
  });

  it("ignores a re-index of some other album", async () => {
    const calls = immediateFetch();

    reindexed("some-other-album");
    await flushAsync();

    expect(calls).toEqual([]);
    expect(spinner().value).toBe("0.2");
  });

  it("redraws with the previous strength, loudly, when resolving fails", async () => {
    const calls = immediateFetch({ epsFails: true });
    jest.spyOn(console, "warn").mockImplementation(() => {});

    reindexed("test-album");
    await flushAsync();

    // The coordinates really did change, so a stale-eps redraw still beats
    // leaving the old plot up — but it must not pass silently.
    expect(drewMap(calls)).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it("leaves the spinner alone while an edit is pending", async () => {
    const calls = immediateFetch({ eps: 0.49 });

    // The user types a strength; the debounced save is now pending.
    spinner().value = "0.55";
    spinner().dispatchEvent(new Event("input"));
    reindexed("test-album");
    await flushAsync();

    // Overwriting here would move the number under the cursor and re-show
    // "auto" for a value that is about to become the user's own.
    expect(spinner().value).toBe("0.55");
    expect(badge().hidden).toBe(true);
    expect(calls.some((u) => u.startsWith("get_umap_eps"))).toBe(false);
  });

  it("resumes re-resolving once the pending edit has been saved", async () => {
    // The pending-edit guard keys off the debounce handle, so it has to be
    // cleared when the timer fires — otherwise one edit disables the
    // re-resolve for the rest of the session.
    global.fetch = (url) =>
      Promise.resolve(
        String(url).startsWith("get_umap_eps")
          ? { ok: true, json: () => Promise.resolve({ success: true, eps: 0.49, auto: true }) }
          : { ok: true, json: () => Promise.resolve([]) }
      );
    spinner().value = "0.55";
    spinner().dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const calls = immediateFetch({ eps: 0.49 });
    reindexed("test-album");
    await flushAsync();

    expect(calls.some((u) => u.startsWith("get_umap_eps"))).toBe(true);
  });

  it("leaves the spinner alone while the user is mid-number", async () => {
    // Half-typed text arms no save at all — that is the whole point of the
    // badInput guard — so the debounce handle cannot stand in for "an edit is
    // pending" here. This is the state with the most to lose: overwriting it
    // moves the number under the cursor while the user is still typing it.
    const calls = immediateFetch({ eps: 0.49 });
    typeUnparseable();

    reindexed("test-album");
    await flushAsync();

    expect(calls.some((u) => u.startsWith("get_umap_eps"))).toBe(false);
    expect(spinner().value).toBe("");
    spinner().dispatchEvent(new Event("blur"));
  });

  it("resumes re-resolving once an abandoned edit is left behind", async () => {
    // The other side of the same flag: text that never becomes a number
    // never reaches a save that could clear it, so without blur one "0."
    // would disable every re-resolve for the rest of the session.
    typeUnparseable();
    spinner().dispatchEvent(new Event("blur"));

    const calls = immediateFetch({ eps: 0.49 });
    reindexed("test-album");
    await flushAsync();

    expect(calls.some((u) => u.startsWith("get_umap_eps"))).toBe(true);
    expect(spinner().value).toBe("0.49");
  });
});

describe("while the post-re-index resolve is in flight", () => {
  it("does not write album A's strength into album B's spinner", async () => {
    const { calls, release } = deferredEpsFetch(0.49);

    reindexed("test-album");
    await flushAsync();
    // The user switches albums while the derive runs. setAlbum() assigns
    // state.album synchronously, so this is what the listener sees on wake.
    mockState.album = "other-album";
    release();
    await flushAsync();

    expect(spinner().value).toBe("0.2");
    expect(drewMap(calls)).toBe(false);
  });

  it("does not redraw into a window the user has since closed", async () => {
    const { calls, release } = deferredEpsFetch(0.49);

    reindexed("test-album");
    await flushAsync();
    mapWindow().style.display = "none";
    release();
    await flushAsync();

    expect(drewMap(calls)).toBe(false);
    // The flag survives for the next open, which re-resolves on its own.
    expect(mockState.dataChanged).toBe(true);
  });

  it("still redraws when another fetch cleared dataChanged mid-flight", async () => {
    const { calls, release } = deferredEpsFetch(0.49);

    reindexed("test-album");
    await flushAsync();
    // Any redraw finishing inside the window clears the flag; that must not
    // swallow the one redraw this listener exists to guarantee.
    mockState.dataChanged = false;
    release();
    await flushAsync();

    expect(drewMap(calls)).toBe(true);
  });
});
