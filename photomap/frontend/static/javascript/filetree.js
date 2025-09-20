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

  static async createSimpleDirectoryPicker(callback, startingPath = "") {
    // If no starting path provided, use home directory
    if (!startingPath) {
      startingPath = await DirectoryPicker.getHomeDirectory();
    }

    const modal = document.createElement("div");
    modal.className = "directory-picker-modal";
    modal.innerHTML = `
      <div class="directory-picker-content">
        <h3>Select Directory</h3>
        
        <!-- Current path display -->
        <div class="current-path-display">
          <label>Current directory to add:</label>
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
          <button id="addDirBtn">Add</button>
          <button id="cancelDirBtn">Cancel</button>
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
          await DirectoryPicker.loadDirectories(
            currentPath,
            treeDiv,
            showHidden,
            handleNavigation
          );
        } finally {
          hideSpinner();
        }
      } else {
        // Single-click selects directory
        selectedPath = path;
      }
      updateCurrentPathDisplay();
    };

    // Handle hidden files checkbox
    showHiddenCheckbox.onchange = () => {
      showHidden = showHiddenCheckbox.checked;
      selectedPath = null; // Clear selection when refreshing view
      DirectoryPicker.loadDirectories(
        currentPath,
        treeDiv,
        showHidden,
        handleNavigation
      );
      updateCurrentPathDisplay();
    };

    // Load initial directory - start at the provided path
    DirectoryPicker.loadDirectories(
      currentPath,
      treeDiv,
      showHidden,
      handleNavigation
    );
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
      const response = await fetch(
        `filetree/directories?path=${encodeURIComponent(
          path
        )}&show_hidden=${showHidden}`
      );
      const data = await response.json();

      container.innerHTML = "";

      // Add directories
      data.directories.forEach((dir) => {
        const dirElement = document.createElement("div");
        dirElement.className = "directory-item";

        // Use different icons for drives vs folders
        const icon = dir.name.includes("Drive")
          ? "💽"
          : dir.hasChildren
          ? "📂"
          : "📁";

        dirElement.innerHTML = `
          <span class="dir-icon">${icon}</span>
          <span class="dir-name">${dir.name}</span>
        `;

        // Handle single and double clicks
        let clickTimeout = null;

        dirElement.onclick = (e) => {
          e.preventDefault();

          // Clear any existing timeout
          if (clickTimeout) {
            clearTimeout(clickTimeout);
            clickTimeout = null;

            // This is a double-click - call onSelect immediately
            onSelect(dir.path, true);
            return;
          }

          // Set timeout for single-click
          clickTimeout = setTimeout(() => {
            clickTimeout = null;
            // This is a single-click
            onSelect(dir.path, false);

            // Update visual selection
            container.querySelectorAll(".directory-item").forEach((item) => {
              item.classList.remove("selected");
            });
            dirElement.classList.add("selected");
          }, 250); // Increased delay slightly to make double-click easier
        };

        container.appendChild(dirElement);
      });

      // Add "Up" button if not at root
      if (data.currentPath && !data.isRoot) {
        const upBtn = document.createElement("div");
        upBtn.className = "directory-item up-button";
        upBtn.innerHTML = `<span class="dir-icon">⬆️</span><span class="dir-name">..</span>`;

        upBtn.onclick = () => {
          // Handle going up differently on Windows vs Unix
          if (data.currentPath.match(/^[A-Z]:\\?$/)) {
            // Going up from drive root shows all drives
            onSelect("", true);
          } else {
            // Normal up navigation
            const isWindows = data.currentPath.includes(":\\");
            const separator = isWindows ? "\\" : "/";
            const parentPath = data.currentPath
              .split(separator)
              .slice(0, -1)
              .join(separator);
            onSelect(parentPath, true);
          }
        };

        // Insert at the beginning
        container.insertBefore(upBtn, container.firstChild);
      }
    } catch (error) {
      console.error("Error loading directories:", error);
      container.innerHTML =
        "<div class='error'>Error loading directories</div>";
    }
    hideSpinner();
  }
}

// Convenience function that matches the original API
export function createSimpleDirectoryPicker(callback, startingPath = "") {
  return DirectoryPicker.createSimpleDirectoryPicker(callback, startingPath);
}
