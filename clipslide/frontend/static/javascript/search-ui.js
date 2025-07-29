// search.js
// This file handles the search functionality for the Clipslide application.
// Swiper initialization
import { clusterDisplay } from "./cluster-display.js";
import { scoreDisplay } from "./score-display.js";
import { searchImage } from "./search.js";
import { state } from "./state.js";
import { pauseSlideshow, resetAllSlides, resumeSlideshow } from "./swiper.js";
import { hideSpinner, setCheckmarkOnIcon, showSpinner } from "./utils.js";
import { WeightSlider } from "./weight-slider.js";

let posPromptWeight = 0.5; // Default weight for positive prompts
let negPromptWeight = 0.25; // Default weight for negative prompts
let imgPromptWeight = 0.5; // Default weight for image prompts
let currentSearchImageUrl = null; // Track the current image URL

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
  const negativeSearchInput = document.getElementById("negativeSearchInput");

  doSearchBtn.addEventListener("click", searchWithTextAndImage);

  async function searchWithTextAndImage() {
    const positiveQuery = searchInput.value.trim();
    const negativeQuery = negativeSearchInput.value.trim();
    const imageFile = state.currentSearchImageFile || null; // You need to set this when an image is uploaded or selected

    // Get weights from sliders
    const posWeight = posPromptWeightSlider.getValue ? posPromptWeightSlider.getValue() : posPromptWeight;
    const negWeight = negPromptWeightSlider.getValue ? negPromptWeightSlider.getValue() : negPromptWeight;
    const imgWeight = imgPromptWeightSlider.getValue ? imgPromptWeightSlider.getValue() : imgPromptWeight;

    if (!positiveQuery && !negativeQuery && !imageFile) return;

    const slideShowRunning = state.swiper?.autoplay?.running;
    pauseSlideshow();

    try {
      showSpinner();

      const formData = new FormData();
      if (imageFile) formData.append("file", imageFile);
      formData.append("positive_query", positiveQuery);
      formData.append("negative_query", negativeQuery);
      formData.append("image_weight", imgWeight);
      formData.append("positive_weight", posWeight);
      formData.append("negative_weight", negWeight);
      formData.append("top_k", 100);
      formData.append("album", state.album);

      const response = await fetch("search_with_text_and_image/", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      let results = result.results || [];
      results = results.filter((item) => item.score >= 0.2);

      window.dispatchEvent(
        new CustomEvent("searchResultsChanged", {
          detail: { results: results, searchType: "text_and_image" },
        })
      );

      setTimeout(() => {
        textSearchPanel.style.opacity = 0;
        textSearchPanel.style.display = "none";
      }, 200);
    } catch (err) {
      scoreDisplay.hide();
      hideSpinner();
      console.error("Search request failed:", err);
    } finally {
      hideSpinner();
      if (slideShowRunning) resumeSlideshow();
    }
  }

  // Image Search
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
      // Set the search image for the panel
      setSearchImage(imgUrl, file);
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
        const reader = new FileReader();
        reader.onload = function (event) {
          setSearchImage(event.target.result, file);
        };
        reader.readAsDataURL(file);
        let slide = await insertUploadedImageFile(file);
        await searchWithImage(file, slide);
      } finally {
        hideSpinner();
      }
    }
  });

  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearchBtn.click();
    }
  });

  negativeSearchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearchBtn.click();
    }
  });

  const posPromptWeightSlider = new WeightSlider(
    document.getElementById("posPromptWeightSlider"),
    0.5,
    (val) => {
      posPromptWeight = val;
      console.log("Positive prompt weight set to:", val);
    }
  );

  const negPromptWeightSlider = new WeightSlider(
    document.getElementById("negPromptWeightSlider"),
    0.25,
    (val) => {
      negPromptWeight = val;
      console.log("Negative prompt weight set to:", val);
    }
  );

  const imgPromptWeightSlider = new WeightSlider(
    document.getElementById("imgPromptWeightSlider"),
    0.5,
    (val) => {
      imgPromptWeight = val;
      console.log("Image prompt weight set to:", val);
    }
  );

  const clearSearchBtn = document.getElementById("clearSearchBtn");
  clearSearchBtn.addEventListener("click", function () {
    exitSearchMode();
  });

  const clearTextSearchBtn = document.getElementById("clearTextSearchBtn");
  clearTextSearchBtn.addEventListener("click", function () {
    searchInput.value = "";
  });

  const clearNegativeTextSearchBtn = document.getElementById(
    "clearNegativeTextSearchBtn"
  );
  clearNegativeTextSearchBtn.addEventListener("click", () => {
    negativeSearchInput.value = "";
  });

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
      const reader = new FileReader();
      reader.onload = function (event) {
        setSearchImage(event.target.result, file);
      };
      reader.readAsDataURL(file);
      let slide = await insertUploadedImageFile(file);
      await searchWithImage(file, slide);
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
      const reader = new FileReader();
      reader.onload = function (event) {
        setSearchImage(event.target.result, file);
      };
      reader.readAsDataURL(file);
      let slide = await insertUploadedImageFile(file);
      await searchWithImage(file, slide);
    } catch (err) {
      console.error("Image search failed:", err);
      alert("Failed to search with image: " + err.message);
    } finally {
      searchPanel.classList.remove("dragover");
      hideSpinner();
    }
  });

  // Called whenever the search results are updated
  window.addEventListener("searchResultsChanged", async function (e) {
    const searchType = e.detail.searchType || "image";
    state.searchResults = e.detail.results || [];
    state.searchOrigin = 0;
    let keep_current_slide = state.searchResults.length == 0;
    await resetAllSlides(keep_current_slide);
    updateSearchCheckmarks(searchType);
    updateScoreDisplay(searchType);
  });

  renderSearchImageThumbArea();
});

function updateScoreDisplay(searchType) {
  if (searchType === "cluster" && state.searchResults.length > 0) {
    clusterDisplay.show(
      state.searchResults[0].cluster,
      state.searchResults[0].color || "#000000"
    );
  } else if (
    ["image", "text"].includes(searchType) &&
    state.searchResults.length > 0
  ) {
    const score = state.searchResults[0].score || 0;
    scoreDisplay.show(score);
  }
}

export async function searchWithImage(file, first_slide) {
  try {
    showSpinner();
    let results = await searchImage(file);
    results = results.filter((item) => item.score >= 0.6);
    window.dispatchEvent(
      new CustomEvent("searchResultsChanged", {
        detail: {
          results: results,
          searchType: "image",
          search_slide: first_slide, // not currently used, but could be useful for displaying the search image
        },
      })
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

function updateSearchCheckmarks(searchType = null) {
  const searchTypeToIconMap = {
    cluster: document.getElementById("showUmapBtn"),
    image: document.getElementById("imageSearchIcon"),
    text: document.getElementById("textSearchIcon"),
  };
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  if (searchType && state.searchResults?.length > 0) {
    clearSearchBtn.style.display = "block";
    for (const [type, iconElement] of Object.entries(searchTypeToIconMap)) {
      setCheckmarkOnIcon(iconElement, type === searchType);
    }
  } else {
    clearSearchBtn.style.display = "none";
    for (const iconElement of Object.values(searchTypeToIconMap)) {
      setCheckmarkOnIcon(iconElement, false);
    }
  }
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
            setSearchImage(event.target.result, file);
            const slide = document.createElement("div");
            slide.className = "swiper-slide";
            slide.innerHTML = `
                            <div style="position:relative; width:100%; height:100%;">
                                <span class="query-image-label">Query Image</span>
                                <img src="${event.target.result}" alt="" draggable="true" class="slide-image">
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
  scoreDisplay.hide();
  clusterDisplay.hide();
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = "";
  window.dispatchEvent(
    new CustomEvent("searchResultsChanged", {
      detail: { results: [], searchType: null },
    })
  );
}

function renderSearchImageThumbArea() {
  const area = document.getElementById("searchImageThumbArea");
  area.innerHTML = "";
  if (currentSearchImageUrl) {
    const img = document.createElement("img");
    img.src = currentSearchImageUrl;
    img.className = "search-thumb-img";
    img.alt = "Search image";
    area.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "search-thumb-placeholder";
    placeholder.title = "Upload or drag an image";
    placeholder.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    `;
    placeholder.addEventListener("click", () => {
      document.getElementById("uploadImageInput").click();
    });
    area.appendChild(placeholder);
  }
}

// Call this after a search image is set or cleared:
function setSearchImage(url, file = null) {
  currentSearchImageUrl = url;
  state.currentSearchImageFile = file;
  renderSearchImageThumbArea();
}

// Example: after uploading or drag-and-drop
// setSearchImage(url); // url is a data URL or blob URL

// Example: to clear
// setSearchImage(null);

// Initial render
document.addEventListener("DOMContentLoaded", renderSearchImageThumbArea);
