// This file actually drives the slideshow

let swiper;
let currentTextToCopy = "";
let currentDelay = 5; // Will be overridden
let mode = "random"; // Will be overridden
let embeddings_file = ""; // Will be overriden by initializeFromServer()
let highWaterMark = 20; // Default value, can be changed dynamically
let searchIndex = 0; // Global variable indicates where we are on the search list
let searchResults = []; // Global variable to store search results

// These must mirror the nginx configuration.
function initializeFromServer() {
  if (window.slideshowConfig) {
    currentDelay = window.slideshowConfig.currentDelay;
    mode = window.slideshowConfig.mode;
    embeddings_file = window.slideshowConfig.embeddings_file;
  }
}

// ShowSpinner and hideSpinner functions
function showSpinner() {
  document.getElementById("spinner").style.display = "block";
}
function hideSpinner() {
  document.getElementById("spinner").style.display = "none";
}

// Fetch a random image and return its metadata
async function fetchNextImage() {
  let response;
  let spinnerTimeout = setTimeout(() => showSpinner(), 500); // Show spinner after 0.5s
  const formData = new URLSearchParams();

  try {
    // Handle the case of there already being a set of search results, in which case we step through.
    if (searchResults && searchResults.length > 0) {
      let currentFilepath = searchResults[searchIndex++];
      if (searchIndex >= searchResults.length) searchIndex = 0; // Loop back to start
      formData.append("embeddings_file", embeddings_file);
      formData.append("current_image", currentFilepath);
      response = await fetch("retrieve_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      // Otherwise we let the server handle the logic of which image to return.
    } else {
      // Convert query parameters to form data
      formData.append("embeddings_file", embeddings_file);
      if (mode === "random") {
        formData.append("random", "true");
      } else if (mode === "sequential") {
        // Use the currently displayed slide, not the last in the buffer
        const currentFilepath = getCurrentFilepath();
        formData.append("current_image", currentFilepath);
        formData.append("random", "false");
      } else {
        throw new Error(
          "Invalid mode specified. Use 'random' or 'sequential'."
        );
      }

      response = await fetch("retrieve_next_image/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    data = await response.json();
    clearTimeout(spinnerTimeout);
    hideSpinner();
    return data;
  } catch (e) {
    clearTimeout(spinnerTimeout);
    hideSpinner();
    console.warn("Failed to load image.");
    throw e;
  }
}

// Add a new slide to Swiper with image and metadata
async function addNewSlide() {
  const data = await fetchNextImage();

  // Stop if data is empty (null, undefined, or empty object)
  if (!data || Object.keys(data).length === 0) {
    return;
  }

  // Create a new slide element
  const path = data.filepath; // Full path to the image
  const url = data.url; // URL path to the image
  const slide = document.createElement("div");
  slide.className = "swiper-slide";
  slide.innerHTML = `
        <div style="position:relative; width:100%; height:100%;">
            <img src="${url}" alt="" draggable="true" class="slide-image">
        </div>
    `;
  slide.dataset.filename = data.filename || "";
  slide.dataset.description = data.description || "";
  slide.dataset.textToCopy = data.textToCopy || "";
  slide.dataset.filepath = path || "";
  swiper.appendSlide(slide);

  const img = slide.querySelector("img");
  img.addEventListener("dragstart", function (e) {
    e.dataTransfer.setData(
      "DownloadURL",
      `image/jpeg:${data.filename || "image.jpg"}:${data.url}`
    );
    e.dataTransfer.setData("text/uri-list", data.url);
    // Prevent Swiper from handling this drag as a swipe
    e.stopPropagation();
  });
  // Prevent Swiper swipe on mouse drag
  img.addEventListener("mousedown", function (e) {
    e.stopPropagation();
  });

  updateOverlay();
    // Delay the high water mark enforcement to let the slide addition complete
  setTimeout(() => {
    enforceHighWaterMark();
  }, 200); // 200ms delay after slide is added
}

// Optional: function to set high-water mark dynamically
function setHighWaterMark(newMark) {
  highWaterMark = newMark;
  saveSettingsToLocalStorage();
  enforceHighWaterMark();
  // Remove excess slides immediately if needed
  while (swiper.slides.length > highWaterMark) {
    swiper.removeSlide(0);
  }
}

// Update overlay with current slide's metadata
function updateOverlay() {
  const slide = swiper.slides[swiper.activeIndex];
  if (!slide) return;
  document.getElementById("descriptionText").innerHTML =
    slide.dataset.description || "";
  document.getElementById("filenameText").textContent =
    slide.dataset.filename || "";
  document.getElementById("filepathText").textContent =
    slide.dataset.filepath || "";
  currentTextToCopy = slide.dataset.textToCopy || "";
}

// Delay controls
const delayStep = 1; // seconds to increase/decrease per click
const minDelay = 1; // minimum delay in seconds
const maxDelay = 60; // maximum delay in seconds

function setDelay(newDelay) {
  // Clamp delay between min and max
  newDelay = Math.max(minDelay, Math.min(maxDelay, newDelay));
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
  // Initialize from server data instead of loadParams()
  initializeFromServer();

  // Restore from localStorage if present (this can override server defaults)
  const storedHighWaterMark = localStorage.getItem("highWaterMark");
  if (storedHighWaterMark !== null)
    highWaterMark = parseInt(storedHighWaterMark, 10);

  const storedCurrentDelay = localStorage.getItem("currentDelay");
  if (storedCurrentDelay !== null)
    currentDelay = parseInt(storedCurrentDelay, 10);

  const storedMode = localStorage.getItem("mode");
  if (storedMode) mode = storedMode;

  // Initialize Swiper
  swiper = new Swiper(".swiper", {
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
    autoplay: {
      delay: currentDelay * 1000,
      disableOnInteraction: false,
    },
    scrollbar: {
      el: ".swiper-scrollbar",
      draggable: true,
      hide: false,
    },
    loop: false, // Enable looping to allow continuous navigation
    on: {
      slideNextTransitionStart: async function () {
        // Only add a new slide if we're at the end and moving forward
        if (
          swiper.activeIndex >=
          swiper.slides.length - 1
          // swiper.activeIndex >= swiper.slides.length - 2 &&
          // swiper.activeIndex > swiper.previousIndex // Only when moving forward
        ) {
          await addNewSlide();
        }
      },
      sliderFirstMove: function () {
        pauseSlideshow();
      },
    },
  });

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

  // Start/stop slideshow button
  const startStopBtn = document.getElementById("startStopSlideshowBtn");
  const playIcon = document.getElementById("playIcon");
  const pauseIcon = document.getElementById("pauseIcon");

  function updateSlideshowIcon() {
    if (swiper && swiper.autoplay && swiper.autoplay.running) {
      playIcon.style.display = "none";
      pauseIcon.style.display = "inline";
    } else {
      playIcon.style.display = "inline";
      pauseIcon.style.display = "none";
    }
  }

  startStopBtn.addEventListener("click", function () {
    if (swiper.autoplay.running) {
      swiper.autoplay.stop();
    } else {
      swiper.autoplay.start();
    }
    updateSlideshowIcon();
  });

  // Update icon on slide change or autoplay events
  if (swiper) {
    swiper.on("autoplayStart", updateSlideshowIcon);
    swiper.on("autoplayResume", updateSlideshowIcon);
    swiper.on("autoplayStop", updateSlideshowIcon);
    swiper.on("autoplayPause", updateSlideshowIcon);
  }

  // Initial icon state
  updateSlideshowIcon();

  // Fullscreen button
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const elem = document.documentElement; // or use a specific container div
      if (!document.fullscreenElement) {
        elem.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Call after slides are loaded/added
  await addNewSlide();
  await addNewSlide();

  // Now the DOM is ready, so the button exists:
  document.getElementById("copyTextBtn").onclick = function () {
    if (currentTextToCopy) {
      navigator.clipboard.writeText(currentTextToCopy);
    }
  };

  // Update overlay on slide change
  swiper.on("slideChange", function () {
    updateOverlay();
  });

  swiper.on("scrollbarDragStart", function () {
    pauseSlideshow();
  });

  let slowerBtn = document.getElementById("slowerBtn");
  let fasterBtn = document.getElementById("fasterBtn");

  slowerBtn.onclick = function () {
    let newDelay = Math.min(maxDelay, currentDelay + delayStep);
    setDelay(newDelay);
  };

  fasterBtn.onclick = function () {
    let newDelay = Math.max(minDelay, currentDelay - delayStep);
    setDelay(newDelay);
  };
  updateDelayDisplay(currentDelay);

  document.getElementById("closeOverlayBtn").onclick = hidePauseOverlay;

  // Keyboard navigation
  window.addEventListener("keydown", function (e) {
    // Prevent global shortcuts when typing in an input or textarea
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable
    ) {
      return;
    }

    if (e.key === "ArrowRight") {
      pauseSlideshow(); // Pause on navigation
      swiper.slideNext();
    }
    if (e.key === "ArrowLeft") {
      pauseSlideshow(); // Pause on navigation
      swiper.slidePrev();
    }
    if (e.key === "ArrowUp") showPauseOverlay();
    if (e.key === "ArrowDown") hidePauseOverlay();
    if (e.key === "i") {
      const pauseOverlay = document.getElementById("pauseOverlay");
      if (pauseOverlay.classList.contains("visible")) {
        hidePauseOverlay();
      } else {
        showPauseOverlay();
      }
    }
    if (e.key === "Escape") hidePauseOverlay();
    if (e.key === "f") {
      const elem = document.documentElement; // or use a specific container div
      if (!document.fullscreenElement) {
        elem.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    }
    if (e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (swiper && swiper.autoplay && swiper.autoplay.running) {
        resumeSlideshow();
      } else {
        pauseSlideshow();
      }
    }
  });

  // Attach to the swiper container or document
  const swiperContainer = document.querySelector(".swiper");
  swiperContainer.addEventListener("touchstart", handleTouchStart, {
    passive: false,
  });
  swiperContainer.addEventListener("touchmove", handleTouchMove, {
    passive: false,
  });
  swiperContainer.addEventListener("touchend", handleTouchEnd, {
    passive: false,
  });

  // Disable tabbing on buttons to prevent focus issues
  document.querySelectorAll("button").forEach((btn) => (btn.tabIndex = -1));

  document.querySelectorAll('input[type="radio"]').forEach((rb) => {
    rb.tabIndex = -1; // Remove from tab order
    rb.addEventListener("mousedown", function (e) {
      e.preventDefault(); // Prevent focus on mouse down
    });
    rb.addEventListener("focus", function () {
      this.blur(); // Remove focus if somehow focused
    });
  });

  // Set initial radio button state based on current mode
  document.getElementById("modeRandom").checked = mode === "random";
  document.getElementById("modeSequential").checked = mode === "sequential";

  // Listen for changes to the radio buttons
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      if (this.checked) {
        mode = this.value;
        saveSettingsToLocalStorage();
        // Remove all slides from the current position to the end
        for (let i = swiper.slides.length - 1; i > swiper.activeIndex; i--) {
          swiper.removeSlide(i);
        }
        addNewSlide(); // Add a new slide based on the new mode
      }
    });
  });

  let touchStartY = null;
  let touchStartX = null;
  let touchEndY = null;
  let verticalSwipeDetected;
  const swipeThreshold = 50; // Minimum distance in px for a swipe

  function handleTouchStart(e) {
    if (e.touches && e.touches.length === 1) {
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      verticalSwipeDetected = false; // Reset swipe detection
    }
  }

  function handleTouchMove(e) {
    if (touchStartY === null || touchStartX === null) return;
    const currentY = e.touches[0].clientY;
    const currentX = e.touches[0].clientX;
    const deltaY = currentY - touchStartY;
    const deltaX = currentX - touchStartX;

    // Only prevent default if vertical movement is dominant
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      e.preventDefault();
      if (Math.abs(deltaY) > swipeThreshold && !verticalSwipeDetected) {
        e.preventDefault(); // Prevent default scrolling behavior
        verticalSwipeDetected = true;
        if (deltaY < -swipeThreshold) showPauseOverlay();
        else if (deltaY > swipeThreshold) hidePauseOverlay();
      }
    }
  }

  function handleTouchEnd(e) {
    if (touchStartY === null || touchStartX === null) return;
    const touch = (e.changedTouches && e.changedTouches[0]) || null;
    if (!touch) return;
    const deltaY = touch.clientY - touchStartY;
    const deltaX = touch.clientX - touchStartX;

    // Detect horizontal swipe (left/right)
    if (
      Math.abs(deltaX) > Math.abs(deltaY) &&
      Math.abs(deltaX) > swipeThreshold
    ) {
      pauseSlideshow();
    }
    // No pause on vertical swipe
    touchStartY = null;
    touchStartX = null;
    verticalSwipeDetected = false;
  }

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
    formData.append("embeddings_file", embeddings_file);

    try {
      showSpinner();
      searchResults = [];
      searchIndex = 0; // Reset search index for new search
      const response = await fetch("search_with_text/", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      result.results = result.results.filter((item) => item.score >= 0.2);
      searchResults = result.results.map((item) => item.filename);
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
      swiper && swiper.autoplay && swiper.autoplay.running;
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
    const slide = swiper.slides[swiper.activeIndex];
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
      if (!(swiper && swiper.autoplay && swiper.autoplay.running)) {
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
      if (swiper && swiper.slides && swiper.slides.length > 0) {
        const currentIndex = swiper.activeIndex;
        swiper.removeSlide(currentIndex);

        // If no slides left, add a new one
        if (swiper.slides.length === 0) {
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
      highWaterMarkInput.value = highWaterMark;
      delayValueSpan.textContent = currentDelay;
      if (mode === "random") modeRandom.checked = true;
      if (mode === "sequential") modeSequential.checked = true;
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
    currentDelay = newDelay;
    swiper.params.autoplay.delay = currentDelay * 1000; // convert to milliseconds;
    swiper.autoplay.start();

    mode = newMode;
    saveSettingsToLocalStorage();

    // Update radio buttons if needed
    document.getElementById("modeRandom").checked = mode === "random";
    document.getElementById("modeSequential").checked = mode === "sequential";

    settingsOverlay.style.display = "none";
  });
});
async function searchWithImage(file, first_slide) {
  const formData = new FormData();
  formData.append("file", file); // file is a File object from an <input type="file">
  formData.append("top_k", 100); // Default to 100 results
  formData.append("embeddings_file", embeddings_file);

  try {
    showSpinner();
    searchResults = [];
    searchIndex = 0; // Reset search index for new search

    const response = await fetch("search_with_image/", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();

    // filter the results by score, keeping everything with a score >= 0.6
    result.results = result.results.filter((item) => item.score >= 0.6);
    searchResults = result.results.map((item) => item.filename);
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

function resumeSlideshow() {
  if (swiper && !swiper.autoplay.running) {
    swiper.autoplay.start();
  }
}

function pauseSlideshow() {
  if (swiper && swiper.autoplay.running) {
    swiper.autoplay.stop();
  }
}

// Show/hide the clearSearchBtn based on searchResults
function updateSearchCheckmarks() {
  const searchIcon = document.getElementById("searchIcon");
  const clearSearchBtn = document.getElementById("clearSearchBtn");
  // Remove any existing checkmark overlay
  let checkOverlay =
    searchIcon?.parentElement?.querySelector(".checkmark-overlay");
  if (checkOverlay) checkOverlay.remove();
  if (searchResults && searchResults.length > 0) {
    clearSearchBtn.style.display = "flex";
  } else {
    clearSearchBtn.style.display = "none";
  }
}

function showPauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.style.display = "flex";
  // Force reflow to ensure the transition works when toggling quickly
  // void pauseOverlay.offsetWidth;
  pauseOverlay.classList.add("visible");
}

function hidePauseOverlay() {
  const pauseOverlay = document.getElementById("pauseOverlay");
  pauseOverlay.classList.remove("visible");
  pauseOverlay.style.display = "none";
  // pauseOverlay.classList.remove('visible');
  // // Wait for the transition to finish before hiding
  // pauseOverlay.addEventListener('transitionend', function handler() {
  //     if (!pauseOverlay.classList.contains('visible')) {
  //         pauseOverlay.style.display = 'none';
  //     }
  //     pauseOverlay.removeEventListener('transitionend', handler);
  // });
}

// NO LONGER USED: REMOVE
// function flashPauseOverlay(duration = 1000) {
//     const overlay = document.getElementById('pauseOverlay');
//     if (overlay.style.display === 'flex') return; // Do nothing if already showing
//     showPauseOverlay();
//     setTimeout(() => {
//         hidePauseOverlay();
//     }, duration);
// }

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
      )}&embeddings_file=${encodeURIComponent(embeddings_file)}`,
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
    const currentSlide = swiper.slides[swiper.activeIndex];
    if (currentSlide && currentSlide.dataset.filepath === filepath) {
      swiper.removeSlide(swiper.activeIndex);
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

  if (swiper && swiper.autoplay && swiper.autoplay.running) {
    pauseSlideshow(); // Pause the slideshow if it's running
  }
  searchInput.value = "";
  searchResults = [];
  searchIndex = 0; // Reset search index
  if (swiper && swiper.slides && swiper.slides.length > 0) {
    swiper.removeAllSlides();
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
  const slideShowRunning = swiper && swiper.autoplay && swiper.autoplay.running;
  pauseSlideshow(); // Pause the slideshow if it's running
  if (swiper && swiper.slides && swiper.slides.length > 0) {
    swiper.removeAllSlides();
  }
  if (first_slide) {
    swiper.appendSlide(first_slide);
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
            swiper.slideTo(0); // Go to the first slide
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

function enforceHighWaterMark() {
  if (!swiper) return;

  const slideShowActive = swiper.autoplay && swiper.autoplay.running;
  if (slideShowActive) swiper.autoplay.stop();

  while (swiper.slides.length > highWaterMark) {
    if (swiper.activeIndex > 0) {
      swiper.removeSlide(0);
      swiper.slideTo(swiper.activeIndex, 0, false);
    } else {
      swiper.removeSlide(swiper.slides.length - 1);
    }
  }

  if (slideShowActive) swiper.autoplay.start();
}

function saveSettingsToLocalStorage() {
  localStorage.setItem("highWaterMark", highWaterMark);
  localStorage.setItem("currentDelay", currentDelay);
  localStorage.setItem("mode", mode);
}

// Call this function whenever you update any of the three values:
function setHighWaterMark(newMark) {
  highWaterMark = newMark;
  saveSettingsToLocalStorage();
}

function setDelay(newDelay) {
  newDelay = Math.max(minDelay, Math.min(maxDelay, newDelay));
  currentDelay = newDelay;
  swiper.params.autoplay.delay = currentDelay * 1000;
  swiper.autoplay.start();
  updateDelayDisplay(newDelay);
  saveSettingsToLocalStorage();
}
