// Tests for the preferences-client module.
//
// The module is intentionally small: GET + debounced PATCH + a flush hook.
// These tests stub global.fetch and walk the debounce manually with
// jest fake timers.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
  SERVER_TIMESTAMP_KEY,
  _peekPendingKeys,
  _resetPreferencesClientForTests,
  cancelPendingPatches,
  fetchPreferences,
  flushPendingPatches,
  loadServerTimestamp,
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

function mockNotOk(status) {
  return { ok: false, status, json: () => Promise.resolve({}) };
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

  describe("fetchPreferences", () => {
    it("returns the parsed JSON body on success", async () => {
      global.fetch.mockResolvedValueOnce(mockOkJson({ currentDelay: 7, mode: "random", updatedAt: 12.5 }));
      const result = await fetchPreferences();
      expect(result).toEqual({ currentDelay: 7, mode: "random", updatedAt: 12.5 });
      expect(global.fetch).toHaveBeenCalledWith("preferences/", {
        credentials: "same-origin",
      });
    });

    it("returns null on non-ok response", async () => {
      global.fetch.mockResolvedValueOnce(mockNotOk(500));
      expect(await fetchPreferences()).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      global.fetch.mockRejectedValueOnce(new Error("network down"));
      expect(await fetchPreferences()).toBeNull();
    });
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
      expect(JSON.parse(init.body)).toEqual({ currentDelay: 12, mode: "random" });
    });

    it("records the server-returned updatedAt in localStorage", async () => {
      global.fetch.mockResolvedValueOnce(mockOkJson({ updatedAt: 42.5 }));
      queuePreferencePatch({ currentDelay: 9 });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await flushPendingPatches();

      expect(loadServerTimestamp()).toBe(42.5);
      expect(localStorage.getItem(SERVER_TIMESTAMP_KEY)).toBe("42.5");
    });

    it("does not record a timestamp when the PATCH fails", async () => {
      global.fetch.mockResolvedValueOnce(mockNotOk(503));
      queuePreferencePatch({ currentDelay: 9 });
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await flushPendingPatches();
      expect(localStorage.getItem(SERVER_TIMESTAMP_KEY)).toBeNull();
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
      expect(loadServerTimestamp()).toBe(5.0);
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

  describe("cancelPendingPatches", () => {
    it("drops queued partials without firing the network request", async () => {
      queuePreferencePatch({ currentDelay: 33 });
      cancelPendingPatches();

      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
      await flushPendingPatches();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(_peekPendingKeys()).toEqual([]);
    });
  });

  describe("loadServerTimestamp", () => {
    it("returns 0 when nothing is stored", () => {
      expect(loadServerTimestamp()).toBe(0);
    });

    it("returns 0 for a corrupt value", () => {
      localStorage.setItem(SERVER_TIMESTAMP_KEY, "not-a-number");
      expect(loadServerTimestamp()).toBe(0);
    });

    it("returns the stored float", () => {
      localStorage.setItem(SERVER_TIMESTAMP_KEY, "12.5");
      expect(loadServerTimestamp()).toBe(12.5);
    });
  });
});
