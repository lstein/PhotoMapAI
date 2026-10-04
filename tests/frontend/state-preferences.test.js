// Restoring and persisting preferences in state.js.
//
// iOS empties localStorage (and the device cookie with it) after the browser
// has been closed for a while. The server now embeds the device's record in
// the page as window.initialPreferences, so boot must take its values from
// there first; and every write must send only the keys it changed, so a tab
// never pushes stale copies of settings it didn't touch over the server's.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

const ALBUMS = [{ key: "first" }, { key: "second" }];

jest.unstable_mockModule(`${JS}/album-manager.js`, () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve(ALBUMS)) },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/cluster-utils.js`, () => ({
  setAutotaggingEnabledInLabels: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/index.js`, () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
}));
const queuePreferencePatch = jest.fn();
jest.unstable_mockModule(`${JS}/preferences-client.js`, () => ({
  flushPendingPatches: jest.fn(() => Promise.resolve()),
  queuePreferencePatch,
}));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({ fetchJson: jest.fn(() => Promise.resolve(null)) }));

let stateModule;

beforeEach(async () => {
  jest.resetModules();
  queuePreferencePatch.mockReset();
  localStorage.clear();
  delete window.initialPreferences;
  stateModule = await import(`${JS}/state.js`);
});

afterEach(() => {
  delete window.initialPreferences;
});

describe("restorePersistedSettings", () => {
  it("takes the embedded server record over localStorage", async () => {
    localStorage.setItem("currentDelay", "9");
    localStorage.setItem("album", "first");
    window.initialPreferences = {
      currentDelay: 3,
      autotaggingEnabled: true,
      showControlPanelText: false,
      umapWindowOpen: false,
      gridViewActive: true,
      lastSlideIndex: { second: 200 },
      album: "second",
      updatedAt: 1,
    };

    await stateModule.restorePersistedSettings();

    const { state } = stateModule;
    expect(state.currentDelay).toBe(3);
    expect(state.autotaggingEnabled).toBe(true);
    expect(state.showControlPanelText).toBe(false);
    expect(state.umapWindowOpen).toBe(false);
    expect(state.gridViewActive).toBe(true);
    expect(state.lastSlideIndex).toEqual({ second: 200 });
    expect(state.album).toBe("second");
    // The record is already on the server — nothing to send back.
    expect(queuePreferencePatch).not.toHaveBeenCalled();
    // localStorage now mirrors it.
    expect(localStorage.getItem("currentDelay")).toBe("3");
    expect(localStorage.getItem("lastSlideIndex")).toBe('{"second":200}');
  });

  it("falls back to localStorage for null fields in the record", async () => {
    localStorage.setItem("mediaFilter", "videos");
    window.initialPreferences = { mediaFilter: null, currentDelay: 4, updatedAt: 1 };

    await stateModule.restorePersistedSettings();

    expect(stateModule.state.mediaFilter).toBe("videos");
    expect(stateModule.state.currentDelay).toBe(4);
  });

  it("ignores an embedded album that no longer exists", async () => {
    localStorage.setItem("album", "first");
    window.initialPreferences = { album: "deleted-album", updatedAt: 1 };

    await stateModule.restorePersistedSettings();

    expect(stateModule.state.album).toBe("first");
  });

  it("drops invalid entries from an embedded slide map", async () => {
    window.initialPreferences = { lastSlideIndex: { a: 5, b: -1, c: "x", d: 2.5 }, updatedAt: 1 };

    await stateModule.restorePersistedSettings();

    expect(stateModule.state.lastSlideIndex).toEqual({ a: 5 });
  });

  it("seeds a record for a device that has none", async () => {
    localStorage.setItem("currentDelay", "7");
    window.initialPreferences = null;

    await stateModule.restorePersistedSettings();

    expect(stateModule.state.currentDelay).toBe(7);
    expect(queuePreferencePatch).toHaveBeenCalledTimes(1);
    const payload = queuePreferencePatch.mock.calls[0][0];
    expect(payload.currentDelay).toBe(7);
    expect(payload.album).toBe("first");
    expect(payload.umapWindowOpen).toBe(true);
  });
});

describe("persisting a change sends only that key", () => {
  it("persistSettings", () => {
    stateModule.state.gridViewActive = true;
    stateModule.persistSettings("gridViewActive");

    expect(queuePreferencePatch).toHaveBeenCalledWith({ gridViewActive: true });
    expect(localStorage.getItem("gridViewActive")).toBe("true");
    expect(localStorage.getItem("currentDelay")).toBeNull();
  });

  it("persistSettings for the album", () => {
    stateModule.state.album = "second";
    stateModule.persistSettings("album");

    expect(queuePreferencePatch).toHaveBeenCalledWith({ album: "second" });
  });

  it("a generated setter", () => {
    stateModule.setAutotaggingEnabled(true);

    expect(queuePreferencePatch).toHaveBeenCalledWith({ autotaggingEnabled: true });
  });
});
