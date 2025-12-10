import { state } from './state.js';
import { highlightCurationSelection } from './umap.js';

let currentSelectionIndices = new Set();
let currentSelectionFiles = [];

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
    const seedInput = document.getElementById('curationSeed');
    const runBtn = document.getElementById('curationRunBtn');
    const exportBtn = document.getElementById('curationExportBtn');
    const closeBtn = document.getElementById('curationCloseBtn');
    const clearBtn = document.getElementById('curationClearBtn'); // NEW BUTTON
    
    // Toggle Buttons
    const methodFps = document.getElementById('methodFps');
    const methodKmeans = document.getElementById('methodKmeans');

    if (!slider || !runBtn) return;

    slider.oninput = () => number.value = slider.value;
    number.oninput = () => slider.value = number.value;

    closeBtn.onclick = window.toggleCurationPanel;

    // Method Toggles
    if (methodFps && methodKmeans) {
        methodFps.onclick = () => {
            methodFps.classList.add('active');
            methodKmeans.classList.remove('active');
        };
        methodKmeans.onclick = () => {
            methodKmeans.classList.add('active');
            methodFps.classList.remove('active');
        };
    }

    // CLEAR Logic
    if (clearBtn) {
        clearBtn.onclick = () => {
            currentSelectionIndices.clear();
            currentSelectionFiles = [];
            applyGridHighlights();
            updateUmapVisuals(); // Will clear points
            exportBtn.disabled = true;
            setStatus("", "normal");
        };
    }

    // Run Algorithm
    runBtn.onclick = async () => {
        const targetCount = parseInt(number.value);
        const seedVal = parseInt(seedInput ? seedInput.value : 42) || 42;
        // Determine Method
        const isKmeans = methodKmeans && methodKmeans.classList.contains('active');
        const method = isKmeans ? "kmeans" : "fps";

        if(!targetCount) return;
        const currentAlbum = state.album;
        if (!currentAlbum) {
            alert("No album loaded!");
            return;
        }

        setStatus(`Running ${method.toUpperCase()} Analysis...`, "loading");
        
        try {
            const response = await fetch('/api/curation/fps', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    target_count: targetCount,
                    seed: seedVal,
                    album: currentAlbum,
                    method: method // Send Method
                })
            });

            if(!response.ok) {
                const err = await response.text();
                throw new Error(err);
            }
            
            const data = await response.json();
            
            currentSelectionIndices = new Set(data.selected_indices);
            currentSelectionFiles = data.selected_files;

            applyGridHighlights();
            updateUmapVisuals();
            
            exportBtn.disabled = false;
            setStatus(`Selected ${data.count} images via ${method.toUpperCase()}.`, "success");

        } catch (e) {
            console.error(e);
            setStatus("Error: " + e.message, "error");
        }
    };

    // Export (Same as before)
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
        } catch (e) {
            alert("Export failed.");
        }
    };
    
    // Watchdog
    setInterval(() => {
        if(currentSelectionIndices.size > 0) {
            const gridContainer = document.getElementById('gridViewContainer');
            if(gridContainer && gridContainer.style.display !== 'none') applyGridHighlights();
            
            // Check UMAP Trace
            const umapPlot = document.getElementById('umapPlot');
            if (umapPlot && umapPlot.data && !umapPlot.data.some(t => t.name === 'CurationSelection')) {
                 updateUmapVisuals();
            }
        }
    }, 1000);
}

function updateUmapVisuals() {
    // Pass empty array if size is 0 to clear
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

        // If selection is empty, remove all styling
        if (currentSelectionIndices.size === 0) {
            img.classList.remove('curation-selected-img');
            img.classList.remove('curation-dimmed-img');
            return;
        }

        if (currentSelectionIndices.has(globalIndex)) {
            img.classList.add('curation-selected-img');
            img.classList.remove('curation-dimmed-img');
        } else {
            img.classList.add('curation-dimmed-img');
            img.classList.remove('curation-selected-img');
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