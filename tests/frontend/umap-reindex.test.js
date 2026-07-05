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
}));
jest.unstable_mockModule(`${M}/state.js`, () => ({
  state: { album: "alb" },
}));
jest.unstable_mockModule(`${M}/utils.js`, () => ({
  fetchJson: jest.fn(),
}));

const { updateIndex } = await import(`${M}/index.js`);
const { state } = await import(`${M}/state.js`);
const { fetchJson } = await import(`${M}/utils.js`);
const { reindexConfig, startUmapReindex, checkUmapReindexOngoing } = await import(`${M}/umap-reindex.js`);

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
    const events = [];
    const onUpdated = (e) => events.push(e.detail.albumKey);
    window.addEventListener("albumIndexUpdated", onUpdated);
    try {
      await startUmapReindex();
      expect(updateIndex).toHaveBeenCalledWith("alb");
      expect(document.getElementById("umapReindexBtn").style.display).toBe("none");
      expect(document.getElementById("umapReindexProgress").style.display).toBe("inline-flex");

      await waitForButtonRestore();
      expect(events).toEqual(["alb"]);
      expect(document.getElementById("umapReindexProgress").style.display).toBe("none");
    } finally {
      window.removeEventListener("albumIndexUpdated", onUpdated);
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
