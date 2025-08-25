// progress-bar.js
// Support for the progress bar that displays indexing progress.

export async function startIndexUpdate(albumKey) {
  // Start the operation
  const response = await fetch("update_index_async/", {
    method: "POST",
    body: new FormData([["album_key", albumKey]]),
  });

  if (response.ok) {
    // Start polling for progress
    pollProgress(albumKey);
  }
}

async function pollProgress(albumKey) {
  const progressBar = document.getElementById("progressBar");
  const statusText = document.getElementById("statusText");

  const poll = async () => {
    try {
      const response = await fetch(`/index_progress/${albumKey}`);
      const progress = await response.json();

      // Update UI
      progressBar.style.width = `${progress.progress_percentage}%`;
      statusText.textContent = `${progress.current_step} (${progress.images_processed}/${progress.total_images})`;

      // Continue polling if still running
      if (progress.status === "indexing" || progress.status === "scanning") {
        setTimeout(poll, 1000); // Poll every second
      } else if (progress.status === "completed") {
        statusText.textContent = "Index update completed!";
      } else if (progress.status === "error") {
        statusText.textContent = `Error: ${progress.error_message}`;
      }
    } catch (error) {
      console.error("Failed to get progress:", error);
    }
  };

  poll();
}
