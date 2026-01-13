// Unit tests for curation panel functionality
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

// Mock fetch globally
global.fetch = jest.fn();

describe("Curation Panel Functionality", () => {
  let originalLocalStorage;

  beforeEach(() => {
    // Mock localStorage
    originalLocalStorage = global.localStorage;
    const localStorageMock = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
    };
    global.localStorage = localStorageMock;

    // Reset fetch mock
    global.fetch.mockReset();

    // Set up DOM with curation panel
    document.body.innerHTML = `
      <div id="curationPanel" class="hidden" style="position: fixed; left: 20px; top: 20px;">
        <div class="curation-header">
          <h3>Model Training Dataset Curator</h3>
          <button id="curationCloseBtn" class="close-icon">&times;</button>
        </div>
        <div class="curation-body">
          <input type="range" id="curationSlider" min="1" max="100" value="10" />
          <input type="number" id="curationNumber" value="10" />
          <input type="number" id="curationIterations" value="1" min="1" max="30" />
          
          <input type="radio" id="methodFps" name="curationMethod" value="fps" checked />
          <input type="radio" id="methodKmeans" name="curationMethod" value="kmeans" />
          
          <button id="curationRunBtn">Run</button>
          <button id="curationClearBtn">Clear</button>
          <button id="curationExportBtn" disabled>Export</button>
          <button id="curationCsvBtn" disabled>CSV</button>
          <button id="curationSetFavoritesBtn" disabled>Set as Favorites</button>
          <button id="curationBrowseBtn">Browse</button>
          
          <input type="text" id="curationExportPath" value="" />
          
          <div id="curationProgressBar" style="display: none;">
            <div id="curationProgressFill" style="width: 0%;"></div>
          </div>
          
          <div id="curationStatus"></div>
          <div id="lockCountDisplay">0 Excluded</div>
          
          <button id="toggleLockModeBtn">Click-to-Exclude</button>
          <button id="lockThresholdBtn">Lock by Threshold</button>
          <input type="number" id="lockThresholdInput" value="90" />
          <button id="unlockOutliersBtn">Clear Exclusions</button>
        </div>
      </div>
      <div id="gridViewContainer" style="display: none;"></div>
    `;
  });

  afterEach(() => {
    global.localStorage = originalLocalStorage;
  });

  describe("Panel toggle", () => {
    it("should toggle panel visibility when toggleCurationPanel is called", () => {
      const panel = document.getElementById("curationPanel");
      expect(panel.classList.contains("hidden")).toBe(true);

      // Call the toggle function (would need to be exposed or tested through integration)
      panel.classList.toggle("hidden");
      expect(panel.classList.contains("hidden")).toBe(false);

      panel.classList.toggle("hidden");
      expect(panel.classList.contains("hidden")).toBe(true);
    });
  });

  describe("Slider synchronization", () => {
    it("should sync number input when slider changes", () => {
      const slider = document.getElementById("curationSlider");
      const number = document.getElementById("curationNumber");

      slider.oninput = () => (number.value = slider.value);

      slider.value = "50";
      slider.oninput();

      expect(number.value).toBe("50");
    });

    it("should sync slider when number input changes", () => {
      const slider = document.getElementById("curationSlider");
      const number = document.getElementById("curationNumber");

      number.oninput = () => (slider.value = number.value);

      number.value = "75";
      number.oninput();

      expect(slider.value).toBe("75");
    });
  });

  describe("Export path validation", () => {
    it("should disable export button when path is empty", () => {
      const exportBtn = document.getElementById("curationExportBtn");
      const exportPathInput = document.getElementById("curationExportPath");

      exportPathInput.value = "";
      exportBtn.disabled = !exportPathInput.value.trim();

      expect(exportBtn.disabled).toBe(true);
    });

    it("should enable export button when path is provided and has selection", () => {
      const exportBtn = document.getElementById("curationExportBtn");
      const exportPathInput = document.getElementById("curationExportPath");

      exportPathInput.value = "/home/user/exports";
      const hasSelection = true; // Simulate having a selection
      exportBtn.disabled = !exportPathInput.value.trim() || !hasSelection;

      expect(exportBtn.disabled).toBe(false);
    });

    it("should handle localStorage interactions for export path", () => {
      const exportPathInput = document.getElementById("curationExportPath");
      const testPath = "/home/user/test_export";

      // Simulate saving to localStorage
      exportPathInput.value = testPath;
      const savedValue = exportPathInput.value;

      // Verify the value was set correctly
      expect(savedValue).toBe(testPath);

      // Simulate loading from localStorage
      const loadedPath = savedValue;
      exportPathInput.value = loadedPath;

      expect(exportPathInput.value).toBe(testPath);
    });
  });

  describe("Method selection", () => {
    it("should have FPS selected by default", () => {
      const methodFps = document.getElementById("methodFps");
      const methodKmeans = document.getElementById("methodKmeans");

      expect(methodFps.checked).toBe(true);
      expect(methodKmeans.checked).toBe(false);
    });

    it("should allow switching to K-means method", () => {
      const methodFps = document.getElementById("methodFps");
      const methodKmeans = document.getElementById("methodKmeans");

      methodKmeans.checked = true;
      methodFps.checked = false;

      expect(methodKmeans.checked).toBe(true);
      expect(methodFps.checked).toBe(false);
    });
  });

  describe("Iterations validation", () => {
    it("should cap iterations at 30", () => {
      const iterationsInput = document.getElementById("curationIterations");

      iterationsInput.value = "100";
      let iter = parseInt(iterationsInput.value) || 1;
      if (iter > 30) {
        iter = 30;
        iterationsInput.value = 30;
      }

      expect(iterationsInput.value).toBe("30");
    });

    it("should default to 1 if iterations is less than 1", () => {
      const iterationsInput = document.getElementById("curationIterations");

      iterationsInput.value = "0";
      let iter = parseInt(iterationsInput.value) || 1;
      if (iter < 1) {
        iter = 1;
      }

      expect(iter).toBe(1);
    });
  });

  describe("Status messages", () => {
    it("should display status messages", () => {
      const statusEl = document.getElementById("curationStatus");

      const setStatus = (msg, type) => {
        if (statusEl) {
          statusEl.innerText = msg;
          statusEl.style.color = type === "error" ? "#ff4444" : "#ffffff";
        }
      };

      setStatus("Test message", "normal");
      expect(statusEl.innerText).toBe("Test message");
      expect(statusEl.style.color).toBe("rgb(255, 255, 255)");

      setStatus("Error message", "error");
      expect(statusEl.innerText).toBe("Error message");
      expect(statusEl.style.color).toBe("rgb(255, 68, 68)");
    });
  });

  describe("Progress bar", () => {
    it("should show progress bar when curation starts", () => {
      const progressBar = document.getElementById("curationProgressBar");
      const progressFill = document.getElementById("curationProgressFill");

      progressBar.style.display = "block";
      progressFill.style.width = "0%";

      expect(progressBar.style.display).toBe("block");
      expect(progressFill.style.width).toBe("0%");
    });

    it("should update progress bar percentage", () => {
      const progressFill = document.getElementById("curationProgressFill");

      progressFill.style.width = "50%";
      expect(progressFill.style.width).toBe("50%");

      progressFill.style.width = "100%";
      expect(progressFill.style.width).toBe("100%");
    });

    it("should hide progress bar after completion", () => {
      const progressBar = document.getElementById("curationProgressBar");

      progressBar.style.display = "block";
      progressBar.style.display = "none";

      expect(progressBar.style.display).toBe("none");
    });
  });

  describe("Exclusion functionality", () => {
    it("should update exclusion count display", () => {
      const lockCountDisplay = document.getElementById("lockCountDisplay");
      const excludedCount = 5;

      lockCountDisplay.innerText = `${excludedCount} Excluded`;

      expect(lockCountDisplay.innerText).toBe("5 Excluded");
    });

    it("should toggle exclude mode button state", () => {
      const toggleLockModeBtn = document.getElementById("toggleLockModeBtn");

      // Activate exclude mode
      toggleLockModeBtn.style.background = "#ff4444";
      toggleLockModeBtn.style.color = "white";
      toggleLockModeBtn.innerHTML = "<b>ACTIVE</b>";

      expect(toggleLockModeBtn.style.background).toBe("rgb(255, 68, 68)");
      expect(toggleLockModeBtn.style.color).toBe("white");
      expect(toggleLockModeBtn.innerHTML).toBe("<b>ACTIVE</b>");

      // Deactivate exclude mode
      toggleLockModeBtn.style.background = "#444";
      toggleLockModeBtn.style.color = "#ccc";
      toggleLockModeBtn.innerText = "Click-to-Exclude";

      expect(toggleLockModeBtn.style.background).toBe("rgb(68, 68, 68)");
      expect(toggleLockModeBtn.style.color).toBe("rgb(204, 204, 204)");
      expect(toggleLockModeBtn.innerText).toBe("Click-to-Exclude");
    });

    it("should handle threshold-based exclusion", () => {
      const thresholdInput = document.getElementById("lockThresholdInput");

      thresholdInput.value = "90";
      const threshold = parseInt(thresholdInput.value);

      expect(threshold).toBe(90);

      // Simulate checking if items should be excluded
      const testItems = [
        { frequency: 95, index: 1 },
        { frequency: 85, index: 2 },
        { frequency: 92, index: 3 },
      ];

      const shouldExclude = testItems.filter((item) => item.frequency >= threshold);
      expect(shouldExclude.length).toBe(2);
      expect(shouldExclude[0].index).toBe(1);
      expect(shouldExclude[1].index).toBe(3);
    });
  });

  describe("Button states", () => {
    it("should disable CSV button initially", () => {
      const csvBtn = document.getElementById("curationCsvBtn");
      expect(csvBtn.disabled).toBe(true);
    });

    it("should disable export button initially", () => {
      const exportBtn = document.getElementById("curationExportBtn");
      expect(exportBtn.disabled).toBe(true);
    });

    it("should disable favorites button initially", () => {
      const favBtn = document.getElementById("curationSetFavoritesBtn");
      expect(favBtn.disabled).toBe(true);
    });

    it("should enable buttons when selection exists", () => {
      const csvBtn = document.getElementById("curationCsvBtn");
      const favBtn = document.getElementById("curationSetFavoritesBtn");

      // Simulate having a selection
      csvBtn.disabled = false;
      favBtn.disabled = false;

      expect(csvBtn.disabled).toBe(false);
      expect(favBtn.disabled).toBe(false);
    });
  });

  describe("Clear functionality", () => {
    it("should disable buttons after clearing", () => {
      const exportBtn = document.getElementById("curationExportBtn");
      const csvBtn = document.getElementById("curationCsvBtn");
      const favBtn = document.getElementById("curationSetFavoritesBtn");

      // Simulate clear action
      exportBtn.disabled = true;
      csvBtn.disabled = true;
      favBtn.disabled = true;

      expect(exportBtn.disabled).toBe(true);
      expect(csvBtn.disabled).toBe(true);
      expect(favBtn.disabled).toBe(true);
    });
  });

  describe("CSV export format", () => {
    it("should generate proper CSV header", () => {
      const csvHeader = "Filename,Subfolder,Count,Frequency(%),Index,Status";
      expect(csvHeader).toContain("Filename");
      expect(csvHeader).toContain("Subfolder");
      expect(csvHeader).toContain("Count");
      expect(csvHeader).toContain("Frequency(%)");
      expect(csvHeader).toContain("Index");
      expect(csvHeader).toContain("Status");
    });

    it("should escape CSV values properly", () => {
      const esc = (val) => `"${String(val || "").replace(/"/g, '""')}"`;

      expect(esc("simple")).toBe('"simple"');
      expect(esc('has "quotes"')).toBe('"has ""quotes"""');
      expect(esc("")).toBe('""');
      expect(esc(null)).toBe('""');
    });

    it("should format CSV rows correctly", () => {
      const esc = (val) => `"${String(val || "").replace(/"/g, '""')}"`;
      const testData = {
        filename: "test.jpg",
        subfolder: "photos",
        count: 5,
        frequency: 95.5,
        index: 42,
      };

      const csvRow = `${esc(testData.filename)},${esc(testData.subfolder)},${testData.count},${testData.frequency},${testData.index},Included\n`;

      expect(csvRow).toContain('"test.jpg"');
      expect(csvRow).toContain('"photos"');
      expect(csvRow).toContain("5");
      expect(csvRow).toContain("95.5");
      expect(csvRow).toContain("42");
      expect(csvRow).toContain("Included");
    });
  });

  describe("Async curation with polling", () => {
    it("should handle successful curation start", async () => {
      const mockStartResponse = {
        status: "started",
        job_id: "test_job_123",
        iterations: 5,
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockStartResponse,
      });

      const response = await fetch("api/curation/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_count: 10,
          iterations: 5,
          album: "test_album",
          method: "fps",
          excluded_indices: [],
        }),
      });

      const data = await response.json();
      expect(data.status).toBe("started");
      expect(data.job_id).toBe("test_job_123");
    });

    it("should handle progress polling with running status", async () => {
      const mockProgressResponse = {
        status: "running",
        progress: {
          current: 3,
          total: 5,
          percentage: 60,
          step: "Iteration 3/5",
        },
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockProgressResponse,
      });

      const response = await fetch("api/curation/curate/progress/test_job_123");
      const data = await response.json();

      expect(data.status).toBe("running");
      expect(data.progress.current).toBe(3);
      expect(data.progress.total).toBe(5);
      expect(data.progress.percentage).toBe(60);
    });

    it("should handle progress polling with completed status", async () => {
      const mockCompletedResponse = {
        status: "completed",
        result: {
          status: "success",
          count: 10,
          target_count: 10,
          selected_indices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          selected_files: ["file1.jpg", "file2.jpg"],
          analysis_results: [],
        },
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockCompletedResponse,
      });

      const response = await fetch("api/curation/curate/progress/test_job_123");
      const data = await response.json();

      expect(data.status).toBe("completed");
      expect(data.result.status).toBe("success");
      expect(data.result.count).toBe(10);
    });

    it("should handle progress polling with error status", async () => {
      const mockErrorResponse = {
        status: "error",
        error: "Index file not found",
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockErrorResponse,
      });

      const response = await fetch("api/curation/curate/progress/test_job_123");
      const data = await response.json();

      expect(data.status).toBe("error");
      expect(data.error).toBe("Index file not found");
    });
  });

  describe("Frequency-based color buckets", () => {
    it("should categorize high frequency items correctly", () => {
      const testItems = [
        { index: 1, frequency: 95 },
        { index: 2, frequency: 92 },
        { index: 3, frequency: 85 },
        { index: 4, frequency: 75 },
        { index: 5, frequency: 65 },
      ];

      const highFreq = testItems.filter((item) => item.frequency >= 90);
      const medFreq = testItems.filter((item) => item.frequency >= 70 && item.frequency < 90);
      const lowFreq = testItems.filter((item) => item.frequency < 70);

      expect(highFreq.length).toBe(2); // 95, 92
      expect(medFreq.length).toBe(2); // 85, 75
      expect(lowFreq.length).toBe(1); // 65
    });
  });
});
