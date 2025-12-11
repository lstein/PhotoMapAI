import { state } from './state.js';
import { highlightCurationSelection, setUmapClickCallback } from './umap.js';

let currentSelectionIndices = new Set();
let lockedIndices = new Set();
let currentSelectionFiles = [];
let analysisResults = [];
let isLockMode = false;

// Frequency Maps for Coloring
let highFreqIndices = new Set(); // > 90%
let medFreqIndices = new Set();  // > 70%
let lowFreqIndices = new Set();  // < 70%

window.toggleCurationPanel = function() {
    const panel = document.getElementById('curationPanel');
    if (panel) panel.classList.toggle('hidden');
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
        if(csvBtn) csvBtn.disabled = true;
        setStatus("Preview cleared.", "normal");
    };

    // --- LOCK LOGIC ---
    const updateLockCount = () => {
        const el = document.getElementById('lockCountDisplay');
        if(el) el.innerText = `${lockedIndices.size} Locked`;
    }

    if(toggleLockModeBtn) {
        toggleLockModeBtn.onclick = () => {
            isLockMode = !isLockMode;
            if(isLockMode) {
                toggleLockModeBtn.style.background = "#ff4444";
                toggleLockModeBtn.style.color = "white";
                toggleLockModeBtn.innerHTML = "<b>ACTIVE</b>";
                setUmapClickCallback((index) => {
                    if (lockedIndices.has(index)) {
                        lockedIndices.delete(index);
                    } else {
                        lockedIndices.add(index);
                        removeFromActiveSets(index);
                    }
                    updateVisuals();
                    updateLockCount();
                });
            } else {
                toggleLockModeBtn.style.background = "#444";
                toggleLockModeBtn.style.color = "#ccc";
                toggleLockModeBtn.innerText = "👆 Click-to-Lock";
                setUmapClickCallback(null);
            }
        };
    }

    // Lock All Green
    if(lockAllBtn) {
        lockAllBtn.onclick = () => {
            if (currentSelectionIndices.size === 0) {
                setStatus("Nothing to lock.", "error");
                return;
            }
            const count = currentSelectionIndices.size;
            currentSelectionIndices.forEach(idx => {
                lockedIndices.add(idx);
                removeFromActiveSets(idx);
            });
            updateVisuals();
            updateLockCount();
            setStatus(`Locked ${count} items.`, "success");
        }
    }

    // Lock by Threshold
    if(lockThresholdBtn) {
        lockThresholdBtn.onclick = () => {
            if (analysisResults.length === 0) {
                setStatus("No analysis data. Run Preview first.", "error");
                return;
            }

            const thresh = parseInt(document.getElementById('lockThresholdInput').value) || 90;
            let lockedCount = 0;
            
            analysisResults.forEach(item => {
                if (item.frequency >= thresh) {
                    if (!lockedIndices.has(item.index)) {
                        lockedIndices.add(item.index);
                        removeFromActiveSets(item.index);
                        lockedCount++;
                    }
                }
            });
            
            updateVisuals();
            updateLockCount();
            setStatus(`Locked ${lockedCount} new items > ${thresh}%.`, "success");
        }
    }

    if(unlockBtn) {
        unlockBtn.onclick = () => {
            lockedIndices.clear();
            updateVisuals();
            updateLockCount();
            setStatus("Locks cleared.", "normal");
        }
    }

    // --- MAIN EXECUTION ---
    runBtn.onclick = async () => {
        const targetCount = parseInt(number.value);
        let iter = parseInt(iterationsInput.value) || 1;
        if (iter > 30) { iter = 30; iterationsInput.value = 30; } // Frontend Cap

        const method = document.getElementById('methodKmeans').classList.contains('active') ? "kmeans" : "fps";

        if(!state.album) { alert("No album loaded!"); return; }

        setStatus(`Running ${method.toUpperCase()} (${iter} iterations)...`, "loading");
        
        try {
            const response = await fetch('/api/curation/curate', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    target_count: targetCount,
                    iterations: iter,
                    album: state.album,
                    method: method,
                    excluded_indices: Array.from(lockedIndices)
                })
            });

            if(!response.ok) throw new Error(await response.text());
            const data = await response.json();
            
            // Clear old buckets
            clearSelectionData();

            // Populate data
            currentSelectionIndices = new Set(data.selected_indices); // EXACTLY THE TOP N
            currentSelectionFiles = data.selected_files;
            analysisResults = data.analysis_results;

            // Bucketize for Colors (Heatmap)
            // We only look at items that are in the Top N Winners (currentSelectionIndices)
            const freqMap = {};
            data.analysis_results.forEach(r => freqMap[r.index] = r.frequency);

            currentSelectionIndices.forEach(idx => {
                if (!lockedIndices.has(idx)) {
                    const freq = freqMap[idx] || 100;
                    if (freq >= 90) highFreqIndices.add(idx);
                    else if (freq >= 70) medFreqIndices.add(idx);
                    else lowFreqIndices.add(idx);
                }
            });

            updateVisuals();
            exportBtn.disabled = false;
            if(csvBtn) csvBtn.disabled = false;
            
            let msg = `Selected ${data.count} images.`;
            if (iter > 1) msg += ` (Consensus from ${iter} runs)`;
            setStatus(msg, "success");

        } catch (e) {
            console.error(e);
            setStatus("Error: " + e.message, "error");
        }
    };

    // Export
    exportBtn.onclick = async () => {
        const path = document.getElementById('curationExportPath').value;
        if(!path) { alert("Please enter path."); return; }
        setStatus("Exporting...", "loading");
        try {
            const response = await fetch('/api/curation/export', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ filenames: currentSelectionFiles, output_folder: path })
            });
            const data = await response.json();
            alert(`Exported ${data.exported} files.`);
            setStatus("Export Complete.", "success");
        } catch (e) { alert("Export failed."); }
    };

    if(csvBtn) {
        csvBtn.onclick = () => {
            if(!analysisResults.length) return;
            let csvContent = "data:text/csv;charset=utf-8,Filename,Subfolder,Count,Frequency(%),Index\n";
            analysisResults.forEach(row => {
                csvContent += `${row.filename},${row.subfolder},${row.count},${row.frequency},${row.index}\n`;
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
        if((currentSelectionIndices.size > 0 || lockedIndices.size > 0) && gridContainer && gridContainer.style.display !== 'none') {
            applyGridHighlights();
        }
    }, 1000);
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
}

function updateVisuals() {
    applyGridHighlights();
    highlightCurationSelection(
        Array.from(highFreqIndices), 
        Array.from(medFreqIndices),
        Array.from(lowFreqIndices),
        Array.from(lockedIndices)
    );
}

function applyGridHighlights() {
    const slides = document.querySelectorAll('.swiper-slide');
    slides.forEach(slide => {
        const indexStr = slide.getAttribute('data-global-index');
        if (!indexStr) return; 
        const globalIndex = parseInt(indexStr);
        const img = slide.querySelector('img');
        if(!img) return;

        img.classList.remove('curation-selected-img', 'curation-high-freq', 'curation-med-freq', 'curation-low-freq', 'curation-locked-img', 'curation-dimmed-img');

        if (lockedIndices.has(globalIndex)) {
            img.classList.add('curation-locked-img'); 
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
        else if (currentSelectionIndices.size > 0 || lockedIndices.size > 0) {
            img.classList.add('curation-dimmed-img'); 
        }
    });
}

function setStatus(msg, type) {
    const el = document.getElementById('curationStatus');
    if (el) {
        el.innerText = msg;
        el.style.color = type === 'error' ? '#ff4444' : (type === 'success' ? '#00ff00' : '#888');
    }
}