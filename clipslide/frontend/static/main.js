// This file actually drives the slideshow

import {state} from './javascript/state.js';
import { pauseSlideshow, resumeSlideshow, addNewSlide } from './javascript/swiper.js';
import { showSpinner, hideSpinner } from './javascript/utils.js';
import { showPauseOverlay, hidePauseOverlay } from './javascript/overlay.js';
import {} from './javascript/events.js';

// Delay controls
const delayStep = 1; // seconds to increase/decrease per click
const minDelay = 1; // minimum delay in seconds
const maxDelay = 60; // maximum delay in seconds

function setDelay(newDelay) {
  newDelay = Math.max(minDelay, Math.min(maxDelay, newDelay));
  state.currentDelay = newDelay;
  state.swiper.params.autoplay.delay = state.currentDelay * 1000;
  updateDelayDisplay(newDelay);
  saveSettingsToLocalStorage();
}

function updateDelayDisplay(newDelay) {
  const delayValueSpan = document.getElementById("delayValue");
  if (delayValueSpan) {
    delayValueSpan.textContent = newDelay;
  }
}

// Swiper initialization
document.addEventListener("DOMContentLoaded", async function () {


  let slowerBtn = document.getElementById("slowerBtn");
  let fasterBtn = document.getElementById("fasterBtn");

  slowerBtn.onclick = function () {
    let newDelay = Math.min(maxDelay, state.currentDelay + delayStep);
    setDelay(newDelay);
  };

  fasterBtn.onclick = function () {
    let newDelay = Math.max(minDelay, state.currentDelay - delayStep);
    setDelay(newDelay);
  };
  updateDelayDisplay(state.currentDelay);

  // Set initial radio button state based on current mode
  document.getElementById("modeRandom").checked = state.mode === "random";
  document.getElementById("modeSequential").checked = state.mode === "sequential";

  // Listen for changes to the radio buttons
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      if (this.checked) {
        state.mode = this.value;
        saveSettingsToLocalStorage();
        // Remove all slides from the current position to the end
        for (let i = state.swiper.slides.length - 1; i > state.swiper.activeIndex; i--) {
          state.swiper.removeSlide(i);
        }
        addNewSlide(); // Add a new slide based on the new mode
      }
    });
  });

  const textSearchPanel = document.getElementById("textSearchPanel");
  const textSearchBtn = document.getElementById("textSearchBtn");

  textSearchBtn.addEventListener("click", function (e) {
    if (
      textSearchPanel.style.display === "none" ||
      textSearchPanel.style.display === ""
    ) {
      textSearchPanel.focus();
      setTimeout(() => {
        textSearchPanel.style.display = "block";
        textSearchPanel.style.opacity = 1;
      }, 20);
    } else {
      textSearchPanel.style.display = "none";
      textSearchPanel.style.opacity = 0;
    }
  });

  const doSearchBtn = document.getElementById("doSearchBtn");
  const searchInput = document.getElementById("searchInput");

  // Text search handler
  doSearchBtn.addEventListener("click", async function () {
    const query = searchInput.value.trim();
    if (!query) return;
    const formData = new FormData();
    formData.append("text_query", query);
    formData.append("top_k", 100);
    formData.append("embeddings_file", state.embeddingsFile);

    try {
      showSpinner();
      state.searchResults = [];
      state.searchIndex = 0; // Reset search index for new search
      const response = await fetch("search_with_text/", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      result.results = result.results.filter((item) => item.score >= 0.2);
      state.searchResults = result.results.map((item) => item.filename);
      await showSearchResults();
      hideSpinner();
      // Set checkmarks on icons based on the current mode
      setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
      setCheckmarkOnIcon(document.getElementById("textSearchIcon"), true);
      setTimeout(() => {
        textSearchPanel.style.opacity = 0;
        textSearchPanel.style.display = "none";
      }, 200);
    } catch (err) {
      hideSpinner();
      console.error("Search request failed:", err);
    }
  });

  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearchBtn.click();
    }
  });

  // Clear search button handler
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  clearSearchBtn.addEventListener("click", function () {
    const slideShowRunning =
      state.swiper && state.swiper.autoplay && state.swiper.autoplay.running;
    clearSearchAndResetCarousel();
    if (slideShowRunning) resumeSlideshow(); // Resume slideshow if it was running
  });

  // Clear text search handler
  const clearTextSearchBtn = document.getElementById("clearTextSearchBtn");
  clearTextSearchBtn.addEventListener("click", function () {
    searchInput.value = "";
  });

  // Initial call to set visibility based on default searchResults value
  updateSearchCheckmarks();

  const imageSearchBtn = document.getElementById("imageSearchBtn");
  // Image search button handler
  imageSearchBtn.addEventListener("click", async function () {
    // Get the current slide's image URL and filename
    const slide = state.swiper.slides[state.swiper.activeIndex];
    if (!slide) return;
    const imgUrl = slide.querySelector("img")?.src;
    const filename = slide.dataset.filename || "image.jpg";
    if (!imgUrl) return;

    try {
      showSpinner();
      // Fetch the image as a Blob and send to searchWithImage
      const imgResponse = await fetch(imgUrl);
      const blob = await imgResponse.blob();
      const file = new File([blob], filename, { type: blob.type });
      await searchWithImage(file);
      hideSpinner();
      if (!(state.swiper && state.swiper.autoplay && state.swiper.autoplay.running)) {
        resumeSlideshow(); // Resume slideshow after search
      }
    } catch (err) {
      hideSpinner();
      console.error("Image similarity search failed:", err);
    }
  });

  // --- Upload Image File Button Logic ---
  const uploadImageFileBtn = document.getElementById("uploadImageFileBtn");
  const uploadImageInput = document.getElementById("uploadImageInput");

  // Click opens file dialog
  uploadImageFileBtn.addEventListener("click", function (e) {
    uploadImageInput.value = ""; // Reset so same file can be uploaded again
    uploadImageInput.click();
  });

  // File selected via dialog
  uploadImageInput.addEventListener("change", async function (e) {
    const file = e.target.files[0];
    if (file && file.type.startsWith("image/")) {
      showSpinner();
      try {
        slide = await createSearchImageSlide(file); // Insert the image as the first slide
        await searchWithImage(file, slide);
      } finally {
        hideSpinner();
      }
      updateSearchCheckmarks();
    }
  });

  const searchPanel = document.getElementById("searchPanel");
  searchPanel.addEventListener("dragover", function (e) {
    e.preventDefault();
    searchPanel.classList.add("dragover");
  });
  searchPanel.addEventListener("dragleave", function (e) {
    e.preventDefault();
    searchPanel.classList.remove("dragover");
  });
  searchPanel.addEventListener("drop", async function (e) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) return;

    showSpinner();
    try {
      slide = await createSearchImageSlide(file); // Insert the image as the first slide
      await searchWithImage(file, slide);
      updateSearchCheckmarks();
    } catch (err) {
      console.error("Image search failed:", err);
      alert("Failed to search with image: " + err.message);
    } finally {
      searchPanel.classList.remove("dragover");
      hideSpinner();
    }
  });

  // Handler for the delete (trash) button
  const delete_current_file_btn = document.getElementById(
    "deleteCurrentFileBtn"
  );
  delete_current_file_btn.addEventListener("click", async function () {
    const currentFilepath = getCurrentFilepath();

    if (!currentFilepath) {
      alert("No image selected for deletion.");
      return;
    }

    // Show confirmation dialog
    const confirmDelete = confirm(
      `Are you sure you want to delete this image?\n\n${currentFilepath}\n\nThis action cannot be undone.`
    );

    if (!confirmDelete) {
      return; // User cancelled, do nothing
    }

    try {
      // Show spinner during deletion
      showSpinner();

      // Call the delete function
      await deleteCurrentFile();

      // Remove the current slide from swiper
      if (state.swiper && state.swiper.slides && state.swiper.slides.length > 0) {
        const currentIndex = state.swiper.activeIndex;
        state.swiper.removeSlide(currentIndex);

        // If no slides left, add a new one
        if (state.swiper.slides.length === 0) {
          await addNewSlide();
        }

        // Update overlay with new current slide
        updateOverlay();
      }

      hideSpinner();
      console.log("Image deleted successfully");
    } catch (error) {
      hideSpinner();
      alert(`Failed to delete image: ${error.message}`);
      console.error("Delete failed:", error);
    }
  });

  // Handlers for the settings modal
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsOverlay = document.getElementById("settingsOverlay");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const highWaterMarkInput = document.getElementById("highWaterMarkInput");
  const delayValueSpan = document.getElementById("delayValue");
  const modeRandom = document.getElementById("modeRandom");
  const modeSequential = document.getElementById("modeSequential");

  // Open settings modal and populate fields
  settingsBtn.addEventListener("click", () => {
    if (settingsOverlay.style.display === "none") {
      // Populate fields with current values
      highWaterMarkInput.value = state.highWaterMark;
      delayValueSpan.textContent = state.currentDelay;
      if (state.mode === "random") modeRandom.checked = true;
      if (state.mode === "sequential") modeSequential.checked = true;
      settingsOverlay.style.display = "block";
    } else {
      settingsOverlay.style.display = "none";
    }
  });

  // Close modal without saving
  closeSettingsBtn.addEventListener("click", () => {
    settingsOverlay.style.display = "none";
  });

  // Optional: close overlay when clicking outside the modal
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) {
      settingsOverlay.style.display = "none";
    }
  });

  // Save settings and close modal
  saveSettingsBtn.addEventListener("click", () => {
    // Get values from fields
    let newHighWaterMark = parseInt(highWaterMarkInput.value, 10);
    if (isNaN(newHighWaterMark) || newHighWaterMark < 2) newHighWaterMark = 2;
    if (newHighWaterMark > 100) newHighWaterMark = 100;

    let newDelay = parseInt(delayValueSpan.textContent, 10);
    if (isNaN(newDelay) || newDelay < minDelay) newDelay = minDelay;
    if (newDelay > maxDelay) newDelay = maxDelay;

    let newMode = modeRandom.checked ? "random" : "sequential";

    // Apply and save
    setHighWaterMark(newHighWaterMark);
    state.currentDelay = newDelay;
    state.swiper.params.autoplay.delay = state.currentDelay * 1000; // convert to milliseconds;

    state.mode = newMode;
    saveSettingsToLocalStorage();

    // Update radio buttons if needed
    document.getElementById("modeRandom").checked = state.mode === "random";
    document.getElementById("modeSequential").checked = state.mode === "sequential";

    settingsOverlay.style.display = "none";
  });
});
async function searchWithImage(file, first_slide) {
  const formData = new FormData();
  formData.append("file", file); // file is a File object from an <input type="file">
  formData.append("top_k", 100); // Default to 100 results
  formData.append("embeddings_file", state.embeddingsFile);

  try {
    showSpinner();
    state.searchResults = [];
    state.searchIndex = 0; // Reset search index for new search

    const response = await fetch("search_with_image/", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();

    // filter the results by score, keeping everything with a score >= 0.6
    result.results = result.results.filter((item) => item.score >= 0.6);
    state.searchResults = result.results.map((item) => item.filename);
    await showSearchResults(first_slide);
    // Set checkmarks on icons based on the current mode
    setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), true);
    setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
    hideSpinner();
  } catch (err) {
    console.error("Image search request failed:", err);
    return [];
  }
}

// Utility function to insert a search image into the carousel
async function createSearchImageSlide(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function (event) {
      const url = event.target.result;
      const slide = document.createElement("div");
      slide.className = "swiper-slide";
      slide.innerHTML = `
                <div style="position:relative; width:100%; height:100%;">
                    <span class="query-image-label">Query Image</span>
                    <img src="${url}" alt="" draggable="true" class="slide-image">
                </div>
            `;
      slide.dataset.filename = file.name || "";
      slide.dataset.description = "Query image";
      slide.dataset.textToCopy = "";
      slide.dataset.filepath = "";
      resolve(slide);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Show/hide the clearSearchBtn based on searchResults
function updateSearchCheckmarks() {
  const searchIcon = document.getElementById("searchIcon");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  // Remove any existing checkmark overlay
  let checkOverlay =
    searchIcon?.parentElement?.querySelector(".checkmark-overlay");
  if (checkOverlay) checkOverlay.remove();
  if (state.searchResults && state.searchResults.length > 0) {
    clearSearchBtn.style.display = "flex";
  } else {
    clearSearchBtn.style.display = "none";
  }
}


async function deleteCurrentFile() {
  const filepath = getCurrentFilepath();
  if (!filepath) {
    console.warn("No filepath available to delete.");
    return;
  }
  showSpinner();
  try {
    // Use DELETE method with filepath as query parameter
    const response = await fetch(
      `delete_image/?file_to_delete=${encodeURIComponent(
        filepath
      )}&embeddings_file=${encodeURIComponent(state.embeddingsFile)}`,
      {
        method: "DELETE",
      }
    );

    // check status
    if (!response.ok) {
      throw new Error(`Failed to delete image: ${response.statusText}`);
    }
    const data = await response.json();
    // remove current slide from swiper
    const currentSlide = state.swiper.slides[state.swiper.activeIndex];
    if (currentSlide && currentSlide.dataset.filepath === filepath) {
      state.swiper.removeSlide(state.swiper.activeIndex);
    }
    updateOverlay();
    // addNewSlide(); // Add a new slide after deletion

    hideSpinner();
    return data;
  } catch (e) {
    hideSpinner();
    console.warn("Failed to delete image.");
    throw e;
  }
}

function getCurrentFilepath() {
  return document.getElementById("filepathText")?.textContent?.trim();
}

// Utility: Clear search results and reset the carousel
async function clearSearchAndResetCarousel() {
  const searchInput = document.getElementById("searchInput");

  if (state.swiper && state.swiper.autoplay && state.swiper.autoplay.running) {
    pauseSlideshow(); // Pause the slideshow if it's running
  }
  searchInput.value = "";
  state.searchResults = [];
  state.searchIndex = 0; // Reset search index
  if (state.swiper && state.swiper.slides && state.swiper.slides.length > 0) {
    state.swiper.removeAllSlides();
  }
  await addNewSlide();
  await addNewSlide();
  updateSearchCheckmarks();
  // Hide the search panel if open
  if (typeof textSearchPanel !== "undefined") {
    textSearchPanel.style.opacity = 0;
    setTimeout(() => {
      textSearchPanel.style.display = "none";
    }, 200);
  }

  setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
  setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
}

// Utility: Show search results in the carousel
async function showSearchResults(first_slide) {
  const slideShowRunning = state.swiper && state.swiper.autoplay && state.swiper.autoplay.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (state.swiper && state.swiper.slides && state.swiper.slides.length > 0) {
    state.swiper.removeAllSlides();
  }
  if (first_slide) {
    state.swiper.appendSlide(first_slide);
  } else {
    await addNewSlide();
  }
  await addNewSlide(); // needed to enable navigation buttons
  // restart the slideshow if it was running
  if (slideShowRunning) resumeSlideshow();
  updateSearchCheckmarks();
}

// --- Refactor event handlers to use these utilities ---

window.addEventListener("paste", async function (e) {
  if (!e.clipboardData) return;
  const items = e.clipboardData.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        showSpinner();
        try {
          // Add the pasted image as the first slide
          const reader = new FileReader();
          reader.onload = async function (event) {
            const url = event.target.result;
            const slide = document.createElement("div");
            slide.className = "swiper-slide";
            slide.innerHTML = `
                            <div style="position:relative; width:100%; height:100%;">
                                <span class="query-image-label">Query Image</span>
                                <img src="${url}" alt="" draggable="true" class="slide-image">
                            </div>
                        `;
            slide.dataset.filename = file.name || "";
            slide.dataset.description = "Query image";
            slide.dataset.textToCopy = "";
            slide.dataset.filepath = "";
            await searchWithImage(file, slide);
            state.swiper.slideTo(0); // Go to the first slide
            hideSpinner();
          };
          reader.readAsDataURL(file);
          updateSearchCheckmarks();
        } catch (err) {
          hideSpinner();
          console.error("Image similarity search failed:", err);
        }
        break; // Only handle the first image
      }
    }
  }
});

function joinPath(dir, relpath) {
  if (dir.endsWith("/")) dir = dir.slice(0, -1);
  if (relpath.startsWith("/")) relpath = relpath.slice(1);
  return dir + "/" + relpath;
}

function setCheckmarkOnIcon(iconElement, show) {
  // Remove any existing checkmark
  let checkOverlay =
    iconElement?.parentElement?.querySelector(".checkmark-overlay");
  if (checkOverlay) checkOverlay.remove();

  if (show) {
    const check = document.createElement("div");
    check.className = "checkmark-overlay";
    check.innerHTML = `
            <svg width="38" height="38" viewBox="0 0 32 32" style="position:absolute;top:-8px;left:-8px;pointer-events:none;">
                <circle cx="16" cy="16" r="15" fill="limegreen" opacity="0.8"/>
                <polyline points="10,17 15,22 23,12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
    check.style.position = "absolute";
    check.style.top = "0";
    check.style.left = "0";
    check.style.width = "100%";
    check.style.height = "100%";
    check.style.display = "flex";
    check.style.alignItems = "center";
    check.style.justifyContent = "center";
    check.style.pointerEvents = "none";
    iconElement.parentElement.style.position = "relative";
    iconElement.parentElement.appendChild(check);
  }
}

function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", state.highWaterMark);
  localStorage.setItem("currentDelay", state.currentDelay);
  localStorage.setItem("mode", state.mode);
}

// Call this function whenever you update any of the three values:
function setHighWaterMark(newMark) {
  state.highWaterMark = newMark;
  saveSettingsToLocalStorage();
}

