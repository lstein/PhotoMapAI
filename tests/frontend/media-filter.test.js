// media-filter.js: the images/videos filter's view of an album.
//
// The pure helpers (effective filter, visibility, browse list) and the two
// event-driven paths that keep them current — an album change fetching
// /media_indices, and a deletion renumbering locally without a refetch.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const JS = "../../photomap/frontend/static/javascript";

const mockState = { album: "alb", mediaFilter: "both" };
const fetchJson = jest.fn();

jest.unstable_mockModule(`${JS}/state.js`, () => ({ state: mockState }));
jest.unstable_mockModule(`${JS}/utils.js`, () => ({ fetchJson }));

const mf = await import(`${JS}/media-filter.js`);

// An album of 6 entries where 1 and 4 are videos.
const MIXED = { album: "alb", total: 6, videoIndices: [1, 4] };

let announced;
let reasons;
const onChanged = (e) => {
  announced.push(e.detail.filter);
  reasons.push(e.detail.reason);
};

beforeEach(() => {
  announced = [];
  reasons = [];
  window.addEventListener("mediaFilterChanged", onChanged);
  fetchJson.mockReset();
  mockState.album = "alb";
  mockState.mediaFilter = "both";
  mf._setMediaIndicesForTest(MIXED);
});

afterEach(() => {
  window.removeEventListener("mediaFilterChanged", onChanged);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("effectiveMediaFilter", () => {
  it("is the stored preference on an album with both kinds", () => {
    mockState.mediaFilter = "videos";
    expect(mf.effectiveMediaFilter()).toBe("videos");
    mockState.mediaFilter = "images";
    expect(mf.effectiveMediaFilter()).toBe("images");
  });

  it("is both on an album with no videos, whatever is stored", () => {
    mf._setMediaIndicesForTest({ album: "alb", total: 6, videoIndices: [] });
    mockState.mediaFilter = "videos";
    expect(mf.effectiveMediaFilter()).toBe("both");
    mockState.mediaFilter = "images";
    expect(mf.effectiveMediaFilter()).toBe("both");
  });

  it("is both on an album that is all videos", () => {
    mf._setMediaIndicesForTest({ album: "alb", total: 2, videoIndices: [0, 1] });
    mockState.mediaFilter = "images";
    expect(mf.effectiveMediaFilter()).toBe("both");
  });

  it("fails open on a value it does not recognise", () => {
    mockState.mediaFilter = "audio";
    expect(mf.effectiveMediaFilter()).toBe("both");
  });
});

describe("isIndexVisible / filterSearchResults / mediaBrowseList", () => {
  it("show everything with no filter", () => {
    const results = [{ index: 1 }, { index: 2 }];
    expect(mf.isIndexVisible(1)).toBe(true);
    expect(mf.filterSearchResults(results)).toBe(results); // identity, not a copy
    expect(mf.mediaBrowseList()).toBeNull();
  });

  it("keep only videos under Videos", () => {
    mockState.mediaFilter = "videos";
    expect(mf.isIndexVisible(1)).toBe(true);
    expect(mf.isIndexVisible(2)).toBe(false);
    expect(
      mf.filterSearchResults([
        { index: 0, score: 1 },
        { index: 4, score: 0.5 },
      ])
    ).toEqual([{ index: 4, score: 0.5 }]);
    expect(mf.mediaBrowseList()).toEqual([{ index: 1 }, { index: 4 }]);
  });

  it("keep only images under Images", () => {
    mockState.mediaFilter = "images";
    expect(mf.mediaBrowseList()).toEqual([{ index: 0 }, { index: 2 }, { index: 3 }, { index: 5 }]);
  });

  it("tolerate a non-array result list", () => {
    expect(mf.filterSearchResults(undefined)).toEqual([]);
  });
});

describe("mediaFilterSettingChanged", () => {
  it("announces when the filter setting changes", () => {
    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    expect(announced).toEqual(["videos"]);
  });

  it("announces once more when the filter goes back to both", () => {
    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    mockState.mediaFilter = "both";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "both" } }));
    expect(announced).toEqual(["videos", "both"]);
  });

  it("stays quiet when nothing is filtered and nothing was", () => {
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "both" } }));
    expect(announced).toEqual([]);
  });

  it("says the filter changed", () => {
    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    expect(reasons).toEqual(["filter"]);
  });

  it("waits for an in-flight album load rather than announcing the old album's set", async () => {
    let resolveLoad;
    fetchJson.mockImplementationOnce(() => new Promise((resolve) => (resolveLoad = resolve)));
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 3 } }));

    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    expect(announced).toEqual([]);

    resolveLoad({ total: 3, video_indices: [2] });
    await flush();
    expect(announced).toEqual(["videos"]);
    expect(mf.mediaBrowseList()).toEqual([{ index: 2 }]);
  });
});

describe("albumChanged", () => {
  it("fetches the new album's media indices and applies the filter", async () => {
    mockState.mediaFilter = "videos";
    fetchJson.mockResolvedValueOnce({ total: 3, video_indices: [2] });

    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 3 } }));
    await flush();

    expect(fetchJson).toHaveBeenCalledWith("media_indices/other");
    expect(mf.mediaBrowseList()).toEqual([{ index: 2 }]);
    expect(announced).toEqual(["videos"]);
    expect(reasons).toEqual(["album"]);
  });

  it("does not announce for an album switch with the filter at both", async () => {
    // An extra searchResultsChanged here would rebuild the swiper twice.
    fetchJson.mockResolvedValueOnce({ total: 3, video_indices: [2] });
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 3 } }));
    await flush();
    expect(announced).toEqual([]);
  });

  it("fails open when the fetch fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockState.mediaFilter = "videos";
    fetchJson.mockRejectedValueOnce(new Error("404"));
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "other", totalImages: 0 } }));
    await flush();
    expect(mf.effectiveMediaFilter()).toBe("both");
    expect(announced).toEqual([]);
    console.warn.mockRestore();
  });

  it("drops a fetch that a later album switch overtook", async () => {
    mockState.mediaFilter = "videos";
    let resolveFirst;
    fetchJson.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    fetchJson.mockResolvedValueOnce({ total: 2, video_indices: [0] });

    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "first", totalImages: 9 } }));
    window.dispatchEvent(new CustomEvent("albumChanged", { detail: { album: "second", totalImages: 2 } }));
    await flush();
    resolveFirst({ total: 9, video_indices: [0, 1, 2, 3] });
    await flush();

    expect(mf.mediaBrowseList()).toEqual([{ index: 0 }]);
  });

  it("re-announces after an in-place reindex so the browse list is rebuilt", async () => {
    mockState.mediaFilter = "videos";
    window.dispatchEvent(new CustomEvent("mediaFilterSettingChanged", { detail: { value: "videos" } }));
    fetchJson.mockResolvedValueOnce({ total: 8, video_indices: [1, 4, 7] });

    window.dispatchEvent(
      new CustomEvent("albumChanged", { detail: { album: "alb", totalImages: 8, changeType: "refresh" } })
    );
    await flush();

    expect(mf.mediaBrowseList()).toEqual([{ index: 1 }, { index: 4 }, { index: 7 }]);
    expect(announced).toEqual(["videos", "videos"]);
    expect(reasons).toEqual(["filter", "refresh"]);
  });

  it("renumbers locally after a deletion, without a fetch or an announcement", () => {
    mockState.mediaFilter = "videos";
    // Delete image 0 and video 4: the remaining video (1) shifts to 0.
    window.dispatchEvent(
      new CustomEvent("albumChanged", {
        detail: { album: "alb", totalImages: 4, changeType: "deletion", deletedIndices: [0, 4] },
      })
    );

    expect(fetchJson).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
    expect(mf.mediaBrowseList()).toEqual([{ index: 0 }]);
    mockState.mediaFilter = "images";
    expect(mf.mediaBrowseList()).toEqual([{ index: 1 }, { index: 2 }, { index: 3 }]);
  });
});
