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

export async function deleteImage(filepath, albumKey) {
  try {
    const response = await fetch(
      `delete_image/${encodeURIComponent(albumKey)}?file_to_delete=${encodeURIComponent(filepath)}`,
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

export async function getIndexMetadata(albumKey) {
  try {
    const response = await fetch(`index_metadata/${albumKey}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (response.status === 404) {
      console.warn("Index metadata not found for album:", albumKey);
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch index metadata: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to get index metadata:", error);
    return null;
  }
}
