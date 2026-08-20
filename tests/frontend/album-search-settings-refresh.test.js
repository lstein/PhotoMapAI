// Reloading an album's search settings after it is edited.
//
// The backend changes min_search_score without being asked to: swapping an
// album's encoder *family* re-resolves it, because the CLIP floor (0.2)
// matches almost nothing under SigLIP (0.005). If state keeps the old value,
// the next nudge of any search setting persists it straight back over the
// re-resolved one -- and it now survives there, because an album update
// keeps every field its payload carries.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${JS}/album-manager.js`, () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])) },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/cluster-utils.js`, () => ({
  setAutotaggingEnabledInLabels: jest.fn(),
}));
jest.unstable_mockModule(`${JS}/index.js`, () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
}));
jest.unstable_mockModule(`${JS}/preferences-client.js`, () => ({
  fetchPreferences: jest.fn(() => Promise.resolve({})),
  flushPendingPatches: jest.fn(() => Promise.resolve()),
  loadServerTimestamp: jest.fn(() => Promise.resolve()),
  queuePreferencePatch: jest.fn(),
}));

const fetchJson = jest.fn();
jest.unstable_mockModule(`${JS}/utils.js`, () => ({ fetchJson }));

const SIGLIP = {
  key: "a",
  encoder_spec: "siglip:google/siglip2-large-patch16-256",
  min_search_score: 0.005,
  max_search_results: 100,
  use_query_optimization: true,
};

let stateModule;

beforeEach(async () => {
  jest.resetModules();
  fetchJson.mockReset();
  stateModule = await import(`${JS}/state.js`);
  // The album was a CLIP album when the page loaded.
  stateModule.state.album = "a";
  stateModule.state.minSearchScore = 0.2;
});

describe("refreshActiveAlbumSearchSettings", () => {
  it("adopts a score the backend re-resolved during an album edit", async () => {
    fetchJson.mockResolvedValue(SIGLIP);

    await stateModule.refreshActiveAlbumSearchSettings("a");

    expect(stateModule.state.minSearchScore).toBe(0.005);
  });

  it("ignores an edit to some album other than the active one", async () => {
    fetchJson.mockResolvedValue(SIGLIP);

    await stateModule.refreshActiveAlbumSearchSettings("b");

    expect(fetchJson).not.toHaveBeenCalled();
    expect(stateModule.state.minSearchScore).toBe(0.2);
  });

  it("leaves state alone when the reload fails", async () => {
    fetchJson.mockRejectedValue(new Error("offline"));

    await expect(stateModule.refreshActiveAlbumSearchSettings("a")).resolves.toBeUndefined();
    expect(stateModule.state.minSearchScore).toBe(0.2);
  });

  it("stops the next settings write from restoring the stale score", async () => {
    // The whole point: without the refresh, this write puts 0.2 back on a
    // SigLIP album, where it matches nothing.
    fetchJson.mockResolvedValue(SIGLIP);
    await stateModule.refreshActiveAlbumSearchSettings("a");

    fetchJson.mockReset();
    fetchJson.mockResolvedValue(SIGLIP);
    stateModule.persistCurrentAlbumSearchSettings();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const write = fetchJson.mock.calls.find(([url]) => url === "update_album/");
    expect(write).toBeDefined();
    expect(write[1].json.min_search_score).toBe(0.005);
  });
});
