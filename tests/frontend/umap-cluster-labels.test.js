// /cluster_labels fetching: which request is issued, which response is kept.
//
// Cluster IDs are a function of the strength the album was clustered at, so a
// labels response only means anything alongside a map drawn at that same
// strength. Everything here is about keeping those two in agreement while
// requests are in flight — a labels build is tens of seconds of CPU on a cold
// cache, so "in flight" is a state the app spends real time in.
//
// See umap-harness.js for why umap.js needs a harness to be importable at all.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import { installPlotlyMock, loadUmapDom, removePlotlyMock } from "./umap-harness.js";

const JS = "../../photomap/frontend/static/javascript";

const mockState = {
  album: "test-album",
  dataChanged: true,
  autotaggingEnabled: true,
  mediaFilter: "both",
  umapShowLandmarks: false,
  umapShowHoverThumbnails: false,
  umapExitFullscreenOnSelection: false,
  umapClickSelectsCluster: true,
  umapControlsVisible: true,
  searchType: "clear",
  searchResults: [],
};

const mockSetClusterLabels = jest.fn();

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setMediaFilter: jest.fn(),
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
  setClusterLabels: mockSetClusterLabels,
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

const POINTS = [
  { index: 0, cluster: 0, x: 0.1, y: 0.2 },
  { index: 1, cluster: 1, x: 0.3, y: 0.4 },
];

const spinner = () => document.getElementById("umapEpsSpinner");

let requested = [];
let pendingLabels = [];

/** A labels request that hasn't answered yet — the state that matters here. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function answerLabels(pending, labels) {
  pending.resolve({ ok: true, json: () => Promise.resolve({ labels }) });
  return new Promise((r) => setTimeout(r, 0));
}

function installFetchMock() {
  global.fetch = (url) => {
    const target = String(url);
    requested.push(target);
    if (target.startsWith("umap_data/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(POINTS) });
    }
    if (target.startsWith("cluster_labels/")) {
      const d = deferred();
      pendingLabels.push({ url: target, ...d });
      return d.promise;
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };
}

const labelRequests = () => requested.filter((u) => u.startsWith("cluster_labels/"));

async function boot() {
  loadUmapDom();
  installPlotlyMock();
  installFetchMock();
  return import(`${JS}/umap.js`);
}

/** Redraw the map at `eps`, as the strength spinner's save path does. */
async function redrawAt(umap, eps) {
  spinner().value = String(eps);
  mockState.dataChanged = true;
  await umap.fetchUmapData();
}

beforeEach(() => {
  requested = [];
  pendingLabels = [];
  mockSetClusterLabels.mockClear();
  mockState.album = "test-album";
  mockState.dataChanged = true;
  mockState.autotaggingEnabled = true;
});

afterEach(() => {
  removePlotlyMock();
  delete global.fetch;
  document.body.innerHTML = "";
  jest.resetModules();
});

describe("cluster labels follow the map they belong to", () => {
  it("does not answer a redraw at a new strength with the request still in flight for the old one", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);
    expect(labelRequests()).toEqual(["cluster_labels/test-album?cluster_eps=0.6"]);

    // The 0.6 build is slow; the user moves the spinner on before it answers.
    await redrawAt(umap, 0.9);
    expect(labelRequests()).toEqual([
      "cluster_labels/test-album?cluster_eps=0.6",
      "cluster_labels/test-album?cluster_eps=0.9",
    ]);

    // The superseded build finally answers. Its phrases describe clusters the
    // map is no longer drawing, so nothing may install them.
    await answerLabels(pendingLabels[0], { 1: { label: "stale" } });
    expect(mockSetClusterLabels).not.toHaveBeenCalledWith({ 1: { label: "stale" } });

    await answerLabels(pendingLabels[1], { 1: { label: "current" } });
    expect(mockSetClusterLabels).toHaveBeenCalledWith({ 1: { label: "current" } });
  });

  it("collapses concurrent fetches for the same strength into one request", async () => {
    const umap = await boot();
    spinner().value = "0.6";
    mockState.dataChanged = true;
    const first = umap.fetchUmapData();
    mockState.dataChanged = true;
    const second = umap.fetchUmapData();
    await Promise.all([first, second]);

    expect(labelRequests()).toEqual(["cluster_labels/test-album?cluster_eps=0.6"]);
  });

  it("does not hold the map up for a labels build that hasn't answered", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);

    // fetchUmapData has resolved with the labels request still outstanding.
    expect(pendingLabels).toHaveLength(1);
    expect(window.umapPoints).toHaveLength(POINTS.length);
    expect(mockState.dataChanged).toBe(false);
  });
});

describe("labels never outlive the map they describe", () => {
  it("drops the installed labels while the new album's are still being built", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);
    await answerLabels(pendingLabels[0], { 3: { label: "beach sunset", medoid_index: 412 } });
    mockSetClusterLabels.mockClear();

    // Switch albums. The map is no longer held up for its labels, so the new
    // map is on screen long before they arrive — with nothing to name its
    // clusters but the previous album's phrases, unless they are dropped.
    mockState.album = "other-album";
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { changeType: "album" } }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetClusterLabels).toHaveBeenCalledWith({});
  });

  it("clears them again for a redraw at a new strength", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);
    await answerLabels(pendingLabels[0], { 3: { label: "beach sunset" } });
    mockSetClusterLabels.mockClear();

    await redrawAt(umap, 0.9);

    // Cluster 3 at 0.9 is a different set of images than cluster 3 at 0.6.
    expect(mockSetClusterLabels).toHaveBeenCalledWith({});
  });

  it("does not answer a post-reindex map with the request issued before it", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);
    expect(labelRequests()).toHaveLength(1);

    // The album is re-indexed while that build runs. The strength is stored,
    // so the query string for the redraw is byte-identical — but the clusters
    // underneath it are not.
    window.dispatchEvent(new CustomEvent("albumIndexUpdated", { detail: { albumKey: "test-album" } }));
    await new Promise((r) => setTimeout(r, 0));
    mockState.dataChanged = true;
    await umap.fetchUmapData();

    expect(labelRequests()).toHaveLength(2);
    await answerLabels(pendingLabels[0], { 3: { label: "pre-reindex" } });
    expect(mockSetClusterLabels).not.toHaveBeenCalledWith({ 3: { label: "pre-reindex" } });
  });
});

describe("turning autotagging on after the map is drawn", () => {
  it("asks for the strength the map was drawn at, not whatever the spinner now reads", async () => {
    mockState.autotaggingEnabled = false;
    const umap = await boot();
    await redrawAt(umap, 0.42);
    expect(labelRequests()).toEqual([]); // the setting was off

    // Strengths unique to this test: every umap.js imported earlier in this
    // file still has its own listener on this jsdom window, and they answer
    // the dispatch below too. Their requests carry their own strengths, so
    // matching on these two numbers keeps the assertion about this module.
    requested = [];
    spinner().value = "0.77";
    mockState.autotaggingEnabled = true;
    window.dispatchEvent(new CustomEvent("autotaggingChanged", { detail: { enabled: true } }));
    await Promise.resolve();

    // The map on screen is still the 0.42 one; a strength typed into the field
    // since then belongs to a map that has not been drawn.
    expect(labelRequests()).toContain("cluster_labels/test-album?cluster_eps=0.42");
    expect(labelRequests()).not.toContain("cluster_labels/test-album?cluster_eps=0.77");
  });

  it("fetches nothing before the first map fetch, which settles the strength itself", async () => {
    mockState.autotaggingEnabled = false;
    await boot();

    // At boot the spinner still holds the markup default; the album's real
    // strength arrives from get_umap_eps. Asking now would be asking at a
    // strength nobody chose.
    mockState.autotaggingEnabled = true;
    window.dispatchEvent(new CustomEvent("autotaggingChanged", { detail: { enabled: true } }));
    await Promise.resolve();

    expect(labelRequests()).toEqual([]);
  });

  it("discards a response that arrives after the setting went off again", async () => {
    const umap = await boot();
    await redrawAt(umap, 0.6);
    mockSetClusterLabels.mockClear();

    window.dispatchEvent(new CustomEvent("autotaggingChanged", { detail: { enabled: false } }));
    await answerLabels(pendingLabels[0], { 1: { label: "unwanted" } });

    // Retiring the request installs an empty set; what must never arrive is
    // the answer to the request the user cancelled by switching the setting.
    expect(mockSetClusterLabels).not.toHaveBeenCalledWith({ 1: { label: "unwanted" } });
    expect(mockSetClusterLabels).toHaveBeenLastCalledWith({});
  });
});
