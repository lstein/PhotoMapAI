import { state } from './state.js';
import { highlightCurationSelection, setUmapClickCallback, updateCurrentImageMarker } from './umap.js';

let currentSelectionIndices = new Set();
let excludedIndices = new Set();
let currentSelectionFiles = [];
let analysisResults = [];
let isExcludeMode = false;

// Frequency Maps for Coloring
let highFreqIndices = new Set(); // > 90%
let medFreqIndices = new Set();  // > 70%
let lowFreqIndices = new Set();  // < 70%

// Metadata Map for Persistent CSV Export (Index -> {filename, subfolder, frequency, count})
let globalMetadataMap = new Map();

window.toggleCurationPanel = function () {
    const panel = document.getElementById('curationPanel');
    if (panel) {
        panel.classList.toggle('hidden');
        // Force update of current image marker (yellow dot) to hide/show it based on panel visibility
        updateCurrentImageMarker();
        // Also update curation visuals if opening
        if (!panel.classList.contains('hidden')) {
            updateVisuals();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
});

function setupEventListeners() {
    const slider = document.getElementById('curationSlider');
    const number = document.getElementById('curationNumber');
    const iterationsInput = document.getElementById('curationIterations');

    const runBtn = document.getElementById('curationRunBtn');
    const clearBtn = document.getElementById('curationClearBtn');
    const exportBtn = document.getElementById('curationExportBtn');
    const csvBtn = document.getElementById('curationCsvBtn');
    const closeBtn = document.getElementById('curationCloseBtn');

    const toggleLockModeBtn = document.getElementById('toggleLockModeBtn');
    const lockThresholdBtn = document.getElementById('lockThresholdBtn');
    const unlockBtn = document.getElementById('unlockOutliersBtn');
    const lockAllBtn = document.getElementById('lockAllGreenBtn');

    const methodFps = document.getElementById('methodFps');
    const methodKmeans = document.getElementById('methodKmeans');

    if (!runBtn) return;

    slider.oninput = () => number.value = slider.value;
    number.oninput = () => slider.value = number.value;
    closeBtn.onclick = window.toggleCurationPanel;

    if (methodFps && methodKmeans) {
        methodFps.onclick = () => { methodFps.classList.add('active'); methodKmeans.classList.remove('active'); };
        methodKmeans.onclick = () => { methodKmeans.classList.add('active'); methodFps.classList.remove('active'); };
    }

    clearBtn.onclick = () => {
        clearSelectionData();
        analysisResults = [];
        updateVisuals();
        exportBtn.disabled = true;
        if (csvBtn) csvBtn.disabled = true;
        setStatus("Preview cleared.", "normal");
    };

    // --- EXCLUSION LOGIC ---
    const updateExcludeCount = () => {
        const el = document.getElementById('lockCountDisplay');
        if (el) el.innerText = `${excludedIndices.size} Excluded`;
    }

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
                setStatus("No analysis data. Run Preview first.", "error");
                return;
            }

            const thresh = parseInt(document.getElementById('lockThresholdInput').value) || 90;
            const previousExcludedCount = excludedIndices.size;
            let newExcludedCount = 0;

            analysisResults.forEach(item => {
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

            const totalExcluded = excludedIndices.size;
            // "Excluded 24 items from previous, and 10 new items >70%."
            setStatus(`Excluded ${previousExcludedCount} items from previous, and ${newExcludedCount} new items >${thresh}%.`, "success");
        }
    }

    if (unlockBtn) {
        unlockBtn.onclick = () => {
            excludedIndices.clear();
            updateVisuals();
            updateExcludeCount();
            setStatus("Exclusions cleared.", "normal");
        }
    }

    // --- MAIN EXECUTION ---
    runBtn.onclick = async () => {
        const targetCount = parseInt(number.value);
        let iter = parseInt(iterationsInput.value) || 1;
        if (iter > 30) { iter = 30; iterationsInput.value = 30; } // Frontend Cap

        const method = document.getElementById('methodKmeans').classList.contains('active') ? "kmeans" : "fps";

        if (!state.album) { alert("No album loaded!"); return; }

        setStatus(`Running ${method.toUpperCase()} (${iter} iterations)...`, "loading");

        try {
            const response = await fetch('api/curation/curate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    target_count: targetCount,
                    iterations: iter,
                    album: state.album,
                    method: method,
                    excluded_indices: Array.from(excludedIndices)
                })
            });

            if (!response.ok) throw new Error(await response.text());
            const data = await response.json();

            // Clear old buckets
            clearSelectionData();

            // Populate data
            // Populate data
            currentSelectionIndices = new Set();
            data.selected_indices.forEach(idx => {
                if (!excludedIndices.has(idx)) {
                    currentSelectionIndices.add(idx);
                }
            });
            currentSelectionFiles = data.selected_files;
            analysisResults = data.analysis_results;

            // Merge new results into Global Metadata Map
            analysisResults.forEach(r => {
                globalMetadataMap.set(r.index, {
                    filename: r.filename,
                    subfolder: r.subfolder,
                    filepath: r.filepath, // Important: Store full path for export
                    frequency: r.frequency,
                    count: r.count
                });
            });

            // Bucketize for Colors (Heatmap)
            // We only look at items that are in the Top N Winners (currentSelectionIndices)
            const freqMap = {};
            data.analysis_results.forEach(r => freqMap[r.index] = r.frequency);

            currentSelectionIndices.forEach(idx => {
                if (!excludedIndices.has(idx)) {
                    const freq = freqMap[idx] || 100;
                    if (freq >= 90) highFreqIndices.add(idx);
                    else if (freq >= 70) medFreqIndices.add(idx);
                    else lowFreqIndices.add(idx);
                }
            });

            updateVisuals();
            exportBtn.disabled = false;
            if (csvBtn) csvBtn.disabled = false;

            const selectedCount = data.count || currentSelectionIndices.size;
            const target = data.target_count || targetCount;

            let msg = `${selectedCount} out of ${target} images selected.`;
            if (excludedIndices.size > 0) {
                msg += ` (${excludedIndices.size} excluded)`;
            }
            setStatus(msg, "success");

        } catch (e) {
            console.error(e);
            setStatus("Error: " + e.message, "error");
        }
    };

    // Export

    exportBtn.onclick = async () => {
        const path = document.getElementById('curationExportPath').value;
        if (!path) { alert("Please enter path."); return; }

        // Reconstruct file list from current indices, respecting exclusions
        let filesToExport = [];
        currentSelectionIndices.forEach(idx => {
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
            const response = await fetch('/api/curation/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filenames: filesToExport, output_folder: path })
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
            if (globalMetadataMap.size === 0 && currentSelectionIndices.size === 0 && excludedIndices.size === 0) return;

            let csvContent = "data:text/csv;charset=utf-8,Filename,Subfolder,Count,Frequency(%),Index,Status\n";

            // Helper to escape CSV strings
            const esc = (val) => `"${String(val || '').replace(/"/g, '""')}"`;

            // 1. Add Included Items
            currentSelectionIndices.forEach(idx => {
                const meta = globalMetadataMap.get(idx);
                if (meta) {
                    csvContent += `${esc(meta.filename)},${esc(meta.subfolder)},${meta.count},${meta.frequency},${idx},Included\n`;
                } else {
                    // Should include forced items too ideally, for now mark as Included-Unknown
                    csvContent += `"Unknown","Unknown",0,0,${idx},Included\n`;
                }
            });

            // 2. Add Excluded Items
            excludedIndices.forEach(idx => {
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
        const gridContainer = document.getElementById('gridViewContainer');
        if ((currentSelectionIndices.size > 0 || excludedIndices.size > 0) && gridContainer && gridContainer.style.display !== 'none') {
            applyGridHighlights();
        }
    }, 1000);
    // Listen for UMAP redraws (e.g. Cluster Strength change) to restore curation highlights
    window.addEventListener('umapRedrawn', () => {
        const panel = document.getElementById('curationPanel');
        if (panel && !panel.classList.contains('hidden')) {
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
    currentSelectionFiles = [];
    // Do NOT clear globalMetadataMap here, as we want to remember excluded items from previous runs
}

function updateVisuals() {
    applyGridHighlights();
    highlightCurationSelection(
        Array.from(highFreqIndices),
        Array.from(medFreqIndices),
        Array.from(lowFreqIndices),
        Array.from(excludedIndices)
    );
}

function applyGridHighlights() {
    const slides = document.querySelectorAll('.swiper-slide');
    slides.forEach(slide => {
        const indexStr = slide.getAttribute('data-global-index');
        if (!indexStr) return;
        const globalIndex = parseInt(indexStr);
        const img = slide.querySelector('img');
        if (!img) return;

        img.classList.remove('curation-selected-img', 'curation-high-freq', 'curation-med-freq', 'curation-low-freq', 'curation-locked-img', 'curation-dimmed-img');

        if (excludedIndices.has(globalIndex)) {
            img.classList.add('curation-locked-img'); // Keeping class name for CSS compatibility, or we rename CSS too
        }
        else if (highFreqIndices.has(globalIndex)) {
            img.classList.add('curation-high-freq');
        }
        else if (medFreqIndices.has(globalIndex)) {
            img.classList.add('curation-med-freq');
        }
        else if (lowFreqIndices.has(globalIndex)) {
            img.classList.add('curation-low-freq');
        }
        else if (currentSelectionIndices.has(globalIndex)) {
            img.classList.add('curation-selected-img');
        }
        else if (currentSelectionIndices.size > 0 || excludedIndices.size > 0) {
            img.classList.add('curation-dimmed-img');
        }
    });
}

function setStatus(msg, type) {
    const el = document.getElementById('curationStatus');
    if (el) {
        el.innerText = msg;
        el.style.color = type === 'error' ? '#ff4444' : '#ffffff';
    }
}