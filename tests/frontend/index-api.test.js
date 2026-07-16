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
const { deleteImages, updateIndex } = await import(`${M}/index.js`);

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

describe("deleteImages", () => {
  test("posts the whole batch in one request and returns the summary", async () => {
    const response = { success: true, deleted_count: 3, deleted_indices: [1, 5, 9] };
    fetchJson.mockResolvedValue(response);

    const result = await deleteImages("my album", [1, 5, 9], false);

    expect(result).toBe(response);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith("delete_images/my%20album", {
      json: { indices: [1, 5, 9], move_to_trash: false },
    });
  });

  test("defaults move_to_trash to true and rethrows failures", async () => {
    fetchJson.mockRejectedValue(new Error("boom"));

    await expect(deleteImages("alb", [0])).rejects.toThrow("boom");
    expect(fetchJson).toHaveBeenCalledWith("delete_images/alb", {
      json: { indices: [0], move_to_trash: true },
    });
  });
});
