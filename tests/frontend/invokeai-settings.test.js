// Unit tests for settings.js — the InvokeAI reachability / boards flow.
// Scope is deliberately narrow: the settings UI is mostly plumbing, so these
// cover the decision points that could silently regress (show/hide the auth
// section, populate the boards dropdown, fall back to Uncategorized).

import { jest, describe, it, expect, afterEach } from "@jest/globals";

// settings.js pulls in several other modules; stub them so the module loads
// cleanly under jsdom.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])) },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/search-ui.js", () => ({
  exitSearchMode: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/state.js", () => ({
  saveSettingsToLocalStorage: jest.fn(),
  setAlbum: jest.fn(),
  setMaxSearchResults: jest.fn(),
  setMinSearchScore: jest.fn(),
  state: {
    album: "test",
    currentDelay: 5,
    mode: "chronological",
    showControlPanelText: true,
    suppressDeleteConfirm: false,
    gridThumbSizeFactor: 1,
    minSearchScore: 0,
    maxSearchResults: 10,
    swiper: { params: { autoplay: { delay: 5000 } } },
  },
}));

const { cacheElements, loadInvokeAISettings, loadInvokeAIBoards, refreshInvokeAIStatus } =
  await import("../../photomap/frontend/static/javascript/settings.js");

function buildSettingsDom({ url = "" } = {}) {
  document.body.innerHTML = `
    <input id="invokeaiUrlInput" value="${url}" />
    <input id="invokeaiUsernameInput" />
    <input id="invokeaiPasswordInput" />
    <div id="invokeaiAuthSection" hidden>
      <select id="invokeaiBoardSelect"><option value="">Uncategorized</option></select>
    </div>
    <small id="invokeaiStatusHint"></small>
  `;
  cacheElements();
}

function mockFetchSequence(responses) {
  // Sequentially return queued responses for matching URLs.  Any call that
  // doesn't find a response for its URL will throw so tests catch unexpected
  // requests rather than silently returning undefined.
  global.fetch = jest.fn((url) => {
    const entry = responses.shift();
    if (!entry) {
      throw new Error(`Unexpected fetch call: ${url}`);
    }
    if (entry.match && !url.includes(entry.match)) {
      throw new Error(`Expected ${entry.match} but got ${url}`);
    }
    return Promise.resolve({
      ok: entry.ok !== false,
      json: () => Promise.resolve(entry.body ?? {}),
    });
  });
}

describe("InvokeAI settings flow", () => {
  afterEach(() => {
    delete global.fetch;
    document.body.innerHTML = "";
  });

  describe("refreshInvokeAIStatus", () => {
    it("leaves the auth section hidden when URL is blank", async () => {
      buildSettingsDom({ url: "" });
      global.fetch = jest.fn(() => {
        throw new Error("Status endpoint must not be called for blank URL");
      });

      await refreshInvokeAIStatus();

      expect(document.getElementById("invokeaiAuthSection").hidden).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("reveals the auth section when the backend reports reachable", async () => {
      buildSettingsDom({ url: "http://localhost:9090" });
      mockFetchSequence([
        { match: "invokeai/status", body: { reachable: true, version: "5.6.0" } },
        { match: "invokeai/boards", body: [{ board_id: "b1", board_name: "Landscapes" }] },
      ]);

      await refreshInvokeAIStatus();

      expect(document.getElementById("invokeaiAuthSection").hidden).toBe(false);
      const select = document.getElementById("invokeaiBoardSelect");
      const options = Array.from(select.options).map((o) => o.textContent);
      expect(options).toContain("Uncategorized");
      expect(options).toContain("Landscapes");
    });

    it("keeps the auth section hidden when the backend is unreachable", async () => {
      buildSettingsDom({ url: "http://localhost:9999" });
      mockFetchSequence([{ match: "invokeai/status", body: { reachable: false, detail: "unreachable" } }]);

      await refreshInvokeAIStatus();

      expect(document.getElementById("invokeaiAuthSection").hidden).toBe(true);
    });
  });

  describe("loadInvokeAIBoards", () => {
    it("disables the dropdown and falls back to Uncategorized on failure", async () => {
      buildSettingsDom({ url: "http://localhost:9090" });
      mockFetchSequence([{ match: "invokeai/boards", ok: false, body: { detail: "nope" } }]);

      await loadInvokeAIBoards();

      const select = document.getElementById("invokeaiBoardSelect");
      expect(select.disabled).toBe(true);
      expect(select.options).toHaveLength(1);
      expect(select.options[0].textContent).toBe("Uncategorized");
      expect(select.value).toBe("");
    });

    it("populates options from a successful boards response", async () => {
      buildSettingsDom({ url: "http://localhost:9090" });
      mockFetchSequence([
        {
          match: "invokeai/boards",
          body: [
            { board_id: "b1", board_name: "Landscapes" },
            { board_id: "b2", board_name: "Portraits" },
          ],
        },
      ]);

      await loadInvokeAIBoards();

      const select = document.getElementById("invokeaiBoardSelect");
      expect(select.disabled).toBe(false);
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toEqual(["", "b1", "b2"]);
    });
  });

  describe("loadInvokeAISettings", () => {
    it("populates inputs and kicks off the status + boards refresh", async () => {
      buildSettingsDom({ url: "" });
      mockFetchSequence([
        {
          match: "invokeai/config",
          body: {
            url: "http://localhost:9090",
            username: "alice",
            has_password: true,
            board_id: "b2",
          },
        },
        { match: "invokeai/status", body: { reachable: true, version: "5.6.0" } },
        {
          match: "invokeai/boards",
          body: [
            { board_id: "b1", board_name: "Landscapes" },
            { board_id: "b2", board_name: "Portraits" },
          ],
        },
      ]);

      await loadInvokeAISettings();

      expect(document.getElementById("invokeaiUrlInput").value).toBe("http://localhost:9090");
      expect(document.getElementById("invokeaiUsernameInput").value).toBe("alice");
      // Password field is never populated from the server, but its placeholder
      // should reflect that one is saved.
      expect(document.getElementById("invokeaiPasswordInput").placeholder).toMatch(/saved/);
      expect(document.getElementById("invokeaiAuthSection").hidden).toBe(false);
      // The previously-persisted board_id is restored as the dropdown selection.
      expect(document.getElementById("invokeaiBoardSelect").value).toBe("b2");
    });
  });
});
