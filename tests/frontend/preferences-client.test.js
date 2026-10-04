// Tests for the preferences-client module.
//
// The module is intentionally small: a debounced PATCH + a flush hook.
// These tests stub global.fetch and walk the debounce manually with
// jest fake timers.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
  _peekPendingKeys,
  _resetPreferencesClientForTests,
  _peekPending,
  closePreferencePatches,
  flushPendingPatches,
  queuePreferencePatch,
} from "../../photomap/frontend/static/javascript/preferences-client.js";

const DEBOUNCE_MS = 500;

function mockOkJson(body) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

describe("preferences-client", () => {
  beforeEach(() => {
    _resetPreferencesClientForTests();
    localStorage.clear();
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
  });

  describe("queuePreferencePatch (debounced)", () => {
    it("does not call fetch until the debounce window elapses", () => {
      queuePreferencePatch({ currentDelay: 9 });
      expect(global.fetch).not.toHaveBeenCalled();

      jest.advanceTimersByTime(DEBOUNCE_MS - 1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("merges multiple calls into a single PATCH", async () => {
      global.fetch.mockResolvedValue(mockOkJson({ updatedAt: 1.0 }));

      queuePreferencePatch({ currentDelay: 9 });
      queuePreferencePatch({ mode: "random" });
      queuePreferencePatch({ currentDelay: 12 }); // overrides the first
      expect(_peekPendingKeys()).toEqual(["currentDelay", "mode"]);

      jest.advanceTimersByTime(DEBOUNCE_MS);
      // Let the chained promises resolve.
      await flushPendingPatches();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe("preferences/");
      expect(init.method).toBe("PATCH");
      expect(init.credentials).toBe("same-origin");
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
      // Survives iOS suspending the page right after visibilitychange:hidden.
      expect(init.keepalive).toBe(true);
      expect(JSON.parse(init.body)).toEqual({ currentDelay: 12, mode: "random" });
    });

    it("swallows fetch errors without breaking subsequent queues", async () => {
      global.fetch.mockRejectedValueOnce(new Error("boom"));
      queuePreferencePatch({ currentDelay: 9 });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await flushPendingPatches();

      // Next PATCH still works.
      global.fetch.mockResolvedValueOnce(mockOkJson({ updatedAt: 5.0 }));
      queuePreferencePatch({ currentDelay: 10 });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await flushPendingPatches();

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("flushPendingPatches", () => {
    it("fires a pending PATCH immediately without waiting for the debounce", async () => {
      global.fetch.mockResolvedValueOnce(mockOkJson({ updatedAt: 1.0 }));
      queuePreferencePatch({ currentDelay: 11 });

      // Don't advance the timer — flush should fire the PATCH anyway.
      await flushPendingPatches();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when nothing is pending", async () => {
      await flushPendingPatches();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("closePreferencePatches", () => {
    it("drops queued partials and refuses new ones", async () => {
      queuePreferencePatch({ currentDelay: 33 });
      await closePreferencePatches();
      queuePreferencePatch({ lastSlideIndex: { a: 4 } });

      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
      await flushPendingPatches();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(_peekPendingKeys()).toEqual([]);
    });
  });

  describe("merging", () => {
    it("merges the per-album slide map instead of replacing it", () => {
      queuePreferencePatch({ lastSlideIndex: { a: 1 } });
      queuePreferencePatch({ lastSlideIndex: { b: 2 } });
      queuePreferencePatch({ lastSlideIndex: { a: 3 } });
      expect(_peekPending()).toEqual({ lastSlideIndex: { a: 3, b: 2 } });
    });
  });

  describe("failures", () => {
    it("retries a PATCH the network dropped", async () => {
      global.fetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(mockOkJson({}));
      queuePreferencePatch({ moveToTrash: false });
      await flushPendingPatches();
      expect(_peekPending()).toEqual({ moveToTrash: false });

      await flushPendingPatches(); // fires the scheduled retry now
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ moveToTrash: false });
      expect(_peekPendingKeys()).toEqual([]);
    });

    it("retries on a server error, keeping newer values for the same key", async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(mockOkJson({}));
      queuePreferencePatch({ currentDelay: 4, mode: "random" });
      await flushPendingPatches();
      queuePreferencePatch({ currentDelay: 9 });
      await flushPendingPatches();

      expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ currentDelay: 9, mode: "random" });
    });

    it("resends a refused batch key by key, dropping only the bad value", async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false, status: 422 })
        .mockResolvedValueOnce({ ok: false, status: 422 })
        .mockResolvedValueOnce(mockOkJson({}));
      queuePreferencePatch({ currentDelay: 5000, moveToTrash: false });
      await flushPendingPatches();

      const bodies = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
      expect(bodies).toEqual([
        { currentDelay: 5000, moveToTrash: false },
        { currentDelay: 5000 },
        { moveToTrash: false },
      ]);
      // The refused value is not retried forever.
      expect(_peekPendingKeys()).toEqual([]);
    });

    it("never has two PATCHes in the air at once", async () => {
      let release;
      global.fetch.mockImplementationOnce(() => new Promise((r) => (release = r))).mockResolvedValue(mockOkJson({}));
      queuePreferencePatch({ lastSlideIndex: { a: 1 } });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await Promise.resolve(); // let the first flush take the queue and send
      expect(global.fetch).toHaveBeenCalledTimes(1);
      queuePreferencePatch({ lastSlideIndex: { a: 2 } });
      const second = flushPendingPatches();
      await Promise.resolve();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      release(mockOkJson({}));
      await second;
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
