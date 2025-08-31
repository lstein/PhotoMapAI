// swiper.js
// This file initializes the Swiper instance and manages slide transitions.
import { albumManager } from "./album.js";
import { getIndexMetadata } from "./index.js";
import { updateMetadataOverlay } from "./metadata-drawer.js";
import { fetchNextImage } from "./search.js";
import { state } from "./state.js";
import { updateCurrentImageMarker } from "./umap.js";

// Check if the device is mobile
function isTouchDevice() {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    navigator.msMaxTouchPoints > 0
  );
}

const hasTouchCapability = isTouchDevice();

document.addEventListener("DOMContentLoaded", async function () {
  const swiperConfig = {
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    autoplay: {
      delay: state.currentDelay * 1000,
      disableOnInteraction: false,
      enabled: false,
    },
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
      dynamicBullets: true,
    },
    loop: false,
    touchEventsTarget: 'container',  // said to increase touch responsiveness over default 'wrapper'
    allowTouchMove: true,
    simulateTouch: true,
    touchStartPreventDefault: false,
    touchMoveStopPropagation: false,
    keyboard: {
      enabled: true,
      onlyInViewport: true,
    },
    mousewheel: {
      enabled: true,
      releaseonEdges: true,
    },
    on: {
      slideNextTransitionStart: async function () {
        // Only add a new slide if we're at the end and moving forward
        if (this.activeIndex >= this.slides.length - 1) {
          await addNewSlide();
        }
      },
      slidePrevTransitionEnd: async function () { // adding new at end of transition makes animation smoother
        // Only add a new slide if we're at the beginning and moving backward
        if (this.activeIndex <= 1) {
          await addNewSlide(true);
        }
      },
      sliderFirstMove: function () {
        pauseSlideshow();
      },
    },
  };

  // Enable zoom on any device with touch capability
  if (hasTouchCapability) {
    swiperConfig.zoom = {
      maxRatio: 3,
      minRatio: 1,
      toggle: true,
      containerClass: "swiper-zoom-container",
      zoomedSlideClass: "swiper-slide-zoomed",
    };
  }

  // Initialize Swiper with conditional config
  state.swiper = new Swiper(".swiper", swiperConfig);

  // Prevent overlay toggle when clicking Swiper navigation buttons
  document
    .querySelectorAll(".swiper-button-next, .swiper-button-prev")
    .forEach((btn) => {
      btn.addEventListener("click", function (event) {
        pauseSlideshow(); // Pause slideshow on navigation
        event.stopPropagation();
        this.blur(); // Remove focus from button to prevent keyboard navigation issues
      });
      btn.addEventListener("mousedown", function (event) {
        this.blur();
      });
    });

  // Update icon on slide change or autoplay events
  if (state.swiper) {
    state.swiper.on("autoplayStart", updateSlideshowIcon);
    state.swiper.on("autoplayResume", updateSlideshowIcon);
    state.swiper.on("autoplayStop", updateSlideshowIcon);
    state.swiper.on("autoplayPause", updateSlideshowIcon);
    state.swiper.on("slideChange", handleSlideChange);
    state.swiper.on("scrollbarDragStart", pauseSlideshow);
  }

  // Call twice to initialize the carousel and start slideshow if requested
  await addNewSlide(false);
  await addNewSlide(false);

  // Initial icon state and overlay
  updateSlideshowIcon();
  updateMetadataOverlay();
});

export function pauseSlideshow() {
  if (state.swiper && state.swiper.autoplay.running) {
    state.swiper.autoplay.stop();
  }
}

export function resumeSlideshow() {
  if (state.swiper) {
    state.swiper.autoplay.stop();
    setTimeout(() => {
      state.swiper.autoplay.start();
    }, 50); // 50ms delay workaround for tap bug
  }
}

// Toggle between the play and pause icons based on the slideshow state
export function updateSlideshowIcon() {
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");

  if (state.swiper?.autoplay?.running) {
    playIcon.style.display = "none";
    pauseIcon.style.display = "inline";
  } else {
    playIcon.style.display = "inline";
    pauseIcon.style.display = "none";
  }
}

// Add a new slide to Swiper with image and metadata
export async function addNewSlide(backward = false) {
  if (!state.album) return; // No album set, cannot add slide

  let [globalIndex, totalImages, searchIndex] = await getCurrentSlideIndex();
  // Search mode -- we identify the next image based on the search results array,
  // then translate this into a global index for retrieval.
  if (state.searchResults?.length > 0) {
    const searchImageCnt = state.searchResults.length || 1;
    searchIndex = backward ? searchIndex - 1 : searchIndex + 1;
    searchIndex = (searchIndex + searchImageCnt) % searchImageCnt; // wrap around
    globalIndex = state.searchResults[searchIndex].index || 0;
  } else {
    // Album mode -- navigate relative to the current slide's index
    if (state.mode === "random") {
      globalIndex = Math.floor(Math.random() * totalImages);
    } else {
      globalIndex = backward ? globalIndex - 1 : globalIndex + 1;
      globalIndex = (globalIndex + totalImages) % totalImages; // wrap around
    }
  }
  await addSlideByIndex(globalIndex, searchIndex, backward);
}

export async function addSlideByIndex(
  globalIndex,
  searchIndex = null,
  backward = false
) {
  if (!state.swiper) return; // No swiper instance available

  // This is ugly.
  let currentScore, currentCluster, currentColor;
  if (searchIndex !== null && state.searchResults?.length > 0) {
    // remember values for score, cluster and color
    currentScore = state.searchResults[searchIndex]?.score || "";
    currentCluster = state.searchResults[searchIndex]?.cluster || "";
    currentColor = state.searchResults[searchIndex]?.color || "#000000"; // Default
  }

  try {
    const data = await fetchNextImage(globalIndex);

    if (!data || Object.keys(data).length === 0) {
      return;
    }

    const path = data.filepath;
    const url = data.image_url;
    const metadata_url = data.metadata_url;
    const slide = document.createElement("div");
    slide.className = "swiper-slide";

    // Use feature detection
    if (hasTouchCapability) {
      // Touch-capable device - with zoom container
      slide.innerHTML = `
        <div class="swiper-zoom-container">
          <img src="${url}" alt="${data.filename}" />
        </div>
     `;
    } else {
      // Non-touch device - direct image
      slide.innerHTML = `
        <img src="${url}" alt="${data.filename}" />
      `;
    }

    slide.dataset.filename = data.filename || "";
    slide.dataset.description = data.description || "";
    slide.dataset.filepath = path || "";
    slide.dataset.score = currentScore || "";
    slide.dataset.cluster = currentCluster || "";
    slide.dataset.color = currentColor || "#000000"; // Default color if not provided
    slide.dataset.index = data.index || 0;
    slide.dataset.total = data.total || 0;
    slide.dataset.searchIndex = searchIndex || 0; // Store the search index for this slide
    slide.dataset.metadata_url = metadata_url || "";
    slide.dataset.reference_images = JSON.stringify(data.reference_images || []);

    if (backward) {
      state.swiper.prependSlide(slide);
    } else {
      state.swiper.appendSlide(slide);
    }
    // Delay high water mark enforcement to allow transition to finish
    setTimeout(() => enforceHighWaterMark(backward), 500);
  } catch (error) {
    console.error("Failed to add new slide:", error);
    alert(`Failed to add new slide: ${error.message}`);
    return;
  }
}

// Returns an array of [globalIndex, totalImages, searchIndex]
// searchIndex is the index within the search results.
// Indices are returned as -1 if not available.
export async function getCurrentSlideIndex() {
  let currentSlide = null;

  if (state.swiper && state.swiper.slides.length > 0) {
    currentSlide = state.swiper.slides[state.swiper.activeIndex];
  }

  // Handle search results
  if (state.searchResults.length > 0) {
    if (!currentSlide) {
      return [-1, state.searchResults.length, -1]; // Default to first slide if no current slide
    } else {
      return [
        parseInt(currentSlide?.dataset?.index, 10),
        state.searchResults.length,
        parseInt(currentSlide.dataset.searchIndex, 10),
      ];
    }
  }

  // Handle case where swiper or slides are not yet initialized
  if (!currentSlide) {
    const metadata = await getIndexMetadata(state.album);
    return [-1, parseInt(metadata.filename_count, 10), -1]; // Default to first slide if no swiper or slides
  }
  // get the index and total from the current slide
  const activeIndex = currentSlide?.dataset?.index || 0;
  const totalSlides = currentSlide?.dataset?.total || 1;
  return [parseInt(activeIndex, 10), parseInt(totalSlides, 10), 0];
}

export async function getCurrentFilepath() {
  const [globalIndex, ,] = await getCurrentSlideIndex();
  if (globalIndex === -1) return null;
  // Call the /image_path/ endpoint to get the filepath
  const response = await fetch(
    `image_path/${encodeURIComponent(state.album)}/${encodeURIComponent(
      globalIndex
    )}`
  );
  if (!response.ok) return null;
  return await response.text();
}

// Add function to handle slide changes
export async function handleSlideChange() {
  updateMetadataOverlay();
  let index = 0;

  const activeSlide = state.swiper.slides[state.swiper.activeIndex];
  if (state.searchResults.length > 0) {
    // Find the index of the current slide in searchResults
    const filename = activeSlide?.dataset?.filepath;
    if (filename) {
      const relpath = albumManager.relativePath(
        filename,
        await albumManager.getCurrentAlbum()
      );
    }
  }
  window.dispatchEvent(
    new CustomEvent("slideChanged", {
      detail: {
        globalIndex: parseInt(activeSlide?.dataset?.index, 10) || 0, // Global index in album
        total: parseInt(activeSlide?.dataset?.total, 10) || 0, // Total slides in album
        searchIndex: parseInt(activeSlide?.dataset?.searchIndex, 10) || 0, // Index in search results
      },
    })
  );
  // setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
}

export function removeSlidesAfterCurrent() {
  if (!state.swiper) return;
  const activeIndex = state.swiper.activeIndex;
  const slidesToRemove = state.swiper.slides.length - activeIndex - 1;
  if (slidesToRemove > 0) {
    state.swiper.removeSlide(activeIndex + 1, slidesToRemove);
  }
  setTimeout(() => enforceHighWaterMark(), 500);
}

// Reset all the slides and reload the swiper, optionally keeping the current slide.
export async function resetAllSlides(keep_current_slide = false) {
  if (!state.swiper) return; // happens on first load.
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (keep_current_slide && !state.dataChanged) {
    // Keep the current slide and remove others
    const currentSlide = state.swiper.slides[state.swiper.activeIndex];
    state.swiper.removeAllSlides();
    state.swiper.appendSlide(currentSlide);
  } else {
    // Remove all slides
    state.swiper.removeAllSlides();
    await addNewSlide(false);
  }
  await addNewSlide(false); // Add another slide to ensure navigation works
  updateMetadataOverlay();
  if (slideShowRunning) {
    resumeSlideshow();
  }
  setTimeout(() => updateCurrentImageMarker(window.umapPoints), 500);
}

export async function resetSlidesAndAppend(first_slide) {
  const slideShowRunning = state.swiper?.autoplay?.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (state.swiper?.slides?.length > 0) {
    state.swiper.removeAllSlides();
  }
  if (first_slide) {
    state.swiper.appendSlide(first_slide);
  } else {
    await addNewSlide();
  }
  await addNewSlide(); // needed to enable navigation buttons
  state.swiper.slideTo(0); // Reset to the first slide
  handleSlideChange(); // Update the overlay and displays
  // restart the slideshow if it was running
  if (slideShowRunning) resumeSlideshow();
}

// Enforce the high water mark by removing excess slides
export function enforceHighWaterMark(backward = false) {
  const maxSlides = state.highWaterMark || 50;
  const swiper = state.swiper;
  const slides = swiper.slides.length;

  if (slides > maxSlides) {
    let slideShowRunning = swiper.autoplay.running;
    pauseSlideshow(); // Pause the slideshow to prevent issues during removal
    if (backward) {
      // Remove from end
      swiper.removeSlide(swiper.slides.length - 1);
    } else {
      // Remove from beginning
      swiper.removeSlide(0);
      state.searchOrigin += 1; // Adjust the searchOrigin so that it reflects the searchIndex of the first slide
    }
    if (slideShowRunning) resumeSlideshow(); // Resume the slideshow after removal
  }
}

// Reset slide show when the album changes
window.addEventListener("albumChanged", () => {
  resetAllSlides();
});

// Reset slide show when the search results change.
// When clearing search results, we want to keep the current
// slide to avoid displaying something unexpected.
window.addEventListener("searchResultsChanged", (event) => {
  const searchType = event.detail?.searchType;
  if (searchType === "switchAlbum") return;
  const keep_current_slide = searchType === "clear";
  resetAllSlides(keep_current_slide);
});

// Add this to swiper.js
window.addEventListener("setSlideIndex", async (event) => {
  const { targetIndex, isSearchMode } = event.detail;
    
  let globalIndex;
  let [, totalSlides] = await getCurrentSlideIndex();

  if (isSearchMode && state.searchResults?.length > 0) {
    globalIndex = state.searchResults[targetIndex]?.index;
  } else {
    globalIndex = targetIndex;
  }
  
  await state.swiper.removeAllSlides();

  let origin = -2;
  let slides_to_add = 5;
  if (globalIndex + origin < 0) {
    origin = 0;
  }
  
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.style.visibility = "hidden";
  
  for (let i = origin; i < slides_to_add; i++) {
    if (targetIndex + i >= totalSlides) break;
    // let randomMode = state.mode === "random" && state.searchResults?.length === 0;
    // let seekIndex = randomMode && i != 0 
    //   ? Math.floor(Math.random() * totalSlides)
    //   : globalIndex + i;
    let seekIndex = globalIndex + i;
    await addSlideByIndex(seekIndex, targetIndex + i);
  }
  
  state.swiper.slideTo(-origin, 0);
  swiperContainer.style.visibility = "visible";
  updateMetadataOverlay();

});
