// search.js
// This file handles the search functionality for the Clipslide application.
// Swiper initialization
import { searchImage, searchText } from "./api.js";
import { scoreDisplay } from "./score-display.js";
import { state } from "./state.js";
import {
  pauseSlideshow,
  resetAllSlides,
  resetSlidesAndAppend,
  resumeSlideshow,
} from "./swiper.js";
import { hideSpinner, setCheckmarkOnIcon, showSpinner } from "./utils.js";

document.addEventListener("DOMContentLoaded", async function () {
  const textSearchPanel = document.getElementById("textSearchPanel");
  const textSearchBtn = document.getElementById("textSearchBtn");

  textSearchBtn.addEventListener("click", function (e) {
    e.stopPropagation(); // Prevent this click from bubbling up
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

  // Add click-outside-to-close functionality with event prevention
  document.addEventListener("click", function (e) {
    // Check if the panel is visible
    if (textSearchPanel.style.display === "block") {
      // Check if the click was outside the panel and not on the button
      if (
        !textSearchPanel.contains(e.target) &&
        !textSearchBtn.contains(e.target)
      ) {
        // Prevent the event from triggering other handlers
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Hide the panel
        textSearchPanel.style.opacity = 0;
        setTimeout(() => {
          textSearchPanel.style.display = "none";
        }, 200);
      }
    }
  }, true); // Use capture phase to intercept events early

  // Prevent clicks inside the panel from closing it
  textSearchPanel.addEventListener("click", function (e) {
    e.stopPropagation();
  });

  const doSearchBtn = document.getElementById("doSearchBtn");
  const searchInput = document.getElementById("searchInput");

  // Text search handler
  doSearchBtn.addEventListener("click", searchWithText);

  async function searchWithText() {
    const query = searchInput.value.trim();
    if (!query) return;
    const slideShowRunning = state.swiper?.autoplay?.running;
    pauseSlideshow();

    try {
      showSpinner();
      state.searchResults = [];
      state.searchIndex = 0; // Reset search index for new search
      const results = await searchText(query);
      state.searchResults = results.filter((item) => item.score >= 0.2);
      await resetSlidesAndAppend();
      updateSearchCheckmarks();
      // Set checkmarks on icons based on the current mode
      setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
      setCheckmarkOnIcon(document.getElementById("textSearchIcon"), true);
      setTimeout(() => {
        textSearchPanel.style.opacity = 0;
        textSearchPanel.style.display = "none";
      }, 200);

      if (state.searchResults.length > 0) {
        scoreDisplay.show(state.searchResults[0].score);
      }
    } catch (err) {
      scoreDisplay.hide(); // Hide on error
      hideSpinner();
      console.error("Search request failed:", err);
    } finally {
      hideSpinner();
      if (slideShowRunning) resumeSlideshow(); // Resume slideshow after search
    }
  }

  // Image search button handler
  const imageSearchBtn = document.getElementById("imageSearchBtn");
  imageSearchBtn.addEventListener("click", async function () {
    // Get the current slide's image URL and filename
    const slide = state.swiper.slides[state.swiper.activeIndex];
    if (!slide) return;
    const imgUrl = slide.querySelector("img")?.src;
    const filename = slide.dataset.filename || "image.jpg";
    if (!imgUrl) return;

    try {
      const slideShowRunning = state.swiper?.autoplay?.running;
      pauseSlideshow();
      showSpinner();
      // Fetch the image as a Blob and send to searchWithImage
      const imgResponse = await fetch(imgUrl);
      const blob = await imgResponse.blob();
      const file = new File([blob], filename, { type: blob.type });
      let querySlide = createQuerySlide(imgUrl, `Search slide ${filename}`); // Insert the image as the first slide
      await searchWithImage(file, querySlide);
      hideSpinner();
      if (slideShowRunning) resumeSlideshow(); // Resume slideshow after search
    } catch (err) {
      hideSpinner();
      console.error("Image similarity search failed:", err);
    }
  });

  // --- Upload Image File Button Logic ---
  const uploadImageLink = document.getElementById("uploadImageLink");
  const uploadImageInput = document.getElementById("uploadImageInput");

  // Click opens file dialog
  uploadImageLink.addEventListener("click", function (e) {
    e.preventDefault();
    uploadImageInput.click();
  });

  // File selected via dialog
  uploadImageInput.addEventListener("change", async function (e) {
    const file = e.target.files[0];
    if (file && file.type.startsWith("image/")) {
      showSpinner();
      try {
        let slide = await insertUploadedImageFile(file); // Insert the image as the first slide
        await searchWithImage(file, slide);
      } finally {
        hideSpinner();
      }
      updateSearchCheckmarks();
    }
  });

  // Handle Enter key in search input
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

  // Drag and drop functionality for textSearchPanel
  textSearchPanel.addEventListener("dragover", function (e) {
    e.preventDefault();
    textSearchPanel.classList.add("dragover");
  });
  
  textSearchPanel.addEventListener("dragleave", function (e) {
    e.preventDefault();
    textSearchPanel.classList.remove("dragover");
  });
  
  textSearchPanel.addEventListener("drop", async function (e) {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) return;

    showSpinner();
    try {
      let slide = await insertUploadedImageFile(file); // Insert the image as the first slide
      await searchWithImage(file, slide);
      updateSearchCheckmarks();
      
      // Hide the panel after successful image search
      textSearchPanel.style.opacity = 0;
      setTimeout(() => {
        textSearchPanel.style.display = "none";
      }, 200);
    } catch (err) {
      console.error("Image search failed:", err);
      alert("Failed to search with image: " + err.message);
    } finally {
      textSearchPanel.classList.remove("dragover");
      hideSpinner();
    }
  });

  // Drag and drop functionality for search panel
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
      let slide = await insertUploadedImageFile(file); // Insert the image as the first slide
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
});

// This searches by an image. first_slide, if provided, is an additional
// slide (external image) to be added to the carousel at the front.
export async function searchWithImage(file, first_slide) {
  try {
    showSpinner();
    state.searchResults = [];
    state.searchIndex = 0;
    const results = await searchImage(file);
    state.searchResults = results.filter((item) => item.score >= 0.6);
    await resetSlidesAndAppend(first_slide);
    updateSearchCheckmarks(); // Add this line!
    // Set checkmarks on icons based on the current mode
    setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), true);
    setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
  } catch (err) {
    console.error("Image search request failed:", err);
    return [];
  } finally {
    hideSpinner();
  }
}

// Create a new slide with the uploaded image file
function createQuerySlide(url, filename) {
  const displayLabel = filename || "Query Image";
  // Create a new slide element
  const slide = document.createElement("div");
  slide.className = "swiper-slide";
  slide.innerHTML = `
            <div style="position:relative; width:100%; height:100%;">
                <span class="query-image-label">${displayLabel}</span>
                <img src="${url}" alt="" draggable="true" class="slide-image">
            </div>
        `;
  slide.dataset.filename = filename || "";
  slide.dataset.description = "Query image";
  slide.dataset.textToCopy = "";
  slide.dataset.filepath = "";
  return slide;
}

// Insert an uploaded file into the carousel
async function insertUploadedImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function (event) {
      const url = event.target.result;
      const slide = createQuerySlide(url, file.name);
      resolve(slide);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Show/hide the clearSearchBtn based on searchResults
function updateSearchCheckmarks() {
  const clearSearchBtn = document.getElementById("clearSearchBtn");

  if (state.searchResults?.length > 0) {
    clearSearchBtn.style.display = "block";
  } else {
    clearSearchBtn.style.display = "none";
    setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
    setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
  }
}

// Utility: Clear search results and reset the carousel
async function clearSearchAndResetCarousel() {
  const searchInput = document.getElementById("searchInput");

  if (state.swiper?.autoplay?.running) {
    pauseSlideshow(); // Pause the slideshow if it's running
  }
  exitSearchMode(); // Clear search results and reset index
  await resetAllSlides(); // Clear all slides in the carousel
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

// In resetAllSlides or when exiting search mode:
export function exitSearchMode() {
  state.searchResults = [];
  state.searchIndex = 0;
  scoreDisplay.hide(); // Hide score when exiting search
  searchInput.value = "";
  updateSearchCheckmarks();
  console.log("Exited search mode");
}
