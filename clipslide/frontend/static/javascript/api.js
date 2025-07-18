// api.js
// This file contains functions to interact with the backend API for slide management.
import { state } from "./state.js";
import { showSpinner, hideSpinner } from "./utils.js";
import { updateOverlay } from "./overlay.js";

// Call the server to fetch the next image based on the current mode (random or sequential).
export async function fetchNextImage() {
  let response;
  let currentScore = state.searchResults[state.searchIndex]?.score || 0;

  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s
  const formData = new URLSearchParams();

  try {
    // Handle the case of there already being a set of search results, in which case we step through.
    if (state.searchResults?.length > 0) {
      let currentFilepath = state.searchResults[state.searchIndex++].filename;
      if (state.searchIndex >= state.searchResults.length)
        state.searchIndex = 0; // Loop back to start
      formData.append("embeddings_file", state.embeddingsFile);
      formData.append("current_image", currentFilepath);
      response = await fetch("retrieve_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      // Otherwise we let the server handle the logic of which image to return.
    } else {
      // Convert query parameters to form data
      formData.append("embeddings_file", state.embeddingsFile);
      if (state.mode === "random") {
        formData.append("random", "true");
      } else if (state.mode === "sequential") {
        // Use the currently displayed slide, not the last in the buffer
        const currentFilepath = getCurrentFilepath();
        formData.append("current_image", currentFilepath);
        formData.append("random", "false");
      } else {
        throw new Error(
          "Invalid mode specified. Use 'random' or 'sequential'."
        );
      }

      response = await fetch("retrieve_next_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (currentScore)
      data.score = currentScore; // Preserve the score from search results
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
  formData.append("embeddings_file", state.embeddingsFile);

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
export async function searchText(query) {
    const formData = new FormData();
    formData.append("text_query", query);
    formData.append("top_k", 100);
    formData.append("embeddings_file", state.embeddingsFile);

    try {
      const response = await fetch("search_with_text/", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      return result.results
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
      )}&embeddings_file=${encodeURIComponent(state.embeddingsFile)}`,
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

