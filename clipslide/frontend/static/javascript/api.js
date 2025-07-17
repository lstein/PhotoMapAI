// api.js
// This file contains functions to interact with the backend API for slide management.
import { state } from "./state.js";
import { showSpinner, hideSpinner } from "./utils.js";
import { updateOverlay } from "./overlay.js";

// Call the server to fetch the next image based on the current mode (random or sequential).
export async function fetchNextImage() {
  let response;
  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s
  const formData = new URLSearchParams();

  try {
    // Handle the case of there already being a set of search results, in which case we step through.
    if (state.searchResults?.length > 0) {
      let currentFilepath = state.searchResults[state.searchIndex++];
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

