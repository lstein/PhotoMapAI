// thumbnail-gallery.js
// This file manages the thumbnail gallery preview above the seek slider

import { state } from "./state.js";
import { getCurrentSlideIndex } from "./swiper.js";
import { debounce } from "./utils.js";

class ThumbnailGallery {
  constructor() {
    this.container = null;
    this.wrapper = null;
    this.thumbnails = [];
    this.currentIndex = -1;
    this.maxThumbnails = 11; // Show 5 before + current + 5 after
    this.thumbnailSize = 256; // Sized to share with the umap hovers; will be downscaled
    this.preloadTimer = null;
    this.preloadSlideDetail = null;
    this.preloadDelay = 10000; // 10 seconds
    this.debouncedUpdateGallery = debounce(this.updateGallery.bind(this), 150);
  }

  initialize() {
    this.container = document.querySelector(".thumbnail-swiper-container");
    this.wrapper = document.querySelector(".thumbnail-swiper-wrapper");
    this.galleryRow = document.getElementById("thumbnailGalleryRow");
    this.sliderContainer = document.getElementById("sliderWithTicksContainer");
    this.prevButton = document.querySelector(".thumbnail-pager-prev");
    this.nextButton = document.querySelector(".thumbnail-pager-next");

    if (
      // overly paranoid check
      !this.container ||
      !this.wrapper ||
      !this.galleryRow ||
      !this.sliderContainer ||
      !this.prevButton ||
      !this.nextButton
    ) {
      console.warn("Thumbnail gallery elements not found");
      return false;
    }

    // Click handlers for pager buttons
    this.prevButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.previousPage();
    });

    this.nextButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.nextPage();
    });

    // Listen for slide changes
    let slideChangedTimer = null;
    window.addEventListener("slideChanged", (event) => {
      // Clear any preload processes that are still running
      if (this.preloadTimer) {
        clearTimeout(this.preloadTimer);
        this.preloadTimer = null;
      }

      // Update the gallery after a short delay to allow swiper to settle
      if (slideChangedTimer) clearTimeout(slideChangedTimer);
      slideChangedTimer = setTimeout(() => {
        this.debouncedUpdateGallery(event.detail);
      }, 100); // Delay to allow swiper to settle
    });

    // Listen for search results changes
    window.addEventListener("searchResultsChanged", async () => {
      if (this.sliderContainer.classList.contains("visible")) {
        const slideDetail = await this.getCurrentSlideDetail();
        this.debouncedUpdateGallery(slideDetail);
      }
    });

    // Listen for album changes
    window.addEventListener("albumChanged", () => {
      this.clear();
    });

    window.addEventListener("resize", () => {
      this.maxThumbnails = calculateMaxThumbnails();
      // Optionally, re-render the gallery if visible
      if (this.sliderContainer.classList.contains("visible")) {
        this.getCurrentSlideDetail().then((detail) => {
          this.updateGallery(detail);
        });
      }
    });

    return true;
  }

  clear() {
    if (this.wrapper) {
      this.wrapper.innerHTML = "";
    }
    this.thumbnails = [];
    this.currentIndex = -1;
  }

  async updateGallery(slideDetail) {
    // Only proceed if gallery is (or will be) visible
    if (!this.wrapper) return;

    if (!this.sliderContainer.classList.contains("visible")) {
      // Guard: If a preload is already running, don't start another
      if (this.preloadTimer !== null) return;

      // Gallery is not visible, set a timer to preload thumbnails
      this.preloadSlideDetail = slideDetail;
      this.preloadTimer = setTimeout(() => {
        // Preload thumbnails in the background
        this.generateThumbnails(this.preloadSlideDetail);
        this.preloadTimer = null;
      }, this.preloadDelay);
      return;
    }

    // If gallery is visible, clear any pending preload
    if (this.preloadTimer) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }

    // Generate thumbnails immediately
    this.generateThumbnails(slideDetail);
  }

  async generateThumbnails(slideDetail) {
    const { globalIndex, total, searchIndex } = slideDetail;

    // Determine the range of thumbnails to show
    const centerIndex =
      state.searchResults?.length > 0 ? searchIndex : globalIndex;
    const totalCount =
      state.searchResults?.length > 0 ? state.searchResults.length : total;

    const halfRange = Math.floor(this.maxThumbnails / 2);
    let startIndex = Math.max(0, centerIndex - halfRange);
    let endIndex = Math.min(totalCount - 1, centerIndex + halfRange);

    // Adjust range if we're near the beginning or end
    if (endIndex - startIndex + 1 < this.maxThumbnails) {
      if (startIndex === 0) {
        endIndex = Math.min(
          totalCount - 1,
          startIndex + this.maxThumbnails - 1
        );
      } else if (endIndex === totalCount - 1) {
        startIndex = Math.max(0, endIndex - this.maxThumbnails + 1);
      }
    }

    this.clear();
    this.currentIndex = centerIndex;
    this.totalCount =
      state.searchResults?.length > 0 ? state.searchResults.length : total;
    const currentPage = Math.floor(centerIndex / this.maxThumbnails);
    this.currentStartIndex = currentPage * this.maxThumbnails;

    // Create thumbnail slides
    for (let i = startIndex; i <= endIndex; i++) {
      await this.createThumbnailSlide(i, i === centerIndex);
    }

    this.updatePagerButtons();
    this.centerOnActive();
  }

  async createThumbnailSlide(index, isActive) {
    const slide = document.createElement("div");
    slide.className = `thumbnail-slide ${isActive ? "active" : ""}`;
    slide.dataset.index = index;

    // Add loading state
    slide.classList.add("loading");
    this.wrapper.appendChild(slide);

    try {
      // Get the image index (global or from search results)
      let imageIndex;
      if (state.searchResults?.length > 0) {
        imageIndex = state.searchResults[index]?.index;
      } else {
        imageIndex = index;
      }

      if (imageIndex === undefined) return;

      // Create thumbnail URL
      const thumbnailUrl = `thumbnails/${state.album}/${imageIndex}?size=${this.thumbnailSize}`;

      // Create image element
      const img = document.createElement("img");
      img.src = thumbnailUrl;
      img.alt = `Thumbnail ${index + 1}`;

      // Handle image load
      img.onload = () => {
        slide.classList.remove("loading");
        slide.innerHTML = "";
        slide.appendChild(img);
      };

      img.onerror = () => {
        slide.classList.remove("loading");
        slide.innerHTML =
          '<div style="color: #666; font-size: 12px;">Error</div>';
      };

      // Add click handler
      slide.addEventListener("click", () => {
        this.onThumbnailClick(index);
      });
    } catch (error) {
      console.error("Error creating thumbnail slide:", error);
      slide.classList.remove("loading");
      slide.innerHTML =
        '<div style="color: #666; font-size: 12px;">Error</div>';
    }
  }

  centerOnActive() {
    const activeSlide = this.wrapper.querySelector(".thumbnail-slide.active");
    if (!activeSlide || !this.container) return;

    const containerWidth = this.container.offsetWidth;
    const slideWidth = activeSlide.offsetWidth + 8; // Include gap
    const slideOffset = activeSlide.offsetLeft;

    // Calculate the offset needed to center the active slide
    const centerOffset = containerWidth / 2 - slideWidth / 2;
    const translateX = centerOffset - slideOffset;

    this.wrapper.style.transform = `translateX(${translateX}px)`;
  }

  updatePagerButtons() {
    if (!this.container) return;

    const hasMultiplePages = this.totalCount > this.maxThumbnails;
    if (hasMultiplePages) {
      this.container.classList.add("has-multiple-pages");
      const isFirstPage = this.currentStartIndex === 0;
      const isLastPage =
        this.currentStartIndex + this.maxThumbnails >= this.totalCount;
      this.prevButton.style.opacity = isFirstPage ? "0.3" : "0.7";
      this.prevButton.style.pointerEvents = isFirstPage ? "none" : "auto";
      this.nextButton.style.opacity = isLastPage ? "0.3" : "0.7";
      this.nextButton.style.pointerEvents = isLastPage ? "none" : "auto";
    } else {
      this.container.classList.remove("has-multiple-pages");
    }
  }

  async getCurrentSlideDetail() {
    console.trace("Getting current slide detail for thumbnail gallery");
    const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
    return { globalIndex, total, searchIndex };
  }

  async onThumbnailClick(index) {
    this.navigateToIndex(index);
  }

  navigateToIndex(targetIndex) {
    const slider = document.getElementById("slideSeekSlider");
    if (!slider) return;

    // Set slider value (1-based)
    slider.value = targetIndex + 1;

    // Dispatch the same event that the slider uses
    const isSearchMode = state.searchResults?.length > 0;
    window.dispatchEvent(
      new CustomEvent("setSlideIndex", {
        detail: { targetIndex, isSearchMode },
      })
    );
  }

  previousPage() {
    if (this.currentStartIndex === 0) return; // Already at first page

    const newStartIndex = Math.max(
      0,
      this.currentStartIndex - this.maxThumbnails
    );
    let centerIndex;
    if (newStartIndex === 0) {
      centerIndex = 0;
    } else {
      centerIndex = Math.min(
        newStartIndex + Math.floor(this.maxThumbnails / 2),
        this.totalCount - 1
      );
    }
    this.animateGallery("slide-prev");
    this.navigateToIndex(centerIndex);
  }

  nextPage() {
    if (this.currentStartIndex + this.maxThumbnails >= this.totalCount) return; // Already at last page

    const newStartIndex = this.currentStartIndex + this.maxThumbnails;
    // Center index for new page
    const centerIndex = Math.min(
      newStartIndex + Math.floor(this.maxThumbnails / 2),
      this.totalCount - 1
    );
    this.animateGallery("slide-next");
    this.navigateToIndex(centerIndex);
  }

  animateGallery(direction) {
    if (!this.wrapper) return;
    this.wrapper.classList.remove("slide-next", "slide-prev");
    void this.wrapper.offsetWidth; // Force reflow for restart
    this.wrapper.classList.add(direction);
    setTimeout(() => {
      this.wrapper.classList.remove(direction);
    }, 300); // Match animation duration
  }
}

// Create and initialize the gallery
export const thumbnailGallery = new ThumbnailGallery();

// Make it globally accessible for integration
window.thumbnailGallery = thumbnailGallery;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  thumbnailGallery.initialize();
});

function calculateMaxThumbnails() {
  const thumbnailWidth = 72; // thumbnail size + gap
  const container = document.querySelector(".thumbnail-swiper-container");
  let containerWidth = container ? container.offsetWidth : 0;

  // If containerWidth is 0, get the parent slider container's computed width
  // This is tricky because the thumbnail container may be hidden initially, so
  // if it is 0, we fall back to window width * the default CSS width percentage
  if (!containerWidth) {
    const sliderContainer = document.querySelector(
      ".slider-with-ticks-container"
    );
    if (sliderContainer) {
      // Get computed style width (may be in px or vw)
      let styleWidth = window.getComputedStyle(sliderContainer).width;
      // If width is in px, parse it
      if (styleWidth.endsWith("px")) {
        containerWidth = parseFloat(styleWidth);
      } else if (styleWidth.endsWith("vw")) {
        // Convert vw to px
        const vw = parseFloat(styleWidth);
        containerWidth = window.innerWidth * (vw / 100);
      } else {
        // Fallback to window width
        containerWidth = window.innerWidth * 0.8;
      }
    } else {
      containerWidth = window.innerWidth * 0.8;
    }
  }

  const maxThumbnails = Math.max(
    1,
    Math.floor(containerWidth / thumbnailWidth)
  );
  return maxThumbnails;
}
