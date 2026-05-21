// search.js
// This file contains functions to interact with the backend API to search and retrieve images.
import { state } from "./state.js";
import { fetchJson, hideSpinner, showSpinner } from "./utils.js";

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

  const spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s

  try {
    const url = `retrieve_image/${encodeURIComponent(state.album)}/${encodeURIComponent(index)}`;
    return await fetchJson(url);
  } catch (e) {
    console.warn("Failed to load image.");
    throw e;
  } finally {
    clearTimeout(spinnerTimeout);
    hideSpinner();
  }
}

// Function to set the search results and issue the searchResultsChanged event
export function setSearchResults(results, searchType) {
  state.searchType = searchType;
  state.searchResults = results;
  if (searchType === "switchAlbum") {
    return;
  } // Don't trigger event on album change
  window.dispatchEvent(
    new CustomEvent("searchResultsChanged", {
      detail: {
        results: results,
        searchType: searchType,
      },
    })
  );
}

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
    console.error("search_with_text_and_image request failed:", err);
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
