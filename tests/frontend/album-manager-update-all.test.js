/**
 * Tests for the album-manager "Update All" button: the backend-driven wait
 * that lets it march through the queue even when the dialog (and its UI
 * pollers) is closed, the bounded worker pool, and the button repaint that
 * survives a close/reopen of the dialog.
 *
 * album-manager.js pulls in a large sibling graph (index.js -> umap.js, etc.)
 * whose modules touch the DOM at import time, so we mock the direct imports and
 * dynamically load the module under test — the same pattern used by
 * album-manager-progress.test.js.
 */
import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/filetree.js`, () => ({
  createSimpleDirectoryPicker: jest.fn(),
}));
jest.unstable_mockModule(`${M}/index.js`, () => ({
  getIndexMetadata: jest.fn(),
  removeIndex: jest.fn(),
  updateIndex: jest.fn(),
}));
jest.unstable_mockModule(`${M}/search-ui.js`, () => ({
  exitSearchMode: jest.fn(),
}));
jest.unstable_mockModule(`${M}/settings.js`, () => ({
  closeSettingsModal: jest.fn(),
  loadAvailableAlbums: jest.fn(),
  openSettingsModal: jest.fn(),
}));
jest.unstable_mockModule(`${M}/state.js`, () => ({
  setAlbum: jest.fn(),
  state: {},
}));
jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(() => Promise.resolve({})),
  hideSpinner: jest.fn(),
  showSpinner: jest.fn(),
}));

let AlbumManager;
let fetchJson;

beforeAll(async () => {
  // album-manager.js instantiates `new AlbumManager()` at module load, and its
  // constructor wires click handlers on these buttons without null-guards, so
  // they must exist before import or the module eval throws.
  document.body.innerHTML =
    `<div id="albumManagementOverlay"></div>` +
    ["addAlbumBtn", "cancelAddAlbumBtn", "cancelAddAlbumBtn2", "closeAlbumManagementBtn", "showAddAlbumBtn"]
      .map((id) => `<button id="${id}"></button>`)
      .join("");

  ({ fetchJson } = await import(`${M}/utils.js`));
  ({ AlbumManager } = await import(`${M}/album-manager.js`));
  // The wait loop sleeps POLL_INTERVAL between backend polls; keep tests fast.
  AlbumManager.POLL_INTERVAL = 5;
});

afterEach(() => {
  fetchJson.mockReset();
  fetchJson.mockImplementation(() => Promise.resolve({}));
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeAlbumsList(keys) {
  const albumsList = document.createElement("div");
  for (const key of keys) {
    const card = document.createElement("div");
    card.className = "album-card";
    card.dataset.albumKey = key;
    albumsList.appendChild(card);
  }
  return albumsList;
}

// A fake manager exposing just what updateAllAlbums touches. startIndexing is
// recorded, and each album's "run" finishes only when the test resolves its
// deferred — so tests control how many updates are in flight.
function makeManager(keys) {
  const deferreds = new Map();
  const mgr = {
    updateAllProgress: null,
    albumsList: makeAlbumsList(keys),
    startIndexing: jest.fn(() => Promise.resolve()),
    _liveCardFor: (albumKey, fallback) => fallback,
    _refreshUpdateAllButton: AlbumManager.prototype._refreshUpdateAllButton,
    _waitForIndexingToFinish: jest.fn(
      (albumKey) =>
        new Promise((resolve) => {
          deferreds.set(albumKey, resolve);
        })
    ),
  };
  return { mgr, deferreds };
}

describe("_waitForIndexingToFinish", () => {
  test("keeps waiting while the backend reports a running status, then returns", async () => {
    const statuses = ["scanning", "indexing", "mapping", "completed"];
    fetchJson.mockImplementation(() => Promise.resolve({ status: statuses.shift() }));

    await AlbumManager.prototype._waitForIndexingToFinish.call({}, "alb");

    expect(statuses).toHaveLength(0); // consumed through "completed"
    expect(fetchJson).toHaveBeenCalledWith("index_progress/alb");
  });

  test("returns when the backend reports idle (job never started)", async () => {
    fetchJson.mockImplementation(() => Promise.resolve({ status: "idle" }));
    await AlbumManager.prototype._waitForIndexingToFinish.call({}, "alb");
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  test("survives transient poll failures but gives up after the limit", async () => {
    let calls = 0;
    fetchJson.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("busy"));
      }
      if (calls === 2) {
        return Promise.resolve({ status: "indexing" });
      }
      return Promise.reject(new Error("down"));
    });

    await AlbumManager.prototype._waitForIndexingToFinish.call({}, "alb");

    // 1 failure (tolerated) + 1 running + MAX_PROGRESS_POLL_FAILURES failures.
    expect(calls).toBe(2 + AlbumManager.MAX_PROGRESS_POLL_FAILURES);
  });
});

describe("_refreshUpdateAllButton", () => {
  test("repaints the live button from instance state (survives reopen)", () => {
    const btn = document.createElement("button");
    btn.id = "updateAllBtn";
    btn.textContent = "Update All";
    document.body.appendChild(btn);
    try {
      const mgr = { updateAllProgress: { finished: 2, total: 5 } };
      AlbumManager.prototype._refreshUpdateAllButton.call(mgr);
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Updating 2/5…");

      mgr.updateAllProgress = null;
      AlbumManager.prototype._refreshUpdateAllButton.call(mgr);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("Update All");
    } finally {
      btn.remove();
    }
  });
});

describe("updateAllAlbums", () => {
  test("updates every album but keeps at most MAX_CONCURRENT_UPDATES in flight", async () => {
    const keys = ["a", "b", "c", "d"];
    const { mgr, deferreds } = makeManager(keys);

    const run = AlbumManager.prototype.updateAllAlbums.call(mgr);
    await flush();

    expect(mgr.startIndexing).toHaveBeenCalledTimes(AlbumManager.MAX_CONCURRENT_UPDATES);

    deferreds.get("a")();
    await flush();
    expect(mgr.startIndexing).toHaveBeenCalledTimes(3);

    deferreds.get("b")();
    await flush();
    expect(mgr.startIndexing).toHaveBeenCalledTimes(4);

    deferreds.get("c")();
    deferreds.get("d")();
    await run;

    expect(mgr.startIndexing.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(mgr.updateAllProgress).toBeNull();
  });

  test("a failing album does not stop the remaining updates", async () => {
    const { mgr } = makeManager(["a", "b", "c"]);
    mgr.startIndexing = jest.fn((albumKey) =>
      albumKey === "a" ? Promise.reject(new Error("boom")) : Promise.resolve()
    );
    mgr._waitForIndexingToFinish = jest.fn(() => Promise.resolve());

    await AlbumManager.prototype.updateAllAlbums.call(mgr);

    expect(mgr.startIndexing.mock.calls.map(([key]) => key)).toEqual(["a", "b", "c"]);
    expect(mgr.updateAllProgress).toBeNull();
  });

  test("disables the button while running and restores it afterwards", async () => {
    const btn = document.createElement("button");
    btn.id = "updateAllBtn";
    btn.textContent = "Update All";
    document.body.appendChild(btn);
    try {
      const { mgr, deferreds } = makeManager(["a", "b"]);

      const run = AlbumManager.prototype.updateAllAlbums.call(mgr);
      await flush();
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Updating 0/2…");

      deferreds.get("a")();
      await flush();
      expect(btn.textContent).toBe("Updating 1/2…");

      deferreds.get("b")();
      await run;
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe("Update All");
    } finally {
      btn.remove();
    }
  });

  test("re-entry and empty album list are no-ops", async () => {
    const { mgr } = makeManager([]);
    await AlbumManager.prototype.updateAllAlbums.call(mgr);
    expect(mgr.startIndexing).not.toHaveBeenCalled();

    const { mgr: busy } = makeManager(["a"]);
    busy.updateAllProgress = { finished: 0, total: 3 };
    await AlbumManager.prototype.updateAllAlbums.call(busy);
    expect(busy.startIndexing).not.toHaveBeenCalled();
  });
});

describe("Update All visibility", () => {
  test("hidden when no albums exist, shown once albums are present", () => {
    const btn = document.createElement("button");
    btn.id = "updateAllBtn";
    document.body.appendChild(btn);
    try {
      const empty = { updateAllProgress: null, albumsList: makeAlbumsList([]) };
      AlbumManager.prototype._refreshUpdateAllButton.call(empty);
      expect(btn.style.display).toBe("none");

      const populated = { updateAllProgress: null, albumsList: makeAlbumsList(["a"]) };
      AlbumManager.prototype._refreshUpdateAllButton.call(populated);
      expect(btn.style.display).toBe("");
    } finally {
      btn.remove();
    }
  });
});
