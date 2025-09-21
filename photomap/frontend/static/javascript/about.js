class AboutManager {
  constructor() {
    this.modal = document.getElementById("aboutModal");
    this.closeBtn = document.getElementById("closeAboutBtn");
    this.updateContainer = null;
    this.init();
  }

  init() {
    this.closeBtn.addEventListener("click", () => this.hideModal());
    
    // Close modal when clicking outside
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) {
        this.hideModal();
      }
    });

    // Check for updates when modal is shown
    this.checkForUpdates();
  }

  showModal() {
    this.modal.style.display = "flex";
    this.checkForUpdates(); // Check again when opening
  }

  hideModal() {
    this.modal.style.display = "none";
  }

  async checkForUpdates() {
    try {
      const response = await fetch("version/check");
      const data = await response.json();

      if (data.update_available) {
        this.showUpdateNotification(data.latest_version);
      } else {
        this.showUpToDateMessage(data.current_version);
      }
    } catch (error) {
      console.warn("Failed to check for updates:", error);
      this.hideUpdateNotification();
    }
  }

  showUpdateNotification(latestVersion) {
    // Remove existing update notification
    this.hideUpdateNotification();

    // Create update notification
    this.updateContainer = document.createElement("div");
    this.updateContainer.className = "update-notification";
    this.updateContainer.innerHTML = `
      <p class="update-message">A newer version of PhotoMapAI is available</p>
      <button id="updateBtn" class="update-btn">Update to ${latestVersion}</button>
      <div id="updateStatus" class="update-status" style="display:none;"></div>
    `;

    // Insert at the bottom of the modal content, after the links row
    const linksRow = this.modal.querySelector(".about-links-row");
    linksRow.parentNode.insertBefore(this.updateContainer, linksRow.nextSibling);

    // Add click handler for update button
    const updateBtn = document.getElementById("updateBtn");
    updateBtn.addEventListener("click", () => this.performUpdate());
  }

  hideUpdateNotification() {
    if (this.updateContainer) {
      this.updateContainer.remove();
      this.updateContainer = null;
    }
  }

  showUpToDateMessage(currentVersion) {
    // Remove existing update notification
    this.hideUpdateNotification();

    // Create up-to-date message
    this.updateContainer = document.createElement("div");
    this.updateContainer.className = "update-notification up-to-date";
    this.updateContainer.innerHTML = `
      <p class="update-message">Your version is up to date (${currentVersion})</p>
    `;

    // Insert at the bottom of the modal content, after the links row
    const linksRow = this.modal.querySelector(".about-links-row");
    linksRow.parentNode.insertBefore(this.updateContainer, linksRow.nextSibling);
  }

  async performUpdate() {
    const updateBtn = document.getElementById("updateBtn");
    const updateStatus = document.getElementById("updateStatus");
    
    updateBtn.disabled = true;
    updateBtn.textContent = "Updating...";
    updateStatus.style.display = "block";
    updateStatus.textContent = "Downloading and installing update...";
    updateStatus.className = "update-status updating";

    try {
      const response = await fetch("version/update", {
        method: "POST"
      });
      const data = await response.json();

      if (data.success) {
        updateStatus.textContent = "Update completed! Restarting server...";
        updateStatus.className = "update-status success";
        updateBtn.textContent = "Update Complete";
        
        // If restart is available, trigger it
        if (data.restart_available) {
          setTimeout(async () => {
            try {
              await fetch("version/restart", { method: "POST" });
              updateStatus.textContent = "Server restarting... Waiting for server to come back online...";
              
              // Wait 5 seconds before starting to poll
              setTimeout(function pollForServer() {
                (async () => {
                  try {
                    const resp = await fetch("version/check", { cache: "no-store" });
                    if (resp.ok) {
                      updateStatus.textContent = "Server is back! Reloading...";
                      setTimeout(() => window.location.reload(), 1000);
                      return;
                    }
                  } catch (e) {
                    // Ignore errors, server is still down
                  }
                  setTimeout(pollForServer, 2000);
                })();
              }, 5000);
            } catch (e) {
              updateStatus.textContent = "Update complete. Please refresh manually.";
            }
          }, 1000);
        }
      } else {
        updateStatus.textContent = `Update failed: ${data.message}`;
        updateStatus.className = "update-status error";
        updateBtn.disabled = false;
        updateBtn.textContent = "Retry Update";
      }
    } catch (error) {
      updateStatus.textContent = `Update failed: ${error.message}`;
      updateStatus.className = "update-status error";
      updateBtn.disabled = false;
      updateBtn.textContent = "Retry Update";
    }
  }
}

// Export singleton
export const aboutManager = new AboutManager();
