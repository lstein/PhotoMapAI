// search.js
// This file contains functions to interact with the backend API to search and retrieve images.
import { effectiveMediaFilter, filterSearchResults, mediaBrowseList } from "./media-filter.js";
import { state } from "./state.js";
import { fetchJson, hideSpinner, showSpinner, showToast } from "./utils.js";

// Tracks the AbortController of the in-flight search request so a newer
// query can cancel an older one. Without this, a slower response wins and
// overwrites the latest search results — confusing the user and breaking
// the swiper state.
let _activeSearchController = null;

// Call the server to fetch the image indicated by the index
export async function fetchImageByIndex(index) {
  if (!state.album) {
    return null;
  } // No album set, cannot fetch image

  // Deferred-show pattern: only flash the spinner when the request is
  // visibly slow (>500 ms). Track whether the timer actually fired so the
  // matching hide only runs in that case — the ref-counted spinner clamps
  // unbalanced hides at zero, but keeping show/hide pairs balanced is the
  // safer contract.
  let spinnerShown = false;
  const spinnerTimeout = setTimeout(() => {
    showSpinner();
    spinnerShown = true;
  }, 500);

  try {
    const url = `retrieve_image/${encodeURIComponent(state.album)}/${encodeURIComponent(index)}`;
    return await fetchJson(url);
  } catch (e) {
    console.warn("Failed to load image.");
    throw e;
  } finally {
    clearTimeout(spinnerTimeout);
    if (spinnerShown) {
      hideSpinner();
    }
  }
}

// The results most recently handed to setSearchResults, before the media
// filter was applied, and the search type they came with. Widening the filter
// (Videos → Both) re-applies these so the hidden results come back without
// re-running the search — including a search the filter had narrowed to
// nothing, which is why the type is kept separately from state.searchType.
// Entries are copied: slideState renumbers the live list in place after a
// deletion, and the copies are renumbered separately below.
let rawSearchResults = [];
let rawSearchType = "clear";

function copyResults(results) {
  return (results || []).map((r) => (r && typeof r === "object" ? { ...r } : r));
}

// "No search is active" in any of its spellings.
function isClearType(searchType) {
  return !searchType || searchType === "clear" || searchType === "switchAlbum";
}

// Function to set the search results and issue the searchResultsChanged event
//
// Note the one non-obvious contract: under an images/videos filter, searchType
// "clear" is dispatched with a NON-empty list — the album minus the hidden
// media type (the "browse list"). Listeners that treat "results present" as
// "a search is active" must check the searchType instead (see umap.js,
// metadata-drawer.js, seek-slider.js, bookmarks.js). A clear never carries
// anything else: what a caller passes with "clear" is ignored, so a list that
// was saved and handed back (bookmarks.js does this) cannot pin an old browse
// list in place after the filter changed.
//
// "switchAlbum" is different again: the album is about to change, so the
// browse list in hand is the old album's. It is stored as given (always [])
// and, as before, dispatches nothing.
export function setSearchResults(results, searchType) {
  let effective;
  let noResults = false;
  if (searchType === "switchAlbum") {
    rawSearchResults = [];
    rawSearchType = "clear";
    effective = results || [];
  } else if (isClearType(searchType)) {
    rawSearchResults = [];
    rawSearchType = "clear";
    effective = mediaBrowseList() || [];
  } else {
    rawSearchResults = copyResults(results);
    rawSearchType = searchType;
    effective = filterSearchResults(results || []);
    if (effective.length === 0) {
      // No hits (or none of the media type being shown). The "no results"
      // message still goes up, but browsing must not silently widen to the
      // whole album: fall back to the browse list, as a clear would.
      const browseList = mediaBrowseList();
      if (browseList) {
        effective = browseList;
        searchType = "clear";
        noResults = true;
      }
    }
  }
  state.searchType = searchType;
  state.searchResults = effective;
  if (searchType === "switchAlbum") {
    return;
  } // Don't trigger event on album change
  window.dispatchEvent(
    new CustomEvent("searchResultsChanged", {
      detail: {
        results: state.searchResults,
        searchType: searchType,
        // True when a real search produced nothing under the filter and the
        // browse list is standing in: the search panel shows its "no match"
        // message, everything else treats this as a clear.
        noResults,
      },
    })
  );
}

// Re-run setSearchResults on the last unfiltered results after the media
// filter, or the album's media classification, changed.
export function reapplyMediaFilter() {
  setSearchResults(copyResults(rawSearchResults), rawSearchResults.length > 0 ? rawSearchType : "clear");
}

window.addEventListener("mediaFilterChanged", (e) => {
  if (e.detail?.reason === "refresh" && rawSearchResults.length > 0) {
    // An in-place reindex appends images and leaves the existing ones where
    // they were, so an active search's results are still right — and
    // slideState has just clamped them while keeping the user's place.
    // Re-dispatching would restart the search at its first result.
    return;
  }
  reapplyMediaFilter();
});

// Keep the unfiltered copy in step with the album the way slideState keeps
// the live list: drop deleted entries and renumber the survivors after a
// deletion, clamp after an in-place reindex, and forget everything on a
// switch to a different album.
window.addEventListener("albumChanged", (e) => {
  const detail = e.detail || {};
  if (detail.changeType === "deletion" && Array.isArray(detail.deletedIndices)) {
    const deleted = new Set(detail.deletedIndices);
    rawSearchResults = rawSearchResults
      .filter((r) => !deleted.has(r?.index))
      .map((r) => ({ ...r, index: r.index - detail.deletedIndices.filter((idx) => idx < r.index).length }));
    return;
  }
  if (detail.changeType === "refresh") {
    rawSearchResults = rawSearchResults.filter((r) => r?.index < detail.totalImages);
    return;
  }
  rawSearchResults = [];
  rawSearchType = "clear";
  if (isClearType(state.searchType)) {
    // A browse list belongs to the album it was built from. slideState has
    // just reset itself for the new album; the new browse list (if the filter
    // applies there) arrives once /media_indices has loaded. Until then, and
    // for good if it does not apply, nothing is filtered.
    state.searchResults = [];
  }
});

// Perform an image search and return a list of {filename, score} objects.
export async function searchImage(image_file) {
  return await searchTextAndImage({ image_file: image_file });
}

export async function searchText(query) {
  return await searchTextAndImage({ positive_query: query });
}

// Combined search using both text and image inputs
export async function searchTextAndImage({
  image_file = null,
  positive_query = "",
  negative_query = "",
  image_weight = 0.5,
  positive_weight = 0.5,
  negative_weight = 0.5,
}) {
  let image_data = null;
  if (image_file) {
    image_data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); // base64 string
      reader.onerror = reject;
      reader.readAsDataURL(image_file);
    });
  }

  const payload = {
    positive_query,
    negative_query,
    image_data,
    image_weight,
    positive_weight,
    negative_weight,
    min_search_score: state.minSearchScore,
    max_search_results: state.maxSearchResults,
    use_query_optimization: state.useQueryOptimization,
    // Filtered server-side so max_search_results counts only the media type
    // being shown; setSearchResults filters again, which is then a no-op.
    media_filter: effectiveMediaFilter(),
  };

  // Cancel any in-flight search so the most recent query wins.
  if (_activeSearchController) {
    _activeSearchController.abort();
  }
  const controller = new AbortController();
  _activeSearchController = controller;

  try {
    const result = await fetchJson(`search_with_text_and_image/${encodeURIComponent(state.album)}`, {
      json: payload,
      signal: controller.signal,
    });
    return result.results || [];
  } catch (err) {
    if (err.name === "AbortError") {
      // Superseded by a newer search — fall through silently.
      return [];
    }
    // Surface the server's error to the user instead of silently returning
    // zero results — a GPU OOM or any other backend failure used to look
    // identical to "no matching images". The toast lifts the failure into
    // the UI; the empty array preserves the existing return contract so
    // callers don't need to handle exceptions.
    console.error("search_with_text_and_image request failed:", err);
    const detail = err?.body?.detail ?? err?.message ?? "Search failed.";
    showToast(`Search failed: ${detail}`, { level: "error", duration: 8000 });
    return [];
  } finally {
    if (_activeSearchController === controller) {
      _activeSearchController = null;
    }
  }
}

export async function getImagePath(album, index) {
  const response = await fetch(`image_path/${encodeURIComponent(album)}/${encodeURIComponent(index)}`);
  if (!response.ok) {
    return null;
  }
  return await response.text();
}
