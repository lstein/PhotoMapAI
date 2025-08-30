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
    this.thumbnailSize = 128; // Size in pixels
    this.preloadTimer = null;
    this.preloadSlideDetail = null;
    this.preloadDelay = 3000; // 3 seconds
    this.debouncedUpdateGallery = debounce(this.updateGallery.bind(this), 150);
  }

  initialize() {
    this.container = document.querySelector(".thumbnail-swiper-container");
    this.wrapper = document.querySelector(".thumbnail-swiper-wrapper");
    this.galleryRow = document.getElementById("thumbnailGalleryRow");
    this.sliderContainer = document.getElementById("sliderWithTicksContainer");

    if (
      !this.container ||
      !this.wrapper ||
      !this.galleryRow ||
      !this.sliderContainer
    ) {
      console.warn("Thumbnail gallery elements not found");
      return false;
    }

    // Listen for slide changes
    window.addEventListener("slideChanged", (event) => {
      this.debouncedUpdateGallery(event.detail);
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
      // Gallery is not visible, set a timer to preload thumbnails
      this.preloadSlideDetail = slideDetail;
      if (this.preloadTimer) clearTimeout(this.preloadTimer);
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

    // Create thumbnail slides
    for (let i = startIndex; i <= endIndex; i++) {
      await this.createThumbnailSlide(i, i === centerIndex);
    }

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

  async getCurrentSlideDetail() {
    console.trace("Getting current slide detail for thumbnail gallery");
    const [globalIndex, total, searchIndex] = await getCurrentSlideIndex();
    return { globalIndex, total, searchIndex };
  }

  async onThumbnailClick(index) {
    // This will need to integrate with your swiper navigation
    // For now, we'll dispatch a custom event that can be handled elsewhere
    window.dispatchEvent(
      new CustomEvent("thumbnailClicked", {
        detail: { index },
      })
    );
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
