// Unit tests for invoke-recall.js — the Recall / Remix buttons wired into the
// InvokeAI metadata drawer.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the chain of modules pulled in by state.js so the module can load in
// jsdom without hitting real DOM bootstraps.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/album-manager.js", () => ({
  albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])) },
  checkAlbumIndex: jest.fn(),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/index.js", () => ({
  getIndexMetadata: jest.fn(() => Promise.resolve({ filename_count: 0 })),
}));
jest.unstable_mockModule("../../photomap/frontend/static/javascript/utils.js", () => ({
  showSpinner: jest.fn(),
  hideSpinner: jest.fn(),
}));

const { state } = await import("../../photomap/frontend/static/javascript/state.js");
const { parseMetadataUrl, sendRecall, sendUseRefImage } =
  await import("../../photomap/frontend/static/javascript/invoke-recall.js");

describe("invoke-recall.js", () => {
  describe("parseMetadataUrl", () => {
    it("parses a relative metadata_url into album key and index", () => {
      expect(parseMetadataUrl("get_metadata/my-album/42")).toEqual({
        albumKey: "my-album",
        index: 42,
      });
    });

    it("handles absolute URLs with prefixes", () => {
      expect(parseMetadataUrl("http://localhost:8050/get_metadata/vacation/7")).toEqual({
        albumKey: "vacation",
        index: 7,
      });
    });

    it("decodes URL-encoded album keys", () => {
      expect(parseMetadataUrl("get_metadata/my%20album/3")).toEqual({
        albumKey: "my album",
        index: 3,
      });
    });

    it("returns null for malformed metadata URLs", () => {
      expect(parseMetadataUrl("")).toBeNull();
      expect(parseMetadataUrl(null)).toBeNull();
      expect(parseMetadataUrl("get_metadata/onlyalbum")).toBeNull();
      expect(parseMetadataUrl("get_metadata/album/notanumber")).toBeNull();
    });
  });

  describe("sendRecall", () => {
    afterEach(() => {
      // Make sure other tests can't see leftover fetch stubs.
      delete global.fetch;
    });

    it("POSTs album_key / index / include_seed to /invokeai/recall", async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })
      );
      global.fetch = fetchMock;

      const result = await sendRecall({
        albumKey: "vacation",
        index: 3,
        includeSeed: false,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("invokeai/recall");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({
        album_key: "vacation",
        index: 3,
        include_seed: false,
      });
      expect(result).toEqual({ success: true });
    });

    it("throws with the server-provided detail on non-2xx responses", async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ detail: "boom" }),
        })
      );
      await expect(sendRecall({ albumKey: "a", index: 0, includeSeed: true })).rejects.toThrow("boom");
    });
  });

  describe("sendUseRefImage", () => {
    afterEach(() => {
      delete global.fetch;
    });

    it("POSTs album_key / index to /invokeai/use_ref_image without include_seed", async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, uploaded_image_name: "abc.png" }),
        })
      );
      global.fetch = fetchMock;

      const result = await sendUseRefImage({ albumKey: "vacation", index: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("invokeai/use_ref_image");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({
        album_key: "vacation",
        index: 3,
      });
      expect(result.uploaded_image_name).toBe("abc.png");
    });
  });

  describe("button click handling", () => {
    beforeEach(() => {
      state.album = "fallback-album";
      document.body.innerHTML = `
        <a id="metadataLink" href="get_metadata/my-album/5"></a>
        <div class="invoke-recall-controls">
          <button type="button" class="invoke-recall-btn" data-recall-mode="recall">
            <span class="invoke-recall-status"></span>
          </button>
          <button type="button" class="invoke-recall-btn" data-recall-mode="remix">
            <span class="invoke-recall-status"></span>
          </button>
          <button type="button" class="invoke-recall-btn" data-recall-mode="use_ref">
            <span class="invoke-recall-status"></span>
          </button>
        </div>
      `;
    });

    afterEach(() => {
      delete global.fetch;
      document.body.innerHTML = "";
    });

    async function flushPromises() {
      // Two ticks: one for the fetch Promise, one for the .then() chain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it("shows a success checkmark on successful recall and forwards album/index", async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })
      );
      global.fetch = fetchMock;

      const recallButton = document.querySelector('[data-recall-mode="recall"]');
      recallButton.click();
      await flushPromises();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.album_key).toBe("my-album");
      expect(body.index).toBe(5);
      expect(body.include_seed).toBe(true);

      const status = recallButton.querySelector(".invoke-recall-status");
      expect(status.classList.contains("success")).toBe(true);
      expect(status.textContent).toBe("✓");
    });

    it("passes include_seed=false for the remix button", async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })
      );
      global.fetch = fetchMock;

      document.querySelector('[data-recall-mode="remix"]').click();
      await flushPromises();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.include_seed).toBe(false);
    });

    it("posts to /invokeai/use_ref_image when the use_ref button is clicked", async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })
      );
      global.fetch = fetchMock;

      document.querySelector('[data-recall-mode="use_ref"]').click();
      await flushPromises();

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("invokeai/use_ref_image");
      const body = JSON.parse(opts.body);
      expect(body.album_key).toBe("my-album");
      expect(body.index).toBe(5);
      expect(body.include_seed).toBeUndefined();
    });

    it("shows a red X on failure", async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ detail: "backend down" }),
        })
      );

      const btn = document.querySelector('[data-recall-mode="recall"]');
      btn.click();
      await flushPromises();

      const status = btn.querySelector(".invoke-recall-status");
      expect(status.classList.contains("error")).toBe(true);
      expect(status.querySelector("svg")).not.toBeNull();
    });
  });
});
