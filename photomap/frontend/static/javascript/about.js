export const VERSION_CACHE_KEY = "photomap.versionCheck";
export const VERSION_DISMISSED_KEY = "photomap.versionCheck.dismissed";
export const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class AboutManager {
  constructor() {
    this.modal = document.getElementById("aboutModal");
    this.closeBtn = document.getElementById("closeAboutBtn");
    this.aboutBtn = document.getElementById("aboutBtn");
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

    // Apply badge from cache immediately, then refresh in background
    // only when the cache is stale or absent.
    this.applyBadgeFromCache();
    this.refreshVersionCheckIfStale();
  }

  showModal() {
    this.modal.style.display = "flex";
    this.dismissBadge();
    this.checkForUpdates(); // Refresh in-modal notification content
  }

  hideModal() {
    this.modal.style.display = "none";
  }

  readVersionCache() {
    try {
      const raw = localStorage.getItem(VERSION_CACHE_KEY);
      if (!raw) {
        return null;
      }
      const data = JSON.parse(raw);
      if (!data || typeof data.checkedAt !== "number") {
        return null;
      }
      if (Date.now() - data.checkedAt > VERSION_CACHE_TTL_MS) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  writeVersionCache(data) {
    try {
      localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify({ ...data, checkedAt: Date.now() }));
    } catch {
      // localStorage may be unavailable; ignore.
    }
  }

  readDismissedVersion() {
    try {
      return localStorage.getItem(VERSION_DISMISSED_KEY);
    } catch {
      return null;
    }
  }

  writeDismissedVersion(version) {
    try {
      if (version) {
        localStorage.setItem(VERSION_DISMISSED_KEY, version);
      }
    } catch {
      // ignore
    }
  }

  setBadge(show) {
    if (!this.aboutBtn) {
      return;
    }
    this.aboutBtn.classList.toggle("has-update", !!show);
  }

  applyBadgeFromCache() {
    const cached = this.readVersionCache();
    if (cached && cached.updateAvailable) {
      const dismissed = this.readDismissedVersion();
      this.setBadge(cached.latestVersion !== dismissed);
    } else {
      this.setBadge(false);
    }
  }

  dismissBadge() {
    const cached = this.readVersionCache();
    if (cached && cached.updateAvailable && cached.latestVersion) {
      this.writeDismissedVersion(cached.latestVersion);
    }
    this.setBadge(false);
  }

  async refreshVersionCheckIfStale() {
    // Skip the network call when the cache is still fresh.
    if (this.readVersionCache()) {
      return;
    }
    try {
      const response = await fetch("version/check");
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (data.error) {
        return;
      }
      this.writeVersionCache({
        updateAvailable: !!data.update_available,
        latestVersion: data.latest_version,
        currentVersion: data.current_version,
      });
      this.applyBadgeFromCache();
    } catch {
      // Network failure — keep whatever badge state we already have.
    }
  }

  async checkForUpdates() {
    try {
      const response = await fetch("version/check");
      const data = await response.json();

      if (!data.error) {
        this.writeVersionCache({
          updateAvailable: !!data.update_available,
          latestVersion: data.latest_version,
          currentVersion: data.current_version,
        });
      }

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

    // Check whether inline updates are enabled by looking for the presence
    // of a named div set by the Jinja2 templater
    const inlineUpdateDiv = document.getElementById("inline-upgrades-allowed");
    if (inlineUpdateDiv) {
      this.updateContainer.innerHTML = `
        <p class="update-message">A newer version of PhotoMapAI is available.</p>
        <button id="updateBtn" class="update-btn">Update to ${latestVersion}</button>
        <div id="updateStatus" class="update-status" style="display:none;"></div>
      `;
    } else {
      this.updateContainer.innerHTML = `
        <p class="update-message">A newer version of PhotoMapAI is available.</p>
        <p class="update-message">Please visit the <a href="https://github.com/lstein/PhotoMapAI" style="color: yellow" target="_blank">PhotoMapAI Home Page</a> to download the latest version.</p>
      `;
    }

    // Insert at the bottom of the modal content, after the links row
    const linksRow = this.modal.querySelector(".about-links-row");
    linksRow.parentNode.insertBefore(this.updateContainer, linksRow.nextSibling);

    // Add click handler for update button
    const updateBtn = document.getElementById("updateBtn");
    if (updateBtn) {
      updateBtn.addEventListener("click", () => this.performUpdate());
    }
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
        method: "POST",
        headers: { "X-Requested-With": "photomap" },
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
              await fetch("version/restart", {
                method: "POST",
                headers: { "X-Requested-With": "photomap" },
              });
              updateStatus.textContent = "Server restarting... Waiting for server to come back online...";

              // Wait 5 seconds before starting to poll
              setTimeout(function pollForServer() {
                (async () => {
                  try {
                    const resp = await fetch("version/check", {
                      cache: "no-store",
                    });
                    if (resp.ok) {
                      updateStatus.textContent = "Server is back! Reloading...";
                      setTimeout(() => window.location.reload(), 1000);
                      return;
                    }
                  } catch {
                    // Ignore errors, server is still down
                  }
                  setTimeout(pollForServer, 2000);
                })();
              }, 5000);
            } catch {
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
