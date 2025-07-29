// search.js
// This file contains functions to interact with the backend API to search and retrieve images.
import { state } from "./state.js";
import { hideSpinner, showSpinner } from "./utils.js";

// Call the server to fetch the next image based on the current mode (random or sequential).
export async function fetchNextImage(lastImage = null, backward = false) {
  let response;
  let currentScore;
  let currentCluster;
  let currentColor;

  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s
  const formData = new URLSearchParams();

  try {
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
      formData.append("current_image", fileToRetrieve);
      formData.append("offset", 0); // No offset for search results
      formData.append("album", state.album);

      response = await fetch("retrieve_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    } else {
      formData.append("album", state.album);
      if (state.mode === "random") {
        formData.append("random", "true");
      } else if (state.mode === "sequential") {
        if (lastImage) {
          const currentFilepath = lastImage.dataset?.filepath;
          formData.append("current_image", currentFilepath);
          formData.append("offset", backward ? -1 : 1);
        }
        formData.append("random", "false");
      } else {
        throw new Error(
          "Invalid mode specified. Use 'random' or 'sequential'."
        );
      }

      response = await fetch("retrieve_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    }

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

// Perform an image search and return a list of {filename, score} objects.
export async function searchImage(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("top_k", 100);
  formData.append("album", state.album);

  try {
    const response = await fetch("search_with_image/", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();
    return result.results;
  } catch (err) {
    console.error("Image search request failed:", err);
    return [];
  }
}

// Perform a text search and return a list of {filename, score} objects.
export async function searchText(positive_query, negative_query = "") {
  const formData = new FormData();
  formData.append("positive_query", positive_query);
  formData.append("negative_query", negative_query);
  formData.append("top_k", 100);
  formData.append("album", state.album);

  try {
    const response = await fetch("search_with_text/", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();
    return result.results;
  } catch (err) {
    console.error("Text search request failed:", err);
    return [];
  }
}

export async function deleteImage(filepath) {
  try {
    // Use DELETE method with filepath as query parameter
    const response = await fetch(
      `delete_image/?file_to_delete=${encodeURIComponent(
        filepath
      )}&album=${encodeURIComponent(state.album)}`,
      {
        method: "DELETE",
      }
    );

    // check status
    if (!response.ok) {
      throw new Error(`Failed to delete image: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  } catch (e) {
    console.warn("Failed to delete image.");
    throw e;
  }
}

export function getCurrentFilepath() {
  return document.getElementById("filepathText")?.textContent?.trim();
}

// Wire up the clearNegativeTextSearchBtn
document.getElementById("clearNegativeTextSearchBtn")?.addEventListener("click", () => {
  const negativeInput = document.getElementById("negativeSearchInput");
  if (negativeInput) {
    negativeInput.value = "";
    negativeInput.focus();
  }
});
