// search.js
// This file contains functions to interact with the backend API to search and retrieve images.
import { state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

const IMAGE_SCORE_CUTOFF = 0.75; // Default image score cutoff
const TEXT_SCORE_CUTOFF = 0.2; // Default text score cutoff

// Call the server to fetch the image indicated by the index
export async function fetchImageByIndex(index) {
  let response;
  if (!state.album) return null; // No album set, cannot fetch image

  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s

  try {
    let url;

    // Album and index go into path
    url = `retrieve_image/${encodeURIComponent(
      state.album
    )}/${encodeURIComponent(index)}`;

    response = await fetch(url, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    clearTimeout(spinnerTimeout);
    hideSpinner();
    return data;
  } catch (e) {
    clearTimeout(spinnerTimeout);
    hideSpinner();
    console.warn("Failed to load image.");
    throw e;
  }
}

// Function to set the search results and issue the searchResultsChanged event
export function setSearchResults(results, searchType) {
  state.searchType = searchType;
  state.searchResults = results;
  if (searchType === "switchAlbum")
    return; // Don't trigger event on album change
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
  top_k = 100,
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
    top_k,
  };

  try {
    const response = await fetch(
      `search_with_text_and_image/${encodeURIComponent(state.album)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const result = await response.json();
    return result.results || [];
  } catch (err) {
    console.error("search_with_text_and_image request failed:", err);
    return [];
  }
}

export async function getImagePath(album, index) {
  const response = await fetch(`image_path/${encodeURIComponent(album)}/${encodeURIComponent(index)}`);
  if (!response.ok) return null;
  return await response.text();
}

// Guesstimate the best search score cutoff from the weights applied.
export function calculate_search_score_cutoff(
  imageFile,
  imgWeight,
  positiveQuery,
  posWeight,
  negativeQuery,
  negWeight
) {
  let numerator = 0;
  let denominator = 0;
  if (imageFile !== null) {
    numerator += imgWeight * IMAGE_SCORE_CUTOFF; // Image score cutoff
    denominator += imgWeight;
  }
  if (positiveQuery !== "") {
    numerator += posWeight * TEXT_SCORE_CUTOFF; // Positive
    denominator += posWeight;
  }
  if (negativeQuery !== "") {
    numerator += negWeight * TEXT_SCORE_CUTOFF; // Negative
    denominator += negWeight;
  }
  const cutoff = numerator / denominator;
  return cutoff;
}

document.getElementById('closeTextSearchBtn').onclick = function() {
  document.getElementById('textSearchPanel').style.display = 'none';
};
