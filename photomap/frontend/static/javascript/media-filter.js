// media-filter.js
// The images/videos filter, applied everywhere it can be: the semantic map,
// the swiper, the grid view, and search results.
//
// The map has always drawn only the chosen media type (umap.js filters its own
// points). This module extends the same choice to browsing and search, both
// of which are sequenced entirely on the frontend from album indices — the
// backend has no "next slide" endpoint — so the classification has to be in
// hand before a slide is picked, not learned from /retrieve_image afterwards.
//
// It owns two things:
//   1. which album indices are videos, fetched from /media_indices on every
//      album change (a deletion is renumbered locally instead — slideState
//      does the same to the live list, and a refetch would force a rebuild of
//      the very slides the deletion path is careful to keep in place);
//   2. the derived views the rest of the app needs — a predicate over global
//      indices, a filter for result lists, and the "browse list": every index
//      the filter keeps, which search.js hands to the slide machinery as the
//      thing to browse when no search is active.
//
// It never imports search.js. search.js applies the filter, so the dependency
// has to run one way; changes are announced with a `mediaFilterChanged`
// window event that search.js listens for.

import { state } from "./state.js";
import { fetchJson } from "./utils.js";

let videoIndices = new Set();
let totalIndices = 0;
let loadedAlbum = null;
let loadSequence = 0;
// The album whose /media_indices fetch is in flight, or null. A filter change
// during the fetch must not announce from the previous album's set; the load
// announces when it lands.
let loadingAlbum = null;
// The effective filter most recently announced. Lets a settingsUpdated for
// some unrelated setting, or an album switch with the filter at "both", go by
// without a needless searchResultsChanged (which costs a full swiper rebuild).
let announcedFilter = "both";

// The filter that actually applies to the loaded album.
//
// "images" on an all-photo album keeps everything; "videos" on it keeps
// nothing. Either way there is nothing to filter, and a browse list would be
// a slower spelling of "the whole album" — or a blank screen. So the stored
// preference only takes effect on an album that has both kinds, which is also
// what the map's radio buttons require before they enable themselves.
export function effectiveMediaFilter() {
  const filter = state.mediaFilter;
  if (filter !== "images" && filter !== "videos") {
    return "both";
  }
  if (videoIndices.size === 0 || videoIndices.size >= totalIndices) {
    return "both";
  }
  return filter;
}

// Whether the active filter shows the album entry at `index`.
export function isIndexVisible(index) {
  const filter = effectiveMediaFilter();
  if (filter === "both") {
    return true;
  }
  return videoIndices.has(index) === (filter === "videos");
}

// `results` (any list of {index, ...}) restricted to the active filter. The
// same array comes back when no filter applies, so callers that rely on
// identity — setSearchResults hands the very array it was given to state —
// keep working unchanged.
export function filterSearchResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }
  if (effectiveMediaFilter() === "both") {
    return results;
  }
  return results.filter((r) => isIndexVisible(r?.index));
}

// Every index the active filter keeps, as {index} entries in album order, or
// null when no filter applies. The shape matches a search-result list so the
// swiper, grid, seek slider and shuffle bag can browse it with no special
// casing; search.js dispatches it under searchType "clear".
export function mediaBrowseList() {
  const filter = effectiveMediaFilter();
  if (filter === "both") {
    return null;
  }
  const wantVideos = filter === "videos";
  const list = [];
  for (let i = 0; i < totalIndices; i++) {
    if (videoIndices.has(i) === wantVideos) {
      list.push({ index: i });
    }
  }
  return list;
}

// Tell search.js to re-apply the filter. Skipped only when nothing is filtered
// now and nothing was before — when a filter is active, the underlying set may
// have changed (a reindex), so the browse list must be rebuilt even if the
// filter value is the same. `reason` says what changed ("filter", "album" or
// "refresh") so the listener can decide how much to redo.
function announce(reason) {
  const effective = effectiveMediaFilter();
  if (effective === "both" && announcedFilter === "both") {
    return;
  }
  announcedFilter = effective;
  window.dispatchEvent(new CustomEvent("mediaFilterChanged", { detail: { filter: effective, reason } }));
}

// Fetch which indices of `album` are videos, then announce. A load that is
// overtaken by a later one (two quick album switches) is dropped on arrival
// rather than applied to the wrong album.
export async function loadMediaIndices(album, reason = "album") {
  const sequence = ++loadSequence;
  loadingAlbum = album;
  let data = { total: 0, video_indices: [] };
  try {
    data = await fetchJson(`media_indices/${encodeURIComponent(album)}`);
  } catch (err) {
    // No index yet, or the server is away: fail open. An album with no known
    // videos is one the filter leaves alone.
    console.warn("Failed to load media indices; media filter is inactive:", err);
  }
  if (sequence !== loadSequence) {
    return;
  }
  loadingAlbum = null;
  videoIndices = new Set(data?.video_indices || []);
  totalIndices = data?.total || 0;
  loadedAlbum = album;
  announce(reason);
}

// Renumber the video set after `deletedIndices` were removed from the album,
// the same way slideState renumbers its list: drop the deleted entries and
// shift every later index down by the number deleted before it.
function applyDeletion(deletedIndices, totalImages) {
  const deleted = new Set(deletedIndices);
  const sorted = [...deletedIndices].sort((a, b) => a - b);
  const renumbered = new Set();
  for (const index of videoIndices) {
    if (deleted.has(index)) {
      continue;
    }
    let shift = 0;
    while (shift < sorted.length && sorted[shift] < index) {
      shift++;
    }
    renumbered.add(index - shift);
  }
  videoIndices = renumbered;
  totalIndices = typeof totalImages === "number" ? totalImages : Math.max(0, totalIndices - deleted.size);
}

// Test hook: the module's view of the album without a fetch.
export function _setMediaIndicesForTest({ album = null, total = 0, videoIndices: videos = [] } = {}) {
  loadedAlbum = album;
  loadingAlbum = null;
  totalIndices = total;
  videoIndices = new Set(videos);
  announcedFilter = "both";
}

window.addEventListener("albumChanged", (e) => {
  const detail = e.detail || {};
  const album = detail.album ?? state.album;
  if (detail.changeType === "deletion" && Array.isArray(detail.deletedIndices) && album === loadedAlbum) {
    // The live list has already been renumbered in place by slideState;
    // keep our set in step and stay quiet so nothing is rebuilt.
    applyDeletion(detail.deletedIndices, detail.totalImages);
    return;
  }
  if (detail.changeType !== "refresh") {
    // A different album starts from nothing applied: slideState has just
    // reset itself, so there is no old browse list to clear.
    announcedFilter = "both";
  }
  if (album) {
    loadMediaIndices(album, detail.changeType === "refresh" ? "refresh" : "album");
  }
});

// Fired by the mediaFilter setting's onSet hook in state.js — which runs for
// the user's radio click, and also when a server-side preference record is
// applied at boot, where no settingsUpdated event is dispatched.
window.addEventListener("mediaFilterSettingChanged", () => {
  if (loadingAlbum !== null) {
    // The set in hand belongs to the previous album. The load announces when
    // it lands, from the right set.
    return;
  }
  announce("filter");
});
