// index.js
// Functions for managing the embeddings index

import { fetchJson, HttpError } from "./utils.js";

export async function updateIndex(albumKey) {
  try {
    const response = await fetchJson("update_index_async/", { json: { album_key: albumKey } });
    // Tell interested UI (e.g. the semantic map's titlebar progress ring)
    // that a run just started, whichever control initiated it.
    window.dispatchEvent(new CustomEvent("albumIndexStarted", { detail: { albumKey } }));
    return response;
  } catch (error) {
    console.error("Failed to start indexing:", error);
    alert(`Failed to start indexing: ${error.message}`);
    return null;
  }
}

// This function is called to remove the index for a specific album
// It needs to be called when the index is corrupted or needs to be reset for whatever reason
export async function removeIndex(albumKey) {
  try {
    return await fetchJson(`remove_index/${albumKey}`, { method: "DELETE" });
  } catch (e) {
    console.warn("Failed to remove index.");
    throw e;
  }
}

export async function deleteImage(albumKey, index, moveToTrash = true) {
  try {
    return await fetchJson(
      `delete_image/${encodeURIComponent(albumKey)}/${encodeURIComponent(index)}?move_to_trash=${moveToTrash}`,
      { method: "DELETE" }
    );
  } catch (e) {
    console.warn("Failed to delete image.");
    throw e;
  }
}

// Batch delete: one request and a single embeddings rewrite on the server,
// instead of one full .npz rewrite per image. Returns the server's summary,
// including ``deleted_indices`` (the subset that actually got removed).
export async function deleteImages(albumKey, indices, moveToTrash = true) {
  try {
    return await fetchJson(`delete_images/${encodeURIComponent(albumKey)}`, {
      json: { indices, move_to_trash: moveToTrash },
    });
  } catch (e) {
    console.warn("Failed to delete images.");
    throw e;
  }
}

// Given an album key, returns metadata about the index, including number of images.
// On any failure, dispatches ``albumIndexError`` so the album manager can
// react (e.g. start auto-indexing on 404). The errorType distinguishes
// "missing" (404), "corrupted" (500), and "unknown" (other non-2xx /
// network error).
export async function getIndexMetadata(albumKey) {
  try {
    return await fetchJson(`index_metadata/${albumKey}`);
  } catch (error) {
    let errorType = "unknown";
    if (error instanceof HttpError) {
      if (error.status === 404) {
        errorType = "missing";
      } else if (error.status === 500) {
        errorType = "corrupted";
      }
    } else {
      // Non-HttpError (e.g. NetworkError) — treat as corrupted so the same
      // recovery flow runs as for a 500.
      errorType = "corrupted";
    }
    window.dispatchEvent(
      new CustomEvent("albumIndexError", {
        detail: { albumKey, errorType, error },
      })
    );
    console.error("Failed to get index metadata:", error);
    return null;
  }
}
