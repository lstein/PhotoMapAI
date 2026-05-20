// Unit tests for reference-thumbnails.js
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Mock slide-state.js so its transitive imports (state.js → album-manager.js
// → settings.js → umap.js) don't pull DOM-side-effect modules into the
// import graph for this unit test.
jest.unstable_mockModule("../../photomap/frontend/static/javascript/slide-state.js", () => ({
  slideState: {
    navigateToIndex: jest.fn(),
  },
}));

const {
  buildReferenceThumbnail,
  collectReferenceFilenameNodes,
  enhanceReferenceImageThumbnails,
  parseReferenceImages,
} = await import("../../photomap/frontend/static/javascript/reference-thumbnails.js");

describe("parseReferenceImages", () => {
  it("returns [] for empty inputs", () => {
    expect(parseReferenceImages(null)).toEqual([]);
    expect(parseReferenceImages(undefined)).toEqual([]);
    expect(parseReferenceImages("")).toEqual([]);
    expect(parseReferenceImages([])).toEqual([]);
  });

  it("parses JSON string input", () => {
    expect(parseReferenceImages('["a.png","b.jpg"]')).toEqual(["a.png", "b.jpg"]);
  });

  it("passes through array input", () => {
    expect(parseReferenceImages(["a.png", "b.jpg"])).toEqual(["a.png", "b.jpg"]);
  });

  it("filters non-string entries", () => {
    expect(parseReferenceImages(["a.png", 42, null, "b.jpg", ""])).toEqual(["a.png", "b.jpg"]);
  });

  it("returns [] for malformed JSON without throwing", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseReferenceImages("{not json")).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns [] when JSON parses to a non-array", () => {
    expect(parseReferenceImages('{"x":1}')).toEqual([]);
  });
});

describe("collectReferenceFilenameNodes", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("matches single-text-node cells whose trimmed text equals a wanted filename", () => {
    container.innerHTML = `
      <table class="invoke-tuples">
        <tr><td>ip-adapter</td><td>ref-1.png</td><td>0.7</td></tr>
        <tr><td>ip-adapter</td><td>  ref-2.png  </td><td>0.5</td></tr>
      </table>
    `;
    const matches = collectReferenceFilenameNodes(container, new Set(["ref-1.png", "ref-2.png", "not-present.png"]));
    expect(matches.map((m) => m.filename)).toEqual(["ref-1.png", "ref-2.png"]);
  });

  it("ignores cells with multiple child nodes", () => {
    container.innerHTML = `
      <table class="invoke-tuples">
        <tr><td>ref-1.png<span> extra</span></td></tr>
      </table>
    `;
    expect(collectReferenceFilenameNodes(container, new Set(["ref-1.png"]))).toEqual([]);
  });

  it("ignores cells outside .invoke-tuples tables (e.g. prompt cells)", () => {
    container.innerHTML = `
      <table class="invoke-metadata">
        <tr><th>Prompt</th><td class="copyme">ref-1.png</td></tr>
      </table>
    `;
    expect(collectReferenceFilenameNodes(container, new Set(["ref-1.png"]))).toEqual([]);
  });
});

describe("buildReferenceThumbnail", () => {
  it("creates a clickable anchor with thumbnail and caption", () => {
    const link = buildReferenceThumbnail("my album", 42, "ref-1.png");
    expect(link.tagName).toBe("A");
    expect(link.classList.contains("ref-image-thumb")).toBe(true);
    expect(link.dataset.globalIndex).toBe("42");
    expect(link.title).toBe("Show ref-1.png");

    const img = link.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.alt).toBe("ref-1.png");
    // Album key must be URL-encoded so spaces don't break the URL.
    expect(img.src).toContain("/thumbnails/my%20album/42");
    expect(img.src).toContain("size=128");
    expect(img.loading).toBe("lazy");

    const caption = link.querySelector(".ref-image-thumb-caption");
    expect(caption).not.toBeNull();
    expect(caption.textContent).toBe("ref-1.png");
  });
});

describe("enhanceReferenceImageThumbnails", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
    container.innerHTML = `
      <table class="invoke-metadata">
        <tr><th>Reference Images</th><td>
          <table class="invoke-tuples">
            <tr><td>ip-adapter</td><td>in-album.png</td><td>0.7</td></tr>
            <tr><td>ip-adapter</td><td>missing.png</td><td>0.5</td></tr>
          </table>
        </td></tr>
      </table>
    `;
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  it("replaces in-album filename cells with clickable thumbnails", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ indices: { "in-album.png": 7, "missing.png": null } }),
    });

    await enhanceReferenceImageThumbnails(container, ["in-album.png", "missing.png"], "test_album", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "image_indices/test_album",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.filenames.sort()).toEqual(["in-album.png", "missing.png"]);

    const thumbs = container.querySelectorAll("a.ref-image-thumb");
    expect(thumbs.length).toBe(1);
    expect(thumbs[0].dataset.globalIndex).toBe("7");

    // The missing entry remains as the original text node.
    const cells = container.querySelectorAll(".invoke-tuples td");
    const missingCell = Array.from(cells).find((c) => c.textContent.trim() === "missing.png");
    expect(missingCell).not.toBeUndefined();
    expect(missingCell.querySelector("a.ref-image-thumb")).toBeNull();
  });

  it("skips the network call when none of the wanted filenames are rendered", async () => {
    const fetchImpl = jest.fn();
    await enhanceReferenceImageThumbnails(container, ["nothing-here.png"], "test_album", { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(container.querySelectorAll("a.ref-image-thumb").length).toBe(0);
  });

  it("returns silently when the request fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = jest.fn().mockRejectedValue(new Error("network"));
    await enhanceReferenceImageThumbnails(container, ["in-album.png"], "test_album", { fetchImpl });
    expect(container.querySelectorAll("a.ref-image-thumb").length).toBe(0);
  });

  it("does nothing when albumKey is missing", async () => {
    const fetchImpl = jest.fn();
    await enhanceReferenceImageThumbnails(container, ["in-album.png"], "", { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when referenceImages is empty", async () => {
    const fetchImpl = jest.fn();
    await enhanceReferenceImageThumbnails(container, [], "test_album", { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
