/**
 * @jest-environment jsdom
 */
//
// The autotagging setting can be flipped while a drawer is already open — from
// the settings checkbox, or at boot when the server's copy of the preference
// arrives after the map fetch already decided to skip the labels. Neither has a
// slide change to hang a re-render off, which is why cluster-utils announces
// the change and the drawer listens.
//
// cluster-utils is the real module here (only its utils.js dependency is
// mocked), so these exercise the actual event contract between it and the
// drawer rather than two halves of a mock.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

// The real markup, for the same reason umap-harness.js uses it: metadata-drawer
// wires listeners onto these elements at *module scope*, and a hand-copied
// fixture is the usual way a test stops matching what the app ships. Neither
// template contains Jinja tags, so both can be used verbatim.
const TEMPLATES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "photomap",
  "frontend",
  "templates",
  "modules"
);
const DRAWER_MARKUP =
  readFileSync(path.join(TEMPLATES, "metadata-modal.html"), "utf8") +
  readFileSync(path.join(TEMPLATES, "metadata-drawer.html"), "utf8");

function drawerDom() {
  document.body.innerHTML = DRAWER_MARKUP;
}

// Must be in place before the import below: metadata-drawer.js resolves the
// metadata modal's elements and binds to them as it is evaluated.
drawerDom();

const mockFetchJson = jest.fn();

jest.unstable_mockModule(`${JS}/utils.js`, () => ({
  fetchJson: mockFetchJson,
  showToast: jest.fn(() => ({ dismiss: jest.fn() })),
  isColorLight: jest.fn(() => false),
  makeDraggable: jest.fn(),
}));

const mockState = {
  album: "demo",
  gridViewActive: false,
  single_swiper: null,
  grid_swiper: null,
  searchType: null,
  searchResults: [],
};

jest.unstable_mockModule(`${JS}/state.js`, () => ({
  state: mockState,
  setShowMetadataFields: jest.fn(),
}));

const mockSlideState = { searchResults: [], getCurrentSlide: jest.fn(() => ({ globalIndex: 7 })) };

jest.unstable_mockModule(`${JS}/slide-state.js`, () => ({
  slideState: mockSlideState,
  getCurrentSlideIndex: jest.fn(() => 7),
}));

jest.unstable_mockModule(`${JS}/search.js`, () => ({ setSearchResults: jest.fn() }));

jest.unstable_mockModule(`${JS}/bookmarks.js`, () => ({
  bookmarkManager: { isBookmarked: jest.fn(() => false), toggleBookmark: jest.fn() },
}));

const mockScoreDisplay = {
  setToggleBookmarkCallback: jest.fn(),
  setBookmarkStatus: jest.fn(),
  refreshDisplay: jest.fn(),
  showIndex: jest.fn(),
  showSearchScore: jest.fn(),
  showCluster: jest.fn(),
  rerenderClusterLabel: jest.fn(),
};

jest.unstable_mockModule(`${JS}/score-display.js`, () => ({ scoreDisplay: mockScoreDisplay }));

jest.unstable_mockModule(`${JS}/reference-thumbnails.js`, () => ({
  enhanceReferenceImageThumbnails: jest.fn(),
  registerReferenceThumbnailClickHandler: jest.fn(),
}));

const clusterUtils = await import(`${JS}/cluster-utils.js`);
const drawer = await import(`${JS}/metadata-drawer.js`);

const LABELS = { 3: { label: "food", alternates: ["meal", "snack"], score: 0.4 } };

// Let the drawer's listeners (and the image-label fetch they start) settle.
const flush = async () => {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
};

/** A stand-in for the swiper's current slide element. */
function showSlide(globalIndex = 7, extraDataset = {}) {
  const slide = document.createElement("div");
  slide.dataset.globalIndex = String(globalIndex);
  Object.assign(slide.dataset, extraDataset);
  mockState.single_swiper = { currentSlide: () => slide };
  return slide;
}

describe("autotagging toggle", () => {
  beforeEach(() => {
    drawerDom();
    mockFetchJson.mockReset();
    mockFetchJson.mockResolvedValue({ label: "seafood", alternates: ["shrimp", "meal"] });
    mockScoreDisplay.showCluster.mockClear();
    mockScoreDisplay.rerenderClusterLabel.mockClear();
    mockSlideState.getCurrentSlide.mockReturnValue({ globalIndex: 7 });
    mockSlideState.searchResults = [];
    mockState.searchResults = [];
    mockState.album = "demo";
    mockState.searchType = null;
    mockState.gridViewActive = false;
    mockState.single_swiper = null;
    mockState.grid_swiper = null;
    window.umapPoints = [
      { index: 7, cluster: 3 },
      { index: 8, cluster: 3 },
    ];
    clusterUtils.setAutotaggingEnabledInLabels(false);
    clusterUtils.setClusterLabels({});
    clusterUtils.clearImageLabelCache();
  });

  afterEach(() => {
    delete window.umapPoints;
  });

  // The generation counter and the in-flight bookkeeping are the load-bearing
  // state in this change: without them a response already in the air when the
  // cache was dropped writes its stale answer into the fresh cache, where it
  // stays forever, because a cache hit never refetches.
  describe("image-label cache generations", () => {
    // Turning the setting on makes the drawer render its rows, which issues an
    // image_label fetch of its own. Get that out of the way first so each test
    // below starts from a quiet cache and an unconsumed mock.
    async function settleAutotaggingOn() {
      clusterUtils.setAutotaggingEnabledInLabels(true);
      await flush();
      clusterUtils.clearImageLabelCache();
      mockFetchJson.mockReset();
      mockFetchJson.mockResolvedValue({ label: "default" });
    }

    /** A fetch whose resolution this test controls. */
    function deferredFetch() {
      let resolve;
      const pending = new Promise((r) => {
        resolve = r;
      });
      mockFetchJson.mockReturnValueOnce(pending);
      return { resolve };
    }

    it("does not cache a response that was in the air when the cache was dropped", async () => {
      await settleAutotaggingOn();
      const first = deferredFetch();

      const inFlight = clusterUtils.getImageLabelInfo("demo", 7);
      clusterUtils.clearImageLabelCache(); // e.g. the album was re-indexed
      first.resolve({ label: "stale" });
      expect(await inFlight).toEqual({ label: "stale" }); // the awaiter still gets it

      // ...but it must not have been stored: the next read refetches.
      mockFetchJson.mockResolvedValueOnce({ label: "fresh" });
      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "fresh" });
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it("caches a response that outlived no clear", async () => {
      await settleAutotaggingOn();
      mockFetchJson.mockResolvedValueOnce({ label: "seafood" });

      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "seafood" });
      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "seafood" });
      expect(mockFetchJson).toHaveBeenCalledTimes(1); // second read was a cache hit
    });

    it("lets a request issued after a clear settle normally", async () => {
      // The older request's `finally` must not evict the newer request's entry
      // from the in-flight map: that would leave a third caller issuing a
      // duplicate fetch for a key that is already being fetched.
      await settleAutotaggingOn();
      const first = deferredFetch();
      const firstPromise = clusterUtils.getImageLabelInfo("demo", 7);

      clusterUtils.clearImageLabelCache();
      const second = deferredFetch();
      const secondPromise = clusterUtils.getImageLabelInfo("demo", 7);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);

      first.resolve({ label: "stale" }); // older one settles last-but-one
      await firstPromise;

      // The newer request is still deduped — no third fetch.
      const thirdPromise = clusterUtils.getImageLabelInfo("demo", 7);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);

      second.resolve({ label: "fresh" });
      expect(await secondPromise).toEqual({ label: "fresh" });
      expect(await thirdPromise).toEqual({ label: "fresh" });
      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "fresh" });
      expect(mockFetchJson).toHaveBeenCalledTimes(2); // and it did get cached
    });

    it("drops cached labels when the album is re-indexed", async () => {
      // A re-index renumbers the album, so index 7 is a different picture now.
      // The cluster labels are retired on this path by umap.js; the per-image
      // ones have to be too, or the tag row names the wrong image for good.
      await settleAutotaggingOn();
      mockFetchJson.mockResolvedValueOnce({ label: "before" });
      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "before" });

      window.dispatchEvent(new CustomEvent("albumIndexUpdated", { detail: { albumKey: "demo" } }));

      mockFetchJson.mockResolvedValueOnce({ label: "after" });
      expect(await clusterUtils.getImageLabelInfo("demo", 7)).toEqual({ label: "after" });
    });

    it("returns a real promise from a deduped call", async () => {
      // Callers chain .catch() on this; a bare thenable would break them.
      await settleAutotaggingOn();
      const gate = deferredFetch();

      const a = clusterUtils.getImageLabelInfo("demo", 7);
      const b = clusterUtils.getImageLabelInfo("demo", 7); // deduped
      expect(typeof b.catch).toBe("function");

      gate.resolve({ label: "seafood" });
      expect(await a).toEqual({ label: "seafood" });
      expect(await b).toEqual({ label: "seafood" });
    });
  });

  describe("cluster-utils announces the change", () => {
    it("fires autotaggingChanged only when the value actually changes", () => {
      const seen = [];
      const listener = (e) => seen.push(e.detail.enabled);
      window.addEventListener("autotaggingChanged", listener);

      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setAutotaggingEnabledInLabels(true); // a boot that merely confirms it
      clusterUtils.setAutotaggingEnabledInLabels(false);

      window.removeEventListener("autotaggingChanged", listener);
      expect(seen).toEqual([true, false]);
    });

    it("drops the cluster labels when the setting changes", () => {
      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      expect(clusterUtils.getClusterLabelInfo(3).label).toBe("food");

      clusterUtils.setAutotaggingEnabledInLabels(false);
      expect(clusterUtils.getClusterLabelInfo(3)).toBeNull();
    });

    it("drops the per-image label cache, so re-enabling refetches", async () => {
      clusterUtils.setAutotaggingEnabledInLabels(true);
      await clusterUtils.getImageLabelInfo("demo", 7);
      await clusterUtils.getImageLabelInfo("demo", 7); // served from cache
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      clusterUtils.setAutotaggingEnabledInLabels(false);
      clusterUtils.setAutotaggingEnabledInLabels(true);
      await clusterUtils.getImageLabelInfo("demo", 7);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it("fires clusterLabelsUpdated whenever labels are installed", () => {
      const listener = jest.fn();
      window.addEventListener("clusterLabelsUpdated", listener);
      clusterUtils.setClusterLabels(LABELS);
      window.removeEventListener("clusterLabelsUpdated", listener);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("the open drawer re-renders in place", () => {
    it("shows both tag rows when the setting goes on, with no slide change", async () => {
      showSlide(7);
      drawer.updateClusterInfo({ globalIndex: "7" });
      await drawer.updateImageLabel({ globalIndex: "7" });

      // Off: the badge carries no label and the image row is hidden.
      expect(document.getElementById("clusterInfoBadge").textContent).toBe("Cluster 3 (size=2)");
      expect(document.getElementById("imageLabelContainer").style.display).toBe("none");

      clusterUtils.setAutotaggingEnabledInLabels(true);
      await flush();
      // The per-image row comes back on the setting alone — it doesn't wait
      // for the cluster-labels round trip.
      expect(document.getElementById("imageLabelContainer").style.display).toBe("block");
      expect(document.getElementById("imageLabelText").textContent).toBe("seafood, shrimp, meal");

      // ...and the cluster tag lands when the labels arrive.
      clusterUtils.setClusterLabels(LABELS);
      await flush();
      expect(document.getElementById("clusterInfoBadge").textContent).toBe("Cluster 3 · food (size=2)");
    });

    it("clears both tag rows when the setting goes off", async () => {
      showSlide(7);
      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();
      expect(document.getElementById("imageLabelContainer").style.display).toBe("block");

      clusterUtils.setAutotaggingEnabledInLabels(false);
      await flush();
      expect(document.getElementById("clusterInfoBadge").textContent).toBe("Cluster 3 (size=2)");
      expect(document.getElementById("imageLabelContainer").style.display).toBe("none");
    });

    it("reads grid view's metadata when grid view is the active mode", async () => {
      mockState.gridViewActive = true;
      mockState.grid_swiper = { currentSlideMetadata: () => ({ globalIndex: 8 }) };
      mockState.single_swiper = null; // grid view must not be read off the swiper

      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();

      expect(document.getElementById("clusterInfoBadge").textContent).toBe("Cluster 3 · food (size=2)");
      expect(document.getElementById("imageLabelContainer").style.display).toBe("block");
    });

    it("clears both tag rows when the setting goes off and the metadata is gone", async () => {
      // Grid view trims the metadata of tiles it drops (enforceHighWaterMark),
      // and the current tile can be one of them — so the rows can outlive the
      // thing they describe. Toggling autotagging off still has to clear them.
      showSlide(7);
      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();
      expect(document.getElementById("imageLabelContainer").style.display).toBe("block");

      mockState.single_swiper = null; // the slide it was describing is gone
      clusterUtils.setAutotaggingEnabledInLabels(false);
      await flush();

      expect(document.getElementById("imageLabelContainer").style.display).toBe("none");
    });

    it("still renders the rows when the metadata is gone but the index is known", async () => {
      // The rows need nothing from the metadata but the index, and slide-state
      // always has that. Hiding them here would strand them hidden until the
      // next slide change — the reload-to-see-it bug this module exists to fix,
      // reintroduced on the device the fix targets (grid view, tile metadata
      // still in flight when the server's preference lands).
      mockState.single_swiper = null;
      mockState.gridViewActive = true;
      mockState.grid_swiper = { currentSlideMetadata: () => null };

      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();

      expect(document.getElementById("clusterInfoContainer").style.display).toBe("block");
      expect(document.getElementById("clusterInfoBadge").textContent).toBe("Cluster 3 · food (size=2)");
      expect(document.getElementById("imageLabelContainer").style.display).toBe("block");
      expect(mockFetchJson).toHaveBeenCalledWith("image_label/demo/7");
    });

    it("re-splices the pill's label when it cannot rebuild the pill from metadata", async () => {
      // updateCurrentImageScore needs the total, the search index and any
      // score, so a synthesized {globalIndex} would turn a search score into a
      // cluster. The pill re-derives its own label instead.
      mockState.single_swiper = null;
      clusterUtils.setAutotaggingEnabledInLabels(true);
      await flush();

      expect(mockScoreDisplay.rerenderClusterLabel).toHaveBeenCalled();
      expect(mockScoreDisplay.showCluster).not.toHaveBeenCalled();
    });

    it("hides the rows when nothing identifies what is on screen", async () => {
      mockState.single_swiper = null;
      mockSlideState.getCurrentSlide.mockReturnValue({ globalIndex: null });

      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();

      expect(document.getElementById("clusterInfoContainer").style.display).toBe("none");
      expect(document.getElementById("imageLabelContainer").style.display).toBe("none");
      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it("re-renders the score pill, which carries the same cluster label", async () => {
      // The pill only shows a cluster (rather than a plain position) while a
      // cluster selection is active.
      showSlide(7, { searchIndex: "0", total: "2" });
      mockState.searchType = "cluster";
      mockState.searchResults = [{ index: 7 }, { index: 8 }];
      mockSlideState.searchResults = [{ index: 7 }, { index: 8 }];
      clusterUtils.setAutotaggingEnabledInLabels(true);
      clusterUtils.setClusterLabels(LABELS);
      await flush();

      // showCluster re-derives the label from the cache on every call, so a
      // re-render is all that is needed — but it has to happen, and it has to
      // carry the position the slide actually holds rather than a NaN built
      // from a dataset that was never stamped.
      expect(mockScoreDisplay.showCluster).toHaveBeenCalledWith(3, expect.any(String), 0, 2);
    });
  });
});
