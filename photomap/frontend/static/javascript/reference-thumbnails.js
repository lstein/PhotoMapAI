// reference-thumbnails.js
// Enhances the metadata drawer's rendered InvokeAI table by replacing
// reference-image filenames with clickable thumbnails for images that are
// present in the current album. Filenames not in the album are left as the
// plain text the formatter already rendered.

import { slideState } from "./slide-state.js";

// Parse the slide dataset's reference_images attribute (a JSON-stringified
// list of filenames as written by the slide loader) into an array.
// Returns [] for anything missing or malformed.
export function parseReferenceImages(referenceImages) {
  if (!referenceImages) {
    return [];
  }
  if (Array.isArray(referenceImages)) {
    return referenceImages.filter((s) => typeof s === "string" && s);
  }
  if (typeof referenceImages !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(referenceImages);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string" && s) : [];
  } catch (e) {
    console.warn("Failed to parse reference_images:", e);
    return [];
  }
}

// Tracks the most recent enhancement request so stale fetches whose slide
// has since changed are discarded rather than mutating the new slide's DOM.
let _refThumbsFetchToken = 0;

// Walk a rendered metadata description and turn every reference-image
// filename cell into a clickable thumbnail block when that filename is
// present in the current album. Filenames not in the album are left as
// plain text. Safe to call without awaiting; race protection is built in.
export async function enhanceReferenceImageThumbnails(container, referenceImages, albumKey, { fetchImpl } = {}) {
  if (!container || !albumKey) {
    return;
  }
  const imageList = parseReferenceImages(referenceImages);
  if (imageList.length === 0) {
    return;
  }

  const wanted = new Set(imageList);
  const matches = collectReferenceFilenameNodes(container, wanted);
  if (matches.length === 0) {
    return;
  }

  _refThumbsFetchToken += 1;
  const myToken = _refThumbsFetchToken;

  const doFetch = fetchImpl || globalThis.fetch;
  let indices;
  try {
    const resp = await doFetch(`image_indices/${encodeURIComponent(albumKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filenames: Array.from(wanted) }),
    });
    if (!resp.ok) {
      return;
    }
    const body = await resp.json();
    indices = body.indices || {};
  } catch (e) {
    console.warn("Reference-image index lookup failed:", e);
    return;
  }

  // Slide changed mid-fetch: bail out so we don't graft thumbnails onto a
  // DOM that has been rewritten for a different image.
  if (myToken !== _refThumbsFetchToken) {
    return;
  }

  for (const { node, filename } of matches) {
    const index = indices[filename];
    if (typeof index !== "number") {
      continue;
    }
    const thumb = buildReferenceThumbnail(albumKey, index, filename);
    const cell = node.parentNode;
    if (cell) {
      cell.replaceChild(thumb, node);
    }
  }
}

// Find text nodes inside the InvokeAI metadata sub-tables (`.invoke-tuples`)
// whose trimmed value exactly equals one of the wanted filenames. The full
// trimmed-match constraint keeps us from rewriting prompt or note cells
// that happen to mention the same string.
export function collectReferenceFilenameNodes(container, wanted) {
  const cells = container.querySelectorAll(".invoke-tuples td");
  const results = [];
  cells.forEach((cell) => {
    if (cell.childNodes.length !== 1) {
      return;
    }
    const node = cell.firstChild;
    if (node.nodeType !== 3 /* Node.TEXT_NODE */) {
      return;
    }
    const filename = node.nodeValue.trim();
    if (wanted.has(filename)) {
      results.push({ node, filename });
    }
  });
  return results;
}

export function buildReferenceThumbnail(albumKey, index, filename) {
  const link = document.createElement("a");
  link.href = "#";
  link.className = "ref-image-thumb";
  link.dataset.globalIndex = String(index);
  link.title = `Show ${filename}`;

  const img = document.createElement("img");
  img.src = `thumbnails/${encodeURIComponent(albumKey)}/${index}?size=128`;
  img.alt = filename;
  img.loading = "lazy";

  const caption = document.createElement("div");
  caption.className = "ref-image-thumb-caption";
  caption.textContent = filename;

  link.appendChild(img);
  link.appendChild(caption);
  return link;
}

// Document-level delegated click handler. Activates a thumbnail click no
// matter where it sits in the page, so the rewritten innerHTML in
// updateMetadataOverlay does not require re-binding listeners per slide.
export function registerReferenceThumbnailClickHandler() {
  document.addEventListener("click", (e) => {
    const thumb = e.target.closest(".ref-image-thumb");
    if (!thumb) {
      return;
    }
    e.preventDefault();
    const index = parseInt(thumb.dataset.globalIndex, 10);
    if (Number.isFinite(index)) {
      slideState.navigateToIndex(index, false);
    }
  });
}
