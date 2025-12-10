import { state } from './state.js';
import { highlightCurationSelection } from './umap.js';

let currentSelectionIndices = new Set(); // Green
let lockedIndices = new Set();           // Red (Excluded)
let currentSelectionFiles = [];
let analysisResults = []; // Store for CSV

window.toggleCurationPanel = function() {
    const panel = document.getElementById('curationPanel');
    if (panel) panel.classList.toggle('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
});

function setupEventListeners() {
    // ... (Keep existing var declarations) ...
    const analysisBtn = document.getElementById('analysisBtn');
    const downloadCsvBtn = document.getElementById('downloadCsvBtn');
    const lockBtn = document.getElementById('lockOutliersBtn');
    const unlockBtn = document.getElementById('unlockOutliersBtn');
    const lockdownControls = document.getElementById('lockdownControls');
    
    // ... (Keep existing Sync logic) ...

    // CSV Download
    if(downloadCsvBtn) {
        downloadCsvBtn.onclick = () => {
            if(!analysisResults.length) return;
            
            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Filename,Count,Frequency(%),Index\n"; // Header
            
            analysisResults.forEach(row => {
                csvContent += `${row.filename},${row.count},${row.frequency},${row.index}\n`;
            });
            
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `outlier_analysis_${state.album}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
    }

    // Lock Logic
    if(lockBtn) {
        lockBtn.onclick = () => {
            // Move current HIGH STABILITY outliers to Locked Set
            analysisResults.forEach(r => {
                if (r.frequency >= 50) { // Lock items appearing > 50%
                    lockedIndices.add(r.index);
                }
            });
            // Clear current selection so we can see the locks clearly
            currentSelectionIndices.clear(); 
            applyGridHighlights();
            setStatus(`Locked ${lockedIndices.size} outliers. Run Preview again!`, "success");
        }
    }

    // Unlock Logic
    if(unlockBtn) {
        unlockBtn.onclick = () => {
            lockedIndices.clear();
            applyGridHighlights();
            setStatus("All locks cleared.", "normal");
        }
    }

    // Run FPS / KMEANS (Updated to send Exclusions)
    const runBtn = document.getElementById('curationRunBtn');
    runBtn.onclick = async () => {
        const targetCount = parseInt(document.getElementById('curationNumber').value);
        const seedVal = parseInt(document.getElementById('curationSeed').value) || 42;
        const method = document.getElementById('methodKmeans').classList.contains('active') ? "kmeans" : "fps";

        if(!state.album) { alert("No album."); return; }

        setStatus(`Running ${method.toUpperCase()} (Excluding ${lockedIndices.size} items)...`, "loading");
        
        try {
            const response = await fetch('/api/curation/fps', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    target_count: targetCount,
                    seed: seedVal,
                    album: state.album,
                    method: method,
                    excluded_indices: Array.from(lockedIndices) // <--- SEND LOCKS
                })
            });

            if(!response.ok) throw new Error(await response.text());
            
            const data = await response.json();
            
            currentSelectionIndices = new Set(data.selected_indices);
            currentSelectionFiles = data.selected_files;

            applyGridHighlights();
            updateUmapVisuals();
            
            document.getElementById('curationExportBtn').disabled = false;
            setStatus(`Selected ${data.count} images.`, "success");

        } catch (e) {
            console.error(e);
            setStatus("Error: " + e.message, "error");
        }
    };

    // Run Analysis (Populate CSV data)
    if (analysisBtn) {
        analysisBtn.onclick = async () => {
            const percent = parseInt(document.getElementById('analysisPercent').value) || 10;
            const runs = parseInt(document.getElementById('analysisRuns').value) || 20;
            
            setStatus(`Running ${runs} simulations...`, "loading");

            try {
                const response = await fetch('/api/curation/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ 
                        album: state.album,
                        sample_percent: percent,
                        iterations: runs
                    })
                });

                if(!response.ok) throw new Error(await response.text());
                
                const data = await response.json();
                analysisResults = data.results; // Save for CSV
                
                // Highlight >50% visually immediately
                currentSelectionIndices.clear();
                data.results.forEach(r => {
                    if (r.frequency >= 50) currentSelectionIndices.add(r.index);
                });

                applyGridHighlights();
                updateUmapVisuals();
                
                // Show controls
                downloadCsvBtn.disabled = false;
                lockdownControls.classList.remove('hidden');
                
                setStatus(`Analysis Complete. Found ${currentSelectionIndices.size} robust outliers.`, "success");

            } catch (e) {
                console.error(e);
                setStatus("Analysis failed.", "error");
            }
        };
    }
    
    // Watchdog
    setInterval(() => {
        const gridContainer = document.getElementById('gridViewContainer');
        if((currentSelectionIndices.size > 0 || lockedIndices.size > 0) && gridContainer && gridContainer.style.display !== 'none') {
            applyGridHighlights();
        }
    }, 1000);
}

function updateUmapVisuals() {
    const indices = currentSelectionIndices.size > 0 ? Array.from(currentSelectionIndices) : [];
    highlightCurationSelection(indices);
}

function applyGridHighlights() {
    const slides = document.querySelectorAll('.swiper-slide');
    slides.forEach(slide => {
        const indexStr = slide.getAttribute('data-global-index');
        if (!indexStr) return; 
        const globalIndex = parseInt(indexStr);
        const img = slide.querySelector('img');
        if(!img) return;

        // Reset
        img.classList.remove('curation-selected-img');
        img.classList.remove('curation-locked-img');
        img.classList.remove('curation-dimmed-img');

        // Logic: Locked overrides Selected
        if (lockedIndices.has(globalIndex)) {
            img.classList.add('curation-locked-img'); // RED
        } 
        else if (currentSelectionIndices.has(globalIndex)) {
            img.classList.add('curation-selected-img'); // GREEN
        } 
        else if (currentSelectionIndices.size > 0 || lockedIndices.size > 0) {
            // Only dim if we are in an active curation mode
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