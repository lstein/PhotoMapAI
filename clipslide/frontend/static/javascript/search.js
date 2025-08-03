// search.js
// This file contains functions to interact with the backend API to search and retrieve images.
import { state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

// Call the server to fetch the next image based on the current mode (random or chronological).
export async function fetchNextImage(lastImage = null, backward = false) {
  let response;
  let currentScore;
  let currentCluster;
  let currentColor;
  if (!state.album) return null; // No album set, cannot fetch image

  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s

  try {
    let url;
    const params = new URLSearchParams();

    // If in search mode, then we are browsing the search results
    if (state.searchResults?.length > 0) {
      let indexToRetrieve = 0;

      indexToRetrieve = backward
        ? --state.searchOrigin
        : state.searchOrigin + state.swiper.slides?.length;
      indexToRetrieve =
        (indexToRetrieve + state.searchResults.length) %
        state.searchResults.length; // wrap
      const fileToRetrieve = state.searchResults[indexToRetrieve]?.filename;

      currentScore = state.searchResults[indexToRetrieve]?.score || 0;
      currentCluster = state.searchResults[indexToRetrieve]?.cluster || null;
      currentColor = state.searchResults[indexToRetrieve]?.color || "#000000";

      params.append("current_image", fileToRetrieve);
      params.append("offset", 0); // No offset for search results
      params.append("random", "false");
    } else {
      params.append("random", state.mode === "random" ? "true" : "false");
      if (state.mode === "chronological" && lastImage) {
        const currentFilepath = lastImage.dataset?.filepath;
        params.append("current_image", currentFilepath);
        params.append("offset", backward ? -1 : 1);
      } else {
        params.append("offset", 0);
      }
    }

    // Always include album in the path
    url = `retrieve_image/${encodeURIComponent(state.album)}?${params.toString()}`;

    response = await fetch(url, {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (currentScore) data.score = currentScore; // Preserve the score from search results
    if (currentCluster) data.cluster = currentCluster; // Preserve the cluster from umap search results
    if (currentColor) data.color = currentColor; // Preserve the color from search results
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
  state.searchResults = results;
  state.searchType = searchType;
  state.searchOrigin = 0; // This keeps track of the results index of the first slide on swiper's slide array
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
    const response = await fetch(`search_with_text_and_image/${encodeURIComponent(state.album)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    return result.results || [];
  } catch (err) {
    console.error("search_with_text_and_image request failed:", err);
    return [];
  }
}

export function getCurrentFilepath() {
  return document.getElementById("filepathText")?.textContent?.trim();
}
