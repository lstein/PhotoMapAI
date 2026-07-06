/**
 * Tests for the index API helpers (index.js): updateIndex announces a newly
 * started run with the albumIndexStarted window event (consumed by the
 * semantic map's titlebar progress ring), and stays silent on failure.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(),
  HttpError: class HttpError extends Error {},
}));

const { fetchJson } = await import(`${M}/utils.js`);
const { updateIndex } = await import(`${M}/index.js`);

beforeEach(() => {
  fetchJson.mockReset();
  window.alert = jest.fn();
});

describe("updateIndex", () => {
  test("dispatches albumIndexStarted and returns the response on success", async () => {
    const response = { success: true, album_key: "alb" };
    fetchJson.mockResolvedValue(response);
    const started = [];
    const onStarted = (e) => started.push(e.detail.albumKey);
    window.addEventListener("albumIndexStarted", onStarted);
    try {
      const result = await updateIndex("alb");
      expect(result).toBe(response);
      expect(started).toEqual(["alb"]);
    } finally {
      window.removeEventListener("albumIndexStarted", onStarted);
    }
  });

  test("returns null and dispatches nothing when the request fails", async () => {
    fetchJson.mockRejectedValue(new Error("boom"));
    const started = [];
    const onStarted = (e) => started.push(e.detail.albumKey);
    window.addEventListener("albumIndexStarted", onStarted);
    try {
      const result = await updateIndex("alb");
      expect(result).toBeNull();
      expect(started).toEqual([]);
      expect(window.alert).toHaveBeenCalled();
    } finally {
      window.removeEventListener("albumIndexStarted", onStarted);
    }
  });
});
