import { hideSpinner, showSpinner } from "./utils.js";

/**
 * Simple directory tree browser for selecting directories
 */
export class DirectoryPicker {
  static async getHomeDirectory() {
    try {
      const response = await fetch("filetree/home");
      const data = await response.json();
      return data.homePath || "";
    } catch (error) {
      console.error("Error getting home directory:", error);
      return "";
    }
  }

  static async createSimpleDirectoryPicker(callback, startingPath = "", options = {}) {
    // Default options
    const {
      buttonLabel = "Select Directory",
      title = "Select Directory",
      pathLabel = "Selected directory:",
      showCreateFolder = false,
    } = options;

    // If no starting path provided, use home directory
    if (!startingPath) {
      startingPath = await DirectoryPicker.getHomeDirectory();
    }

    const modal = document.createElement("div");
    modal.className = "directory-picker-modal";
    modal.innerHTML = `
      <div class="directory-picker-content">
        <h3>${title}</h3>
        
        <!-- Current path display -->
        <div class="current-path-display">
          <label>${pathLabel}</label>
          <input type="text" id="currentPathField" readonly />
        </div>
        
        <!-- Hidden files checkbox -->
        <div class="show-hidden-container">
          <label>
            <input type="checkbox" id="showHiddenCheckbox" />
            Show hidden directories (starting with .)
          </label>
        </div>
        
        <div class="directory-tree" id="directoryTree"></div>
        <div class="directory-picker-buttons">
          ${
            showCreateFolder
              ? `
          <button id="createFolderBtn" class="create-folder-button-inline">
            📁 New Folder
          </button>
          `
              : ""
          }
          <button id="cancelDirBtn">Cancel</button>
          <button id="addDirBtn">${buttonLabel}</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Initialize with the starting path (now defaults to home)
    let currentPath = startingPath || "";
    let selectedPath = null;
    let showHidden = false;

    const addBtn = modal.querySelector("#addDirBtn");
    const cancelBtn = modal.querySelector("#cancelDirBtn");
    const treeDiv = modal.querySelector("#directoryTree");
    const currentPathField = modal.querySelector("#currentPathField");
    const showHiddenCheckbox = modal.querySelector("#showHiddenCheckbox");
    const createFolderBtn = modal.querySelector("#createFolderBtn");

    // Update current path display
    const updateCurrentPathDisplay = () => {
      const pathToShow = selectedPath !== null ? selectedPath : currentPath;
      currentPathField.value = pathToShow || "/";
    };

    // Define the navigation handler function
    const handleNavigation = async (path, isDoubleClick) => {
      if (isDoubleClick) {
        // Double-click enters directory
        currentPath = path;
        selectedPath = null;
        // Clear any previous selection highlighting
        treeDiv.querySelectorAll(".directory-item").forEach((item) => {
          item.classList.remove("selected");
        });
        try {
          await DirectoryPicker.loadDirectories(currentPath, treeDiv, showHidden, handleNavigation);
        } finally {
          hideSpinner();
        }
      } else {
        // Single-click selects directory
        selectedPath = path;
      }
      updateCurrentPathDisplay();
    };

    // Handle create folder button
    if (createFolderBtn) {
      createFolderBtn.onclick = async () => {
        const folderName = prompt("Enter new folder name:");
        if (!folderName || folderName.trim() === "") {
          return; // User cancelled or entered empty name
        }

        const parentPath = currentPath || "/";
        showSpinner();

        try {
          const response = await fetch("filetree/create_directory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parent_path: parentPath,
              directory_name: folderName.trim(),
            }),
          });

          if (!response.ok) {
            // Try to parse as JSON, but handle HTML responses too
            let errorMessage = `HTTP ${response.status}`;
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
              try {
                const error = await response.json();
                errorMessage = error.detail || errorMessage;
              } catch {
                // JSON parsing failed, use default message
              }
            }
            throw new Error(errorMessage);
          }

          const result = await response.json();

          // Navigate into the newly created folder
          currentPath = result.path;
          selectedPath = null;

          await DirectoryPicker.loadDirectories(currentPath, treeDiv, showHidden, handleNavigation);
          updateCurrentPathDisplay();
        } catch (error) {
          console.error("Error creating folder:", error);
          alert(`Failed to create folder: ${error.message}`);
        } finally {
          hideSpinner();
        }
      };
    }

    // Handle hidden files checkbox
    showHiddenCheckbox.onchange = () => {
      showHidden = showHiddenCheckbox.checked;
      selectedPath = null; // Clear selection when refreshing view
      DirectoryPicker.loadDirectories(currentPath, treeDiv, showHidden, handleNavigation);
      updateCurrentPathDisplay();
    };

    // Load initial directory - start at the provided path
    DirectoryPicker.loadDirectories(currentPath, treeDiv, showHidden, handleNavigation);
    updateCurrentPathDisplay();

    addBtn.onclick = () => {
      const pathToAdd = selectedPath !== null ? selectedPath : currentPath;
      callback(pathToAdd);
      modal.remove();
    };

    cancelBtn.onclick = () => {
      modal.remove();
    };
  }

  static async loadDirectories(path, container, showHidden, onSelect) {
    showSpinner();
    try {
      const response = await fetch(`filetree/directories?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`);
      const data = await response.json();

      container.innerHTML = "";

      // Add directories
      data.directories.forEach((dir) => {
        // render directory entry
        const dirEl = document.createElement("div");
        dirEl.className = "directory-item";
        dirEl.innerHTML = `<span class="dir-icon">📁</span><span class="dir-name">${dir.name}</span>`;

        // Single-click: navigate into directory (or select file)
        dirEl.onclick = () => {
          onSelect(dir.path, true); // single-click navigates into the directory
        };

        container.appendChild(dirEl);
      });

      // Add "Up" button if not at root
      if (data.currentPath && !data.isRoot) {
        const upBtn = document.createElement("div");
        upBtn.className = "directory-item up-button";
        upBtn.innerHTML = `<span class="dir-icon">⬆️</span><span class="dir-name">..</span>`;

        // keep existing single-click behavior for Up button
        upBtn.onclick = () => {
          if (data.currentPath.match(/^[A-Z]:\\?$/)) {
            onSelect("", true);
          } else {
            const isWindows = data.currentPath.includes(":\\");
            const sep = isWindows ? "\\" : "/";
            const parentPath = data.currentPath.split(sep).slice(0, -1).join(sep);
            onSelect(parentPath, true);
          }
        };
        container.insertBefore(upBtn, container.firstChild);
      }
    } catch (error) {
      console.error("Error loading directories:", error);
      container.innerHTML = "<div class='error'>Error loading directories</div>";
    }
    hideSpinner();
  }
}

// Convenience function that matches the original API
export function createSimpleDirectoryPicker(callback, startingPath = "", options = {}) {
  return DirectoryPicker.createSimpleDirectoryPicker(callback, startingPath, options);
}
