// search.js
// This file handles the search functionality for the Clipslide application.
// Swiper initialization
import { searchImage, searchText } from "./api.js";
import { clusterDisplay } from "./cluster-display.js";
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
    e.stopPropagation();
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

  document.addEventListener(
    "click",
    function (e) {
      if (textSearchPanel.style.display === "block") {
        if (
          !textSearchPanel.contains(e.target) &&
          !textSearchBtn.contains(e.target)
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          textSearchPanel.style.opacity = 0;
          setTimeout(() => {
            textSearchPanel.style.display = "none";
          }, 200);
        }
      }
    },
    true
  );

  textSearchPanel.addEventListener("click", function (e) {
    e.stopPropagation();
  });

  const doSearchBtn = document.getElementById("doSearchBtn");
  const searchInput = document.getElementById("searchInput");
  doSearchBtn.addEventListener("click", searchWithText);

  async function searchWithText() {
    const query = searchInput.value.trim();
    if (!query) return;
    const slideShowRunning = state.swiper?.autoplay?.running;
    pauseSlideshow();

    try {
      showSpinner();
      const results = await searchText(query);
      state.searchResults = results.filter((item) => item.score >= 0.2);
      await resetSlidesAndAppend();
      updateSearchCheckmarks();
      setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
      setCheckmarkOnIcon(document.getElementById("textSearchIcon"), true);
      window.dispatchEvent(
        new CustomEvent("searchResultsChanged", { detail: state.searchResults })
      );

      setTimeout(() => {
        textSearchPanel.style.opacity = 0;
        textSearchPanel.style.display = "none";
      }, 200);

      if (state.searchResults.length > 0) {
        scoreDisplay.show(state.searchResults[0].score);
      }
    } catch (err) {
      scoreDisplay.hide();
      hideSpinner();
      console.error("Search request failed:", err);
    } finally {
      hideSpinner();
      if (slideShowRunning) resumeSlideshow();
    }
  }

  const imageSearchBtn = document.getElementById("imageSearchBtn");
  imageSearchBtn.addEventListener("click", async function () {
    const slide = state.swiper.slides[state.swiper.activeIndex];
    if (!slide) return;
    const imgUrl = slide.querySelector("img")?.src;
    const filename = slide.dataset.filename || "image.jpg";
    if (!imgUrl) return;

    try {
      const slideShowRunning = state.swiper?.autoplay?.running;
      pauseSlideshow();
      showSpinner();
      const imgResponse = await fetch(imgUrl);
      const blob = await imgResponse.blob();
      const file = new File([blob], filename, { type: blob.type });
      let querySlide = createQuerySlide(imgUrl, `Search slide ${filename}`);
      await searchWithImage(file, querySlide);
      hideSpinner();
      if (slideShowRunning) resumeSlideshow();
    } catch (err) {
      hideSpinner();
      console.error("Image similarity search failed:", err);
    }
  });

  const uploadImageLink = document.getElementById("uploadImageLink");
  const uploadImageInput = document.getElementById("uploadImageInput");

  uploadImageLink.addEventListener("click", function (e) {
    e.preventDefault();
    uploadImageInput.click();
  });

  uploadImageInput.addEventListener("change", async function (e) {
    const file = e.target.files[0];
    if (file && file.type.startsWith("image/")) {
      showSpinner();
      try {
        let slide = await insertUploadedImageFile(file);
        await searchWithImage(file, slide);
      } finally {
        hideSpinner();
      }
      updateSearchCheckmarks();
    }
  });

  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearchBtn.click();
    }
  });

  const clearSearchBtn = document.getElementById("clearSearchBtn");
  clearSearchBtn.addEventListener("click", function () {
    const slideShowRunning =
      state.swiper && state.swiper.autoplay && state.swiper.autoplay.running;
    clearSearchAndResetCarousel();
    if (slideShowRunning) resumeSlideshow();
  });

  const clearTextSearchBtn = document.getElementById("clearTextSearchBtn");
  clearTextSearchBtn.addEventListener("click", function () {
    searchInput.value = "";
  });

  updateSearchCheckmarks();

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
      let slide = await insertUploadedImageFile(file);
      await searchWithImage(file, slide);
      updateSearchCheckmarks();
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
      let slide = await insertUploadedImageFile(file);
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

  window.addEventListener("umapClusterSelected", async function (e) {
    state.searchResults = e.detail;
    state.searchOrigin = 0;
    await resetSlidesAndAppend();
    updateSearchCheckmarks();
    setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), true);
    setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
    if (state.searchResults.length > 0) {
      clusterDisplay.show(
        state.searchResults[0].cluster,
        state.searchResults[0].color || "#000000"
      );
    }
  });

  // Called whenever the search results are updated
  window.addEventListener("searchResultsChanged", async function (e) {
    state.searchResults = e.detail;
    state.searchOrigin = 0;
    await resetSlidesAndAppend();
    updateSearchCheckmarks();
    // setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), true);
    // setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
  });
});

export async function searchWithImage(file, first_slide) {
  try {
    showSpinner();
    const results = await searchImage(file);
    state.searchResults = results.filter((item) => item.score >= 0.6);
    await resetSlidesAndAppend(first_slide);
    updateSearchCheckmarks();
    setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), true);
    setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
    window.dispatchEvent(
      new CustomEvent("searchResultsChanged", { detail: state.searchResults })
    );
  } catch (err) {
    console.error("Image search request failed:", err);
    return [];
  } finally {
    hideSpinner();
  }
}

function createQuerySlide(url, filename) {
  const displayLabel = filename || "Query Image";
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

export async function clearSearchAndResetCarousel() {
  if (state.swiper?.autoplay?.running) {
    pauseSlideshow();
  }
  exitSearchMode();
  await resetAllSlides();
  updateSearchCheckmarks();
  if (typeof textSearchPanel !== "undefined") {
    textSearchPanel.style.opacity = 0;
    setTimeout(() => {
      textSearchPanel.style.display = "none";
    }, 200);
  }
  setCheckmarkOnIcon(document.getElementById("imageSearchIcon"), false);
  setCheckmarkOnIcon(document.getElementById("textSearchIcon"), false);
  window.dispatchEvent(
    new CustomEvent("searchResultsChanged", { detail: [] })
  );
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
            state.swiper.slideTo(0);
            hideSpinner();
          };
          reader.readAsDataURL(file);
          updateSearchCheckmarks();
        } catch (err) {
          hideSpinner();
          console.error("Image similarity search failed:", err);
        }
        break;
      }
    }
  }
});

export function exitSearchMode() {
  state.searchResults = [];
  state.searchOrigin = 0;
  state.dataChanged = true;
  scoreDisplay.hide();
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = "";
  updateSearchCheckmarks();
  console.log("Exited search mode");
}
