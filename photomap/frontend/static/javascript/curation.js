import { bookmarkManager } from "./bookmarks.js";
import { createSimpleDirectoryPicker } from "./filetree.js";
import { updateSearchCheckmarks } from "./search-ui.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { highlightCurationSelection, setCurationMode, setUmapClickCallback, updateCurrentImageMarker } from "./umap.js";
import { hideSpinner, showSpinner } from "./utils.js";

let currentSelectionIndices = new Set();
const excludedIndices = new Set();
let analysisResults = [];
let isExcludeMode = false;

// Frequency Maps for Coloring
const highFreqIndices = new Set(); // > 90%
const medFreqIndices = new Set(); // > 70%
const lowFreqIndices = new Set(); // < 70%

// Metadata Map for Persistent CSV Export (Index -> {filename, subfolder, frequency, count})
const globalMetadataMap = new Map();

window.toggleCurationPanel = function () {
  const panel = document.getElementById("curationPanel");
  if (panel) {
    panel.classList.toggle("hidden");
    const isOpen = !panel.classList.contains("hidden");

    // Toggle grey mode in UMAP
    setCurationMode(isOpen);

    // Set UMAP click behavior based on panel state
    if (isOpen) {
      // When panel is open, clicking UMAP points should navigate to that image
      setUmapClickCallback((index) => {
        slideState.navigateToIndex(index, false);
      });
    } else {
      // When panel is closed, restore default cluster selection behavior
      setUmapClickCallback(null);
    }

    // Force update of current image marker (yellow dot) to show it
    updateCurrentImageMarker();

    // Also update curation visuals if opening
    if (isOpen) {
      updateVisuals();
    }
  }
};

// Make the panel draggable by its header
function makePanelDraggable() {
  const panel = document.getElementById("curationPanel");
  const header = document.querySelector(".curation-header");
  if (!panel || !header) {
    return;
  }

  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  // Helper function to get coordinates from event (mouse or touch)
  const getEventCoords = (e) => {
    if (e.touches && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  };

  // Start dragging (mouse or touch)
  const startDrag = (e) => {
    // Don't drag if clicking the close button
    if (e.target.classList.contains("close-icon")) {
      return;
    }

    isDragging = true;
    const coords = getEventCoords(e);
    startX = coords.x;
    startY = coords.y;

    const rect = panel.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    e.preventDefault();
  };

  // Handle dragging movement (mouse or touch)
  const handleDrag = (e) => {
    if (!isDragging) {
      return;
    }

    const coords = getEventCoords(e);
    const deltaX = coords.x - startX;
    const deltaY = coords.y - startY;

    panel.style.left = initialLeft + deltaX + "px";
    panel.style.top = initialTop + deltaY + "px";
    panel.style.bottom = "auto"; // Remove bottom positioning

    e.preventDefault(); // Prevent scrolling while dragging on touch devices
  };

  // End dragging (mouse or touch)
  const endDrag = () => {
    isDragging = false;
  };

  // Mouse events
  header.addEventListener("mousedown", startDrag);
  document.addEventListener("mousemove", handleDrag);
  document.addEventListener("mouseup", endDrag);

  // Touch events
  header.addEventListener("touchstart", startDrag, { passive: false });
  document.addEventListener("touchmove", handleDrag, { passive: false });
  document.addEventListener("touchend", endDrag);
  document.addEventListener("touchcancel", endDrag);
}

document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  makePanelDraggable();
  updateStarButtonState(); // Initialize star button state
});

// Wait for state to be initialized before applying album lock restrictions
window.addEventListener("stateReady", () => {
  applyAlbumLockState(); // Apply album lock restrictions after state is ready
});

// Validate export path and enable/disable export button
function validateExportPath() {
  const exportPathInput = document.getElementById("curationExportPath");
  const exportBtn = document.getElementById("curationExportBtn");
  if (!exportPathInput || !exportBtn) {
    return;
  }

  // If album is locked, always disable
  if (state.albumLocked) {
    exportBtn.disabled = true;
    return;
  }

  const path = exportPathInput.value.trim();
  // Enable export button only if path is not empty and we have a selection
  const hasSelection = currentSelectionIndices.size > 0;
  exportBtn.disabled = !path || !hasSelection;
}

// Enable/disable star button based on selection
function updateStarButtonState() {
  const setFavoritesBtn = document.getElementById("curationSetFavoritesBtn");
  if (!setFavoritesBtn) {
    return;
  }

  // Enable only if we have a selection
  setFavoritesBtn.disabled = currentSelectionIndices.size === 0;
}

// Apply album lock restrictions to UI elements
function applyAlbumLockState() {
  if (!state.albumLocked) {
    return;
  }

  const exportPathInput = document.getElementById("curationExportPath");
  const exportBtn = document.getElementById("curationExportBtn");
  const browseBtn = document.getElementById("curationBrowseBtn");

  if (exportPathInput) {
    exportPathInput.disabled = true;
    exportPathInput.placeholder = "Disabled (Album Locked)";
    exportPathInput.style.backgroundColor = "#333";
    exportPathInput.style.color = "#666";
  }

  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.title = "Export disabled when album is locked";
  }

  if (browseBtn) {
    browseBtn.disabled = true;
    browseBtn.style.opacity = "0.5";
    browseBtn.style.filter = "grayscale(100%)";
    browseBtn.style.cursor = "not-allowed";
    browseBtn.style.backgroundColor = "#333";
    browseBtn.title = "Browse disabled when album is locked";
  }
}

function setupEventListeners() {
  const slider = document.getElementById("curationSlider");
  const number = document.getElementById("curationNumber");
  const iterationsInput = document.getElementById("curationIterations");

  const runBtn = document.getElementById("curationRunBtn");
  const clearBtn = document.getElementById("curationClearBtn");
  const exportBtn = document.getElementById("curationExportBtn");
  const csvBtn = document.getElementById("curationCsvBtn");
  const closeBtn = document.getElementById("curationCloseBtn");
  const browseBtn = document.getElementById("curationBrowseBtn");
  const setFavoritesBtn = document.getElementById("curationSetFavoritesBtn");
  const exportPathInput = document.getElementById("curationExportPath");

  const toggleLockModeBtn = document.getElementById("toggleLockModeBtn");
  const lockThresholdBtn = document.getElementById("lockThresholdBtn");
  const unlockBtn = document.getElementById("unlockOutliersBtn");

  if (!runBtn) {
    return;
  }

  // Load saved export path from localStorage
  const savedPath = localStorage.getItem("curationExportPath");
  if (savedPath) {
    exportPathInput.value = savedPath;
    validateExportPath();
  }

  // Monitor export path changes
  exportPathInput.oninput = () => {
    const path = exportPathInput.value.trim();
    localStorage.setItem("curationExportPath", path);
    validateExportPath();
  };

  // Browse button - open file tree
  if (browseBtn) {
    browseBtn.onclick = () => {
      if (state.albumLocked) {
        return; // Do nothing if album is locked
      }
      const currentPath = exportPathInput.value || "";
      createSimpleDirectoryPicker(
        (selectedPath) => {
          exportPathInput.value = selectedPath;
          localStorage.setItem("curationExportPath", selectedPath);
          validateExportPath();
        },
        currentPath,
        { title: "Select Export Folder" }
      );
    };
  }

  // Set Favorites button
  if (setFavoritesBtn) {
    setFavoritesBtn.onclick = () => {
      if (currentSelectionIndices.size === 0) {
        setStatus("No selection to set as favorites.", "error");
        return;
      }
      // Clear existing bookmarks and add selected indices
      bookmarkManager.clearBookmarks();
      currentSelectionIndices.forEach((index) => {
        bookmarkManager.bookmarks.add(index);
      });
      bookmarkManager.saveBookmarks();
      bookmarkManager.updateAllBookmarkIcons();
      setStatus(`Set ${currentSelectionIndices.size} images as favorites.`, "success");
    };
  }

  slider.oninput = () => (number.value = slider.value);
  number.oninput = () => (slider.value = number.value);
  closeBtn.onclick = window.toggleCurationPanel;

  // Radio buttons don't need click handlers - they work automatically

  clearBtn.onclick = () => {
    clearSelectionData();
    analysisResults = [];
    updateVisuals();
    exportBtn.disabled = true;
    if (csvBtn) {
      csvBtn.disabled = true;
    }
    updateStarButtonState();
    updateSearchCheckmarks(null); // Hide clear search button
    setStatus("Selection cleared.", "normal");
  };

  // --- EXCLUSION LOGIC ---
  const updateExcludeCount = () => {
    const el = document.getElementById("lockCountDisplay");
    if (el) {
      el.innerText = `${excludedIndices.size} Excluded`;
    }
  };

  if (toggleLockModeBtn) {
    toggleLockModeBtn.onclick = () => {
      isExcludeMode = !isExcludeMode;
      if (isExcludeMode) {
        toggleLockModeBtn.style.background = "#ff4444";
        toggleLockModeBtn.style.color = "white";
        toggleLockModeBtn.innerHTML = "<b>ACTIVE</b>";
        setUmapClickCallback((index) => {
          if (excludedIndices.has(index)) {
            excludedIndices.delete(index);
          } else {
            excludedIndices.add(index);
            removeFromActiveSets(index);
          }
          updateVisuals();
          updateExcludeCount();
        });
      } else {
        toggleLockModeBtn.style.background = "#444";
        toggleLockModeBtn.style.color = "#ccc";
        toggleLockModeBtn.innerText = "Click-to-Exclude";
        setUmapClickCallback(null);
      }
    };
  }

  // Exclude by Threshold
  if (lockThresholdBtn) {
    lockThresholdBtn.onclick = () => {
      if (analysisResults.length === 0) {
        setStatus("No analysis data. Run Select Images first.", "error");
        return;
      }

      const thresh = parseInt(document.getElementById("lockThresholdInput").value) || 90;
      const previousExcludedCount = excludedIndices.size;
      let newExcludedCount = 0;

      analysisResults.forEach((item) => {
        if (item.frequency >= thresh) {
          if (!excludedIndices.has(item.index)) {
            excludedIndices.add(item.index);
            removeFromActiveSets(item.index);
            newExcludedCount++;
          }
        }
      });

      updateVisuals();
      updateExcludeCount();

      // "Excluded 24 items from previous, and 10 new items >70%."
      setStatus(
        `Excluded ${previousExcludedCount} items from previous, and ${newExcludedCount} new items >${thresh}%.`,
        "success"
      );
    };
  }

  if (unlockBtn) {
    unlockBtn.onclick = () => {
      excludedIndices.clear();
      updateVisuals();
      updateExcludeCount();
      setStatus("Exclusions cleared.", "normal");
    };
  }

  // --- MAIN EXECUTION ---
  runBtn.onclick = async () => {
    const targetCount = parseInt(number.value);
    let iter = parseInt(iterationsInput.value) || 1;
    if (iter > 30) {
      iter = 30;
      iterationsInput.value = 30;
    } // Frontend Cap

    const method = document.getElementById("methodKmeans").checked ? "kmeans" : "fps";

    if (!state.album) {
      alert("No album loaded!");
      return;
    }

    setStatus(`Running ${method.toUpperCase()} (${iter} iterations)...`, "loading");

    // Show and initialize progress bar
    const progressBar = document.getElementById("curationProgressBar");
    const progressFill = document.getElementById("curationProgressFill");
    if (progressBar && progressFill) {
      progressBar.style.display = "block";
      progressFill.style.width = "0%";
    }

    try {
      showSpinner();

      // Start the curation job
      const startResponse = await fetch("api/curation/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_count: targetCount,
          iterations: iter,
          album: state.album,
          method: method,
          excluded_indices: Array.from(excludedIndices),
        }),
      });

      if (!startResponse.ok) {
        throw new Error(await startResponse.text());
      }
      const startData = await startResponse.json();

      if (startData.status !== "started") {
        throw new Error("Failed to start curation job");
      }

      const jobId = startData.job_id;

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const progressResponse = await fetch(`api/curation/curate/progress/${jobId}`);
          if (!progressResponse.ok) {
            clearInterval(pollInterval);
            throw new Error("Failed to get progress");
          }

          const progressData = await progressResponse.json();

          if (progressData.status === "running" && progressData.progress) {
            // Update progress bar with real progress
            const percentage = progressData.progress.percentage;
            if (progressFill) {
              progressFill.style.width = `${percentage}%`;
            }
            setStatus(`${progressData.progress.step}...`, "loading");
          } else if (progressData.status === "completed") {
            clearInterval(pollInterval);

            // Complete progress bar
            if (progressFill) {
              progressFill.style.width = "100%";
            }

            // Process results
            const data = progressData.result;
            if (!data || data.status === "error") {
              throw new Error(data.error || "Curation failed");
            }

            // Hide progress bar after a short delay
            setTimeout(() => {
              if (progressBar) {
                progressBar.style.display = "none";
              }
            }, 500);

            // Clear old buckets
            clearSelectionData();

            // Populate data
            currentSelectionIndices = new Set();
            data.selected_indices.forEach((idx) => {
              if (!excludedIndices.has(idx)) {
                currentSelectionIndices.add(idx);
              }
            });
            analysisResults = data.analysis_results;

            // Merge new results into Global Metadata Map
            analysisResults.forEach((r) => {
              globalMetadataMap.set(r.index, {
                filename: r.filename,
                subfolder: r.subfolder,
                filepath: r.filepath,
                frequency: r.frequency,
                count: r.count,
              });
            });

            // Bucketize for Colors (Heatmap)
            const freqMap = {};
            data.analysis_results.forEach((r) => (freqMap[r.index] = r.frequency));

            currentSelectionIndices.forEach((idx) => {
              if (!excludedIndices.has(idx)) {
                const freq = freqMap[idx] || 100;
                if (freq >= 90) {
                  highFreqIndices.add(idx);
                } else if (freq >= 70) {
                  medFreqIndices.add(idx);
                } else {
                  lowFreqIndices.add(idx);
                }
              }
            });

            updateVisuals();
            validateExportPath();
            updateStarButtonState();
            if (csvBtn) {
              csvBtn.disabled = false;
            }

            const selectedCount = data.count || currentSelectionIndices.size;
            const target = data.target_count || targetCount;

            let msg = `${selectedCount} out of ${target} images selected.`;
            if (excludedIndices.size > 0) {
              msg += ` (${excludedIndices.size} excluded)`;
            }
            setStatus(msg, "success");
            hideSpinner();

            // Show clear search button for curation results
            updateSearchCheckmarks("curation");
          } else if (progressData.status === "error") {
            clearInterval(pollInterval);
            throw new Error(progressData.error || "Curation failed");
          }
        } catch (pollError) {
          clearInterval(pollInterval);
          console.error("Polling error:", pollError);
          setStatus("Error: " + pollError.message, "error");
          hideSpinner();
          if (progressBar) {
            progressBar.style.display = "none";
          }
        }
      }, 500); // Poll every 500ms
    } catch (e) {
      console.error(e);
      setStatus("Error: " + e.message, "error");
      hideSpinner();

      // Hide progress bar on error
      const progressBar = document.getElementById("curationProgressBar");
      if (progressBar) {
        progressBar.style.display = "none";
      }
    }
  };

  // Export

  exportBtn.onclick = async () => {
    if (state.albumLocked) {
      alert("Export is disabled when album is locked.");
      return;
    }

    const path = document.getElementById("curationExportPath").value;
    if (!path) {
      alert("Please enter path.");
      return;
    }

    // Reconstruct file list from current indices, respecting exclusions
    const filesToExport = [];
    currentSelectionIndices.forEach((idx) => {
      if (!excludedIndices.has(idx)) {
        const meta = globalMetadataMap.get(idx);
        if (meta && meta.filepath) {
          filesToExport.push(meta.filepath);
        }
      }
    });

    if (filesToExport.length === 0) {
      alert("No files selected to export (all excluded?).");
      return;
    }

    setStatus(`Exporting ${filesToExport.length} files...`, "loading");
    try {
      const response = await fetch("api/curation/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: filesToExport, output_folder: path }),
      });
      const data = await response.json();
      alert(`Exported ${data.exported} files.`);
      setStatus("Export Complete.", "success");
    } catch (e) {
      console.error(e);
      alert("Export failed: " + e.message);
    }
  };

  if (csvBtn) {
    csvBtn.onclick = () => {
      if (globalMetadataMap.size === 0 && currentSelectionIndices.size === 0 && excludedIndices.size === 0) {
        return;
      }

      let csvContent = "data:text/csv;charset=utf-8,Filename,Subfolder,Count,Frequency(%),Index,Status\n";

      // Helper to escape CSV strings
      const esc = (val) => `"${String(val || "").replace(/"/g, '""')}"`;

      // 1. Add Included Items
      currentSelectionIndices.forEach((idx) => {
        const meta = globalMetadataMap.get(idx);
        if (meta) {
          csvContent += `${esc(meta.filename)},${esc(meta.subfolder)},${meta.count},${meta.frequency},${idx},Included\n`;
        } else {
          // Should include forced items too ideally, for now mark as Included-Unknown
          csvContent += `"Unknown","Unknown",0,0,${idx},Included\n`;
        }
      });

      // 2. Add Excluded Items
      excludedIndices.forEach((idx) => {
        const meta = globalMetadataMap.get(idx);
        if (meta) {
          csvContent += `${esc(meta.filename)},${esc(meta.subfolder)},${meta.count},${meta.frequency},${idx},Excluded\n`;
        } else {
          csvContent += `"Unknown (Manual)","Unknown",0,0,${idx},Excluded\n`;
        }
      });

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `curation_analysis_${state.album}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }

  setInterval(() => {
    const gridContainer = document.getElementById("gridViewContainer");
    if (
      (currentSelectionIndices.size > 0 || excludedIndices.size > 0) &&
      gridContainer &&
      gridContainer.style.display !== "none"
    ) {
      applyGridHighlights();
    }
  }, 1000);
  // Listen for UMAP redraws (e.g. Cluster Strength change) to restore curation highlights
  window.addEventListener("umapRedrawn", () => {
    const panel = document.getElementById("curationPanel");
    if (panel && !panel.classList.contains("hidden")) {
      updateVisuals();
    }
  });
}

function removeFromActiveSets(index) {
  currentSelectionIndices.delete(index);
  highFreqIndices.delete(index);
  medFreqIndices.delete(index);
  lowFreqIndices.delete(index);
}

function clearSelectionData() {
  currentSelectionIndices.clear();
  highFreqIndices.clear();
  medFreqIndices.clear();
  lowFreqIndices.clear();
  // Do NOT clear globalMetadataMap here, as we want to remember excluded items from previous runs
}

// Export function to allow clearing curation from external modules (like search-ui)
export function clearCurationData() {
  clearSelectionData();
  analysisResults = [];
  updateVisuals();

  const exportBtn = document.getElementById("curationExportBtn");
  const csvBtn = document.getElementById("curationCsvBtn");
  if (exportBtn) {
    exportBtn.disabled = true;
  }
  if (csvBtn) {
    csvBtn.disabled = true;
  }
  updateStarButtonState();
  updateSearchCheckmarks(null); // Hide clear search button
  setStatus("", "normal");
}

function updateVisuals() {
  applyGridHighlights();
  highlightCurationSelection(
    Array.from(highFreqIndices),
    Array.from(medFreqIndices),
    Array.from(lowFreqIndices),
    Array.from(excludedIndices)
  );
  // Ensure grey mode persists after updating curation overlays
  // This is needed because Plotly trace operations might affect the base trace
  if (
    document.getElementById("curationPanel") &&
    !document.getElementById("curationPanel").classList.contains("hidden")
  ) {
    // Panel is open, ensure grey mode is active
    setCurationMode(true);
  }
}

function applyGridHighlights() {
  const slides = document.querySelectorAll(".swiper-slide");
  slides.forEach((slide) => {
    const indexStr = slide.getAttribute("data-global-index");
    if (!indexStr) {
      return;
    }
    const globalIndex = parseInt(indexStr);
    const img = slide.querySelector("img");
    if (!img) {
      return;
    }

    img.classList.remove(
      "curation-selected-img",
      "curation-high-freq",
      "curation-med-freq",
      "curation-low-freq",
      "curation-locked-img",
      "curation-dimmed-img"
    );

    if (excludedIndices.has(globalIndex)) {
      img.classList.add("curation-locked-img"); // Keeping class name for CSS compatibility, or we rename CSS too
    } else if (highFreqIndices.has(globalIndex)) {
      img.classList.add("curation-high-freq");
    } else if (medFreqIndices.has(globalIndex)) {
      img.classList.add("curation-med-freq");
    } else if (lowFreqIndices.has(globalIndex)) {
      img.classList.add("curation-low-freq");
    } else if (currentSelectionIndices.has(globalIndex)) {
      img.classList.add("curation-selected-img");
    } else if (currentSelectionIndices.size > 0 || excludedIndices.size > 0) {
      img.classList.add("curation-dimmed-img");
    }
  });
}

function setStatus(msg, type) {
  const el = document.getElementById("curationStatus");
  if (el) {
    el.innerText = msg;
    el.style.color = type === "error" ? "#ff4444" : "#ffffff";
  }
}
