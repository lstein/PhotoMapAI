// search.js
// This file handles the search functionality for the Clipslide application.
// Swiper initialization
import { calculate_search_score_cutoff, searchImage, searchTextAndImage, setSearchResults } from "./search.js";
import { slideState } from "./slide-state.js";
import { state } from "./state.js";
import { pauseSlideshow, resumeSlideshow } from "./swiper.js";
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
        // Hide the noResultsMsg when opening
        const noResultsMsg = document.getElementById("noResultsMsg");
        if (noResultsMsg) noResultsMsg.style.display = "none";
      }, 20);
    } else {
      textSearchPanel.style.display = "none";
      textSearchPanel.style.opacity = 0;
      // Hide the noResultsMsg when closing
      const noResultsMsg = document.getElementById("noResultsMsg");
      if (noResultsMsg) noResultsMsg.style.display = "none";
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

  doSearchBtn.addEventListener("click", function () {
    searchWithTextAndImage("text");
  });

  async function searchWithTextAndImage(searchType = "text_and_image") {
    const positiveQuery = searchInput.value.trim();
    const negativeQuery = negativeSearchInput.value.trim();
    const imageFile = state.currentSearchImageFile || null; // You need to set this when an image is uploaded or selected

    // Get weights from sliders
    const posWeight = posPromptWeightSlider.getValue
      ? posPromptWeightSlider.getValue()
      : posPromptWeight;
    const negWeight = negPromptWeightSlider.getValue
      ? negPromptWeightSlider.getValue()
      : negPromptWeight;
    const imgWeight = imgPromptWeightSlider.getValue
      ? imgPromptWeightSlider.getValue()
      : imgPromptWeight;

    if (!positiveQuery && !negativeQuery && !imageFile) return;

    const slideShowRunning = state.swiper?.autoplay?.running;
    pauseSlideshow();

    try {
      showSpinner();

      let new_results = await searchTextAndImage({
        image_file: imageFile,
        positive_query: positiveQuery,
        negative_query: negativeQuery,
        image_weight: imgWeight,
        positive_weight: posWeight,
        negative_weight: negWeight,
        album: state.album,
        top_k: 100,
      });

      // calculate score cutoffs based on weights
      const cutoff = calculate_search_score_cutoff(imageFile, imgWeight, positiveQuery, posWeight, negativeQuery, negWeight);
      new_results = new_results.filter((item) => item.score >= cutoff);

      setSearchResults(new_results, searchType);
      if (new_results.length > 0) {
        setTimeout(() => {
          textSearchPanel.style.opacity = 0;
          textSearchPanel.style.display = "none";
        }, 200);
      }
      // If no results, keep the panel open so the message is visible
    } catch (err) {
      // scoreDisplay.hide();
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
    searchInput.value = "";
    negativeSearchInput.value = "";
    let slide;
    const currentSlide = slideState.getCurrentSlide();
    if (currentSlide) {
      const globalIndex = currentSlide.globalIndex.toString();
      slide = state.swiper.slides.find((s) => s.dataset.globalIndex === globalIndex);
    } else {
      slide = state.swiper.slides[state.swiper.activeIndex];  
    }
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
      await searchWithTextAndImage("image");
      hideSpinner();
      if (slideShowRunning) resumeSlideshow();
    } catch (err) {
      hideSpinner();
      console.error("Image similarity search failed:", err);
    }
  });

  // This removes the results not found message when the panel is closed.
  // PROBABLY NOT NECESSARY
  textSearchPanel.addEventListener("transitionend", function (e) {
    if (textSearchPanel.style.opacity === "0") {
      textSearchPanel.style.display = "none";
      const noResultsMsg = document.getElementById("noResultsMsg");
      if (noResultsMsg) noResultsMsg.style.display = "none";
    }
  });

  const uploadImageLink = document.getElementById("uploadImageLink");
  const uploadImageInput = document.getElementById("uploadImageInput");

  uploadImageLink.addEventListener("click", function (e) {
    e.preventDefault();
    uploadImageInput.click();
  });

  // Upload via input (do NOT auto-search, just set image)
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
    }
  );

  const negPromptWeightSlider = new WeightSlider(
    document.getElementById("negPromptWeightSlider"),
    0.25,
    (val) => {
      negPromptWeight = val;
    }
  );

  const imgPromptWeightSlider = new WeightSlider(
    document.getElementById("imgPromptWeightSlider"),
    0.5,
    (val) => {
      imgPromptWeight = val;
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

  const searchImageThumbArea = document.getElementById("searchImageThumbArea");

  searchImageThumbArea.addEventListener("dragover", function (e) {
    e.preventDefault();
    searchImageThumbArea.classList.add("dragover");
  });

  searchImageThumbArea.addEventListener("dragleave", function (e) {
    e.preventDefault();
    searchImageThumbArea.classList.remove("dragover");
  });

  // Drag-and-drop onto the search panel (do NOT auto-search, just set image)
  searchImageThumbArea.addEventListener("drop", async function (e) {
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
    } catch (err) {
      console.error("Image search failed:", err);
      alert("Failed to search with image: " + err.message);
    } finally {
      searchImageThumbArea.classList.remove("dragover");
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
    // Only show the no results message if this is a real search, not a clear/reset
    let noResultsMsg = document.getElementById("noResultsMsg");
    if (!noResultsMsg) {
      noResultsMsg = document.createElement("div");
      noResultsMsg.id = "noResultsMsg";
      noResultsMsg.style.cssText =
        "color:#faea0e; font-weight:bold; text-align:center; margin-top:0.5em; margin-bottom:1em; font-size:1.2em;";
      const panel = document.getElementById("textSearchPanel");
      panel.insertBefore(noResultsMsg, panel.firstChild);
    }

    if (e.detail.results?.length === 0 && e.detail.searchType !== "clear") {
      noResultsMsg.textContent = "No images match your search.";
      noResultsMsg.style.display = "block";
      return;
    } else {
      noResultsMsg.style.display = "none";
    }

    updateSearchCheckmarks(e.detail.searchType);
  });

  renderSearchImageThumbArea();
});

export async function searchWithImage(file, first_slide) {
  try {
    showSpinner();
    let results = await searchImage(file);
    results = results.filter((item) => item.score >= 0.6);
    setSearchResults(results, "image");
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
    text_and_image: document.getElementById("textSearchIcon"),
  };
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  const element_to_highlight = searchTypeToIconMap[searchType] || null;

  for (const iconElement of Object.values(searchTypeToIconMap)) {
    setCheckmarkOnIcon(iconElement, false);
  }
  if (element_to_highlight) {
    setCheckmarkOnIcon(element_to_highlight, true);
    clearSearchBtn.style.display = "block";
  } else {
    clearSearchBtn.style.display = "none";
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

export function exitSearchMode(searchType = "clear") {
  // scoreDisplay.hide();
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = "";
  const negativeSearchInput = document.getElementById("negativeSearchInput");
  if (negativeSearchInput) negativeSearchInput.value = "";
  setSearchImage(null, null); // Clear the search image and thumbnail
  updateSearchCheckmarks(searchType);
  setSearchResults([], searchType);
}

function renderSearchImageThumbArea() {
  const area = document.getElementById("searchImageThumbArea");
  area.innerHTML = "";
  if (currentSearchImageUrl) {
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";

    const img = document.createElement("img");
    img.src = currentSearchImageUrl;
    img.className = "search-thumb-img";
    img.alt = "Search image";
    wrapper.appendChild(img);

    // Add the X button
    const clearBtn = document.createElement("button");
    clearBtn.innerHTML = "&times;";
    clearBtn.title = "Clear search image";
    clearBtn.className = "search-thumb-clear-btn";
    clearBtn.style.position = "absolute";
    clearBtn.style.top = "2px";
    clearBtn.style.right = "2px";
    clearBtn.style.background = "rgba(0,0,0,0.7)";
    clearBtn.style.color = "#fff";
    clearBtn.style.border = "none";
    clearBtn.style.borderRadius = "50%";
    clearBtn.style.width = "22px";
    clearBtn.style.height = "22px";
    clearBtn.style.cursor = "pointer";
    clearBtn.style.fontSize = "1.2em";
    clearBtn.style.display = "flex";
    clearBtn.style.alignItems = "center";
    clearBtn.style.justifyContent = "center";
    clearBtn.style.padding = "0";
    clearBtn.addEventListener("click", () => {
      setSearchImage(null, null);
    });
    wrapper.appendChild(clearBtn);

    area.appendChild(wrapper);
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

// Initial render
document.addEventListener("DOMContentLoaded", renderSearchImageThumbArea);
