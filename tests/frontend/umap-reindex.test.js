/**
 * Tests for the semantic-map titlebar reindex button (umap-reindex.js):
 * button/ring swap, progress-ring updates from polled status, attaching to
 * an already-running update, error recovery, and the albumIndexUpdated
 * completion event that triggers the map reload.
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const M = "../../photomap/frontend/static/javascript";

jest.unstable_mockModule(`${M}/index.js`, () => ({
  updateIndex: jest.fn(),
  getIndexMetadata: jest.fn(),
}));
jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "alb" },
}));
jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(),
}));

const { updateIndex, getIndexMetadata } = await import(`${M}/index.js`);
const { state } = await import(`${M}/state.js`);
const { fetchJson } = await import(`${M}/utils.js`);
const { reindexConfig, startUmapReindex, checkUmapReindexOngoing, initUmapReindexButton } = await import(
  `${M}/umap-reindex.js`
);

reindexConfig.pollInterval = 5;

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

function buildDom() {
  document.body.innerHTML = `
    <button id="umapReindexBtn">🔄</button>
    <span id="umapReindexProgress" style="display: none">
      <svg><circle id="umapReindexRing" /></svg>
    </span>`;
}

async function waitForButtonRestore() {
  for (let i = 0; i < 40; i++) {
    await flush();
    if (document.getElementById("umapReindexBtn").style.display === "") {
      return;
    }
  }
  throw new Error("button never restored");
}

beforeEach(async () => {
  buildDom();
  updateIndex.mockReset();
  fetchJson.mockReset();
  getIndexMetadata.mockReset();
  getIndexMetadata.mockResolvedValue({ filename_count: 100 });
  state.album = "alb";
  // Drain any poller left over from a previous test.
  fetchJson.mockResolvedValue({ status: "completed" });
  await flush();
});

describe("startUmapReindex", () => {
  test("starts an update, swaps to the ring, and restores on completion", async () => {
    const statuses = [
      { status: "idle" }, // pre-start guard check
      { status: "indexing", progress_percentage: 50, current_step: "Indexing images" },
      { status: "completed" },
    ];
    fetchJson.mockImplementation(() => Promise.resolve(statuses.shift() ?? { status: "completed" }));
    updateIndex.mockResolvedValue({ success: true });
    getIndexMetadata.mockResolvedValue({ filename_count: 42 });
    const events = [];
    const albumChangedEvents = [];
    const onUpdated = (e) => events.push(e.detail.albumKey);
    const onAlbumChanged = (e) => albumChangedEvents.push(e.detail);
    window.addEventListener("albumIndexUpdated", onUpdated);
    window.addEventListener("albumChanged", onAlbumChanged);
    try {
      await startUmapReindex();
      expect(updateIndex).toHaveBeenCalledWith("alb");
      expect(document.getElementById("umapReindexBtn").style.display).toBe("none");
      expect(document.getElementById("umapReindexProgress").style.display).toBe("inline-flex");

      await waitForButtonRestore();
      expect(events).toEqual(["alb"]);
      expect(document.getElementById("umapReindexProgress").style.display).toBe("none");

      // The slideshow/grid refresh: an in-place albumChanged carrying the
      // fresh image count, so slides rebuild without losing position.
      await flush();
      expect(albumChangedEvents).toEqual([{ album: "alb", totalImages: 42, changeType: "refresh" }]);
    } finally {
      window.removeEventListener("albumIndexUpdated", onUpdated);
      window.removeEventListener("albumChanged", onAlbumChanged);
    }
  });

  test("attaches to an already-running update instead of starting one", async () => {
    fetchJson.mockResolvedValueOnce({ status: "scanning", current_step: "Traversing image files..." });
    fetchJson.mockResolvedValue({ status: "completed" });

    await startUmapReindex();

    expect(updateIndex).not.toHaveBeenCalled();
    expect(document.getElementById("umapReindexProgress").style.display).toBe("inline-flex");
    await waitForButtonRestore();
  });

  test("failed start (updateIndex null) leaves the plain button in place", async () => {
    fetchJson.mockResolvedValue({ status: "idle" });
    updateIndex.mockResolvedValue(null);

    await startUmapReindex();

    expect(document.getElementById("umapReindexBtn").style.display).toBe("");
    expect(document.getElementById("umapReindexProgress").style.display).toBe("none");
  });

  test("error status restores the button and surfaces the message in its title", async () => {
    fetchJson.mockResolvedValueOnce({ status: "idle" });
    fetchJson.mockResolvedValue({ status: "error", error_message: "boom" });
    updateIndex.mockResolvedValue({ success: true });

    await startUmapReindex();
    await waitForButtonRestore();

    expect(document.getElementById("umapReindexBtn").title).toContain("boom");
  });
});

describe("progress ring rendering", () => {
  test("shows phase colour, fill fraction, and hover title from the poll", async () => {
    fetchJson.mockResolvedValueOnce({ status: "idle" });
    fetchJson.mockResolvedValueOnce({
      status: "mapping",
      progress_percentage: 75,
      current_step: "Generating image map...",
    });
    fetchJson.mockResolvedValue({ status: "completed" });
    updateIndex.mockResolvedValue({ success: true });

    await startUmapReindex();
    await flush();

    const ring = document.getElementById("umapReindexRing");
    const progress = document.getElementById("umapReindexProgress");
    expect(ring.style.stroke).toBe("#2196f3"); // mapping = blue, as in Album Manager
    // 75% fill: dashoffset = C * 0.25
    expect(Number.parseFloat(ring.style.strokeDashoffset)).toBeCloseTo(50.27 * 0.25, 1);
    expect(progress.title).toBe("Generating image map... (75%)");
    await waitForButtonRestore();
  });

  test("scanning phase renders as an indeterminate spinning arc", async () => {
    fetchJson.mockResolvedValueOnce({ status: "idle" });
    fetchJson.mockResolvedValueOnce({
      status: "scanning",
      progress_percentage: 100,
      current_step: "Traversing image files... 5000 found",
    });
    fetchJson.mockResolvedValue({ status: "completed" });
    updateIndex.mockResolvedValue({ success: true });

    await startUmapReindex();
    await flush();

    const progress = document.getElementById("umapReindexProgress");
    expect(progress.classList.contains("indeterminate")).toBe(true);
    expect(progress.title).toBe("Traversing image files... 5000 found");
    await waitForButtonRestore();
  });
});

describe("checkUmapReindexOngoing", () => {
  test("shows the ring when the backend reports a run, stays idle otherwise", async () => {
    fetchJson.mockResolvedValueOnce({ status: "indexing", progress_percentage: 10 });
    fetchJson.mockResolvedValue({ status: "completed" });

    await checkUmapReindexOngoing();
    expect(document.getElementById("umapReindexProgress").style.display).toBe("inline-flex");
    await waitForButtonRestore();

    fetchJson.mockResolvedValue({ status: "idle" });
    await checkUmapReindexOngoing();
    expect(document.getElementById("umapReindexProgress").style.display).toBe("none");
  });
});

// Keep this block last: initUmapReindexButton registers persistent window
// listeners that would otherwise react to events dispatched by other tests.
describe("albumIndexStarted from another control (e.g. Album Manager)", () => {
  test("raises the ring for the current album and tracks the run to completion", async () => {
    initUmapReindexButton();
    fetchJson.mockResolvedValue({ status: "indexing", progress_percentage: 30 });

    // A run on some other album must not touch this ring.
    window.dispatchEvent(new CustomEvent("albumIndexStarted", { detail: { albumKey: "other-album" } }));
    await flush();
    expect(document.getElementById("umapReindexProgress").style.display).toBe("none");

    window.dispatchEvent(new CustomEvent("albumIndexStarted", { detail: { albumKey: "alb" } }));
    expect(document.getElementById("umapReindexProgress").style.display).toBe("inline-flex");
    expect(document.getElementById("umapReindexBtn").style.display).toBe("none");

    fetchJson.mockResolvedValue({ status: "completed" });
    await waitForButtonRestore();
  });
});
