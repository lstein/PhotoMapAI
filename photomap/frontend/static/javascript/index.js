// index.js
// Functions for managing the embeddings index

export async function updateIndex(albumKey) {
    try {
      const response = await fetch("update_index_async/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ album_key: albumKey }),
      });

      if (response.ok) {
        return await response.json();
      } else {
        throw new Error("Failed to update index");
      }
    } catch (error) {
      console.error("Failed to start indexing:", error);
      alert(`Failed to start indexing: ${error.message}`);
    }
    return null;
}

// This function is called to remove the index for a specific album
// It needs to be called when the index is corrupted or needs to be reset for whatever reason
export async function removeIndex(albumKey) {
  try {
    const response = await fetch(`remove_index/${albumKey}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Failed to remove index: ${response.statusText}`);
    }
    return await response.json();
  } catch (e) {
    console.warn("Failed to remove index.");
    throw e;
  }
}

export async function deleteImage(albumKey, index) {
  try {
    const response = await fetch(
      `delete_image/${encodeURIComponent(albumKey)}/${encodeURIComponent(index)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      }
    );

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

// Given an album key, returns metadata about the index, including number of images
export async function getIndexMetadata(albumKey) {
  try {
    const response = await fetch(`index_metadata/${albumKey}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (response.status === 404) {
      throw new Error("missing");
    }

    if (response.status === 500) {
      throw new Error("corrupted");
    }

    if (!response.ok) {
      throw new Error(`unknown:${response.status}`);
    }

    return await response.json();
  } catch (error) {
    let errorType = "corrupted";
    if (error.message === "missing") {
      errorType = "missing";
    } else if (error.message === "corrupted") {
      errorType = "corrupted";
    } else if (error.message && error.message.startsWith("unknown:")) {
      errorType = "unknown";
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
