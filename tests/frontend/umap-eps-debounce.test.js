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
// sets badInput (verified -- see `typeUnparseable`). The tests below drive it
// with a stub, so they pin THIS MODULE's logic; that badInput is really set by
// a browser for a half-typed number is a platform guarantee, not something
// this suite proves.
//
// See umap-harness.js for why umap.js needs a harness to be importable.
//
// This file re-imports umap.js per test, and nothing unregisters the window
// listeners a previous import left behind. So do not assert on what a
// `window.dispatchEvent` did here — every stale module answers it too, and the
// one with no edit pending will happily satisfy an assertion the module under
// test failed. Those cases belong in umap-reindex-refresh.test.js, which
// imports once.

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
const badge = () => document.getElementById("umapEpsAutoBadge");

/** Everything POSTed to set_umap_eps, in order. */
let savedEps;
/** The full body of each of those POSTs, so a test can check the album. */
let savedBodies;

function installEpsFetchMock() {
  savedEps = [];
  savedBodies = [];
  fetched = [];
  global.fetch = (url, options) => {
    const href = String(url);
    fetched.push(href);
    if (href.startsWith("set_umap_eps")) {
      savedBodies.push(JSON.parse(options.body));
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
  const el = spinner();
  if (el.dataset.realValidity) {
    // Whatever the browser could not parse is gone, and so is badInput.
    Object.defineProperty(el, "validity", { value: realValidity.get(el), configurable: true });
    delete el.dataset.realValidity;
  }
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

/**
 * A copy of a ValidityState with badInput forced on.
 *
 * Spreading it would produce `{}` — every flag is a getter on the prototype,
 * so none of them is an own enumerable property. `for...in` walks the
 * prototype chain and reads each getter against the real object, which is
 * what keeps the stub honest as umap.js starts consulting other flags.
 */
function validityWithBadInput(real) {
  const copy = {};
  for (const key in real) {
    copy[key] = real[key];
  }
  copy.badInput = true;
  copy.valid = false;
  return copy;
}

/**
 * Put the field into the state a real browser reports for text it cannot turn
 * into a number yet ("0.", "-", "1e"): value "" and validity.badInput set.
 *
 * jsdom does the first but not the second, so badInput is stubbed. The stub
 * stays installed — a browser does not stop reporting badInput just because
 * the keystroke is over, and the field goes on showing the unparseable text
 * until something replaces it. `type()` takes it back off, the way entering a
 * parseable value does.
 */
function typeUnparseable() {
  const el = spinner();
  if (!el.dataset.realValidity) {
    realValidity.set(el, el.validity);
    el.dataset.realValidity = "stubbed";
  }
  Object.defineProperty(el, "validity", {
    value: validityWithBadInput(realValidity.get(el)),
    configurable: true,
  });
  el.value = "";
  el.dispatchEvent(new Event("input"));
}

const realValidity = new WeakMap();

/**
 * Run out the debounce.
 *
 * Fake timers rather than a real 1.15s wait per assertion: the debounce is a
 * second long by design, and five of those waits cost more wall clock than
 * the rest of the frontend suite put together. `advanceTimersByTimeAsync`
 * drains the microtask queue between firings, so the fetch chain the timer
 * starts finishes before this returns.
 */
const pastTheDebounce = () => jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 150);

/** Whether the field is marked as holding a value that cannot be saved. */
const isMarkedUnusable = () => spinner().classList.contains("umap-eps-unusable");

/** URLs fetched, in order — so a test can see what the map was asked for. */
let fetched;

let umap;

describe("Cluster Strength debounce", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    loadUmapDom();
    installPlotlyMock();
    installFetchMock([]);
    umap = await import(`${JS}/umap.js`);
    installEpsFetchMock();
    // The map is on screen: a save redraws it, which is the path every one of
    // these tests should be running unless it says otherwise.
    document.getElementById("umapFloatingWindow").style.display = "block";
    mockState.dataChanged = true;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
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

  it("refuses a strength the server would silently raise", async () => {
    // Positive, but under the spinner's own min and the server's
    // MIN_CLUSTER_EPS: storing it means the map clusters at 0.01 while the
    // spinner and the cluster-info modal both report 0.005.
    type("0.005");
    await pastTheDebounce();

    expect(savedEps).toEqual([]);
  });

  it("saves a strength above the spinner's display max", async () => {
    // The ceiling is not enforced: a derived strength for a small album can
    // legitimately exceed it, and refusing those would leave the albums that
    // need tuning most unable to be tuned.
    type("4.5");
    await pastTheDebounce();

    expect(savedEps).toEqual([4.5]);
  });

  it("marks the field while it holds something that cannot be saved", async () => {
    // The handler answers a value it will not store by doing nothing, so
    // without a mark a refused keystroke looks exactly like a saved one.
    typeUnparseable();
    expect(isMarkedUnusable()).toBe(true);
    expect(spinner().title).not.toBe("");

    type("0.005");
    expect(isMarkedUnusable()).toBe(true);

    type("0.4");
    expect(isMarkedUnusable()).toBe(false);
    expect(spinner().hasAttribute("title")).toBe(false);

    await pastTheDebounce();
    expect(savedEps).toEqual([0.4]);
  });

  it("does not put a derived strength back over a number typed since", async () => {
    // Clearing the field asks the server to derive one, and on a large album
    // that answer can be a minute coming — long enough for the user to change
    // their mind and type a number, which saves and redraws on its own.
    // Applying the late reply then shows a derived value and an "auto" badge
    // for an album that is storing the user's number.
    let releaseDerive;
    const realFetch = global.fetch;
    global.fetch = (url, options) => {
      if (String(url).startsWith("get_umap_eps")) {
        return new Promise((resolve) => {
          releaseDerive = () =>
            resolve({ ok: true, json: () => Promise.resolve({ success: true, eps: 0.07, auto: true }) });
        });
      }
      return realFetch(url, options);
    };

    type("");
    await pastTheDebounce();
    expect(savedEps).toEqual([null]);

    // The derive is still running; the user types a strength instead.
    type("0.5");
    await pastTheDebounce();
    expect(savedEps).toEqual([null, 0.5]);

    releaseDerive();
    await jest.advanceTimersByTimeAsync(0);

    expect(spinner().value).toBe("0.5");
    expect(badge().hidden).toBe(true);
  });

  it("does not redraw the map when the save fails", async () => {
    // A rejection is the server being unreachable. Nothing was stored, so
    // redrawing would show the map at a strength the album does not have.
    const realFetch = global.fetch;
    global.fetch = (url, options) =>
      String(url).startsWith("set_umap_eps") ? Promise.reject(new Error("offline")) : realFetch(url, options);

    type("0.5");
    await pastTheDebounce();

    expect(fetched.some((u) => u.startsWith("umap_data/"))).toBe(false);
    expect(isMarkedUnusable()).toBe(true);
  });

  it("does not redraw the map when the server refuses the save", async () => {
    // The refusal in practice is the 403 from require_no_lock: the album is
    // being indexed, which is exactly when someone is likely to be tuning it.
    const realFetch = global.fetch;
    global.fetch = (url, options) =>
      String(url).startsWith("set_umap_eps")
        ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ detail: "locked" }) })
        : realFetch(url, options);

    type("0.5");
    await pastTheDebounce();

    expect(fetched.some((u) => u.startsWith("umap_data/"))).toBe(false);
    expect(isMarkedUnusable()).toBe(true);
  });

  it("leaves the redraw to the next window open when the save lands on a closed map", async () => {
    // Plotly lays a plot out at zero size in a hidden container, and the
    // redraw would consume the flag the next open depends on to refetch.
    type("0.5");
    document.getElementById("umapFloatingWindow").style.display = "none";
    await pastTheDebounce();

    expect(savedEps).toEqual([0.5]);
    expect(fetched.some((u) => u.startsWith("umap_data/"))).toBe(false);
    expect(mockState.dataChanged).toBe(true);
  });

  it("does not send a strength it refused to save", async () => {
    // Refusing to store 0.005 but still asking the map for it gets the map
    // clustered at the server's floor — the very divergence the refusal is
    // there to prevent.
    type("0.005");
    await pastTheDebounce();
    fetched.length = 0;

    mockState.dataChanged = true;
    await umap.fetchUmapData();

    expect(savedEps).toEqual([]);
    const mapUrl = fetched.find((u) => u.startsWith("umap_data/"));
    expect(mapUrl).toBe("umap_data/test-album");
  });

  it("saves the number to the album it was typed in, not the one in view a second later", async () => {
    // Switching albums inside the debounce window used to hand the number to
    // whichever album `state.album` pointed at when the timer fired: album B
    // silently acquired a Cluster Strength typed for album A, and nothing on
    // screen said so until the next time B's map was opened.
    type("0.4");
    mockState.album = "other-album";
    await pastTheDebounce();

    expect(savedBodies).toEqual([{ album: "test-album", eps: 0.4 }]);
    // And the other album's map is not redrawn with it.
    expect(fetched.some((u) => u.startsWith("umap_data/"))).toBe(false);
  });

  it("marks a stored strength the map cannot cluster with", async () => {
    // Versions before the spinner refused these could store them, and the
    // config file is hand-editable. Leaving it unmarked is this module saying
    // the number is in effect when the server has floored it.
    umap.applyResolvedEps({ success: true, eps: 0.005, auto: false });

    expect(spinner().value).toBe("0.005");
    expect(isMarkedUnusable()).toBe(true);
  });

  it("does not mark a derived strength, however small", async () => {
    // A degenerate album can derive its way below the floor. The spinner
    // would refuse the number, but it is the one the map is clustered with.
    umap.applyResolvedEps({ success: true, eps: 9.3e-7, auto: true });

    expect(isMarkedUnusable()).toBe(false);
  });

  it("does not put a derived strength back over a number typed during the save", async () => {
    // The same race one step earlier: the keystroke lands while the clear is
    // still being POSTed, before the derive has even been asked for. Reading
    // the edit sequence when the derive starts would miss it, which is why
    // the save pins the sequence it began with and passes that down.
    let releaseSave;
    let held = true;
    const realFetch = global.fetch;
    global.fetch = (url, options) => {
      if (held && String(url).startsWith("set_umap_eps")) {
        held = false;
        return new Promise((resolve) => {
          releaseSave = () => {
            realFetch(url, options);
            resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
          };
        });
      }
      return realFetch(url, options);
    };

    type("");
    await pastTheDebounce();

    // The clear is in the air; the user changes their mind before it lands.
    type("0.5");
    releaseSave();
    await pastTheDebounce();

    expect(savedEps).toEqual([null, 0.5]);
    expect(spinner().value).toBe("0.5");
    expect(badge().hidden).toBe(true);
  });
});
