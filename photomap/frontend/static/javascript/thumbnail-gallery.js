// thumbnail-gallery.js
// This file manages the thumbnail gallery preview above the seek slider

import { state } from "./state.js";

class ThumbnailGallery {
  constructor() {
    this.container = null;
    this.wrapper = null;
    this.thumbnails = [];
    this.currentIndex = -1;
    this.isVisible = false;
    this.maxThumbnails = 11; // Show 5 before + current + 5 after
    this.thumbnailSize = 128;
  }

  initialize() {
    console.log('ThumbnailGallery: Initializing...');
    
    this.container = document.querySelector('.thumbnail-swiper-container');
    this.wrapper = document.querySelector('.thumbnail-swiper-wrapper');
    this.galleryRow = document.getElementById('thumbnailGalleryRow');
    this.sliderContainer = document.getElementById('sliderWithTicksContainer');
    
    console.log('ThumbnailGallery: Elements found:', {
      container: !!this.container,
      wrapper: !!this.wrapper,
      galleryRow: !!this.galleryRow,
      sliderContainer: !!this.sliderContainer
    });
    
    if (!this.container || !this.wrapper || !this.galleryRow || !this.sliderContainer) {
      console.warn('Thumbnail gallery elements not found');
      return false;
    }

    // Listen for slide changes
    window.addEventListener('slideChanged', (event) => {
      console.log('ThumbnailGallery: slideChanged event received:', event.detail);
      this.updateGallery(event.detail);
    });

    // Listen for search results changes
    window.addEventListener('searchResultsChanged', () => {
      console.log('ThumbnailGallery: searchResultsChanged event received');
      this.updateVisibility();
    });

    // Listen for album changes
    window.addEventListener('albumChanged', () => {
      console.log('ThumbnailGallery: albumChanged event received');
      this.hide();
    });

    console.log('ThumbnailGallery: Initialized successfully');
    return true;
  }

  show() {
    // Gallery visibility is now controlled by the slider container's visibility
    // We just need to update the gallery content
    this.updateVisibility();
  }

  hide() {
    // Clear gallery content but don't hide the container
    // (visibility is controlled by slider)
    this.clear();
  }

  updateVisibility() {
    console.log('ThumbnailGallery: updateVisibility called');
    const hasMultipleItems = this.shouldShowGallery();
    console.log('ThumbnailGallery: shouldShowGallery =', hasMultipleItems);
    
    if (hasMultipleItems) {
      this.galleryRow.style.display = 'flex';
      console.log('ThumbnailGallery: Gallery set to flex');
    } else {
      this.galleryRow.style.display = 'none';
      console.log('ThumbnailGallery: Gallery set to none');
    }
  }

  shouldShowGallery() {
    const searchResultsLength = state.searchResults?.length || 0;
    const totalImages = state.totalImages || 0;
    const total = searchResultsLength > 0 ? searchResultsLength : totalImages;
    
    console.log('ThumbnailGallery: shouldShowGallery check:', {
      searchResultsLength,
      totalImages,
      total,
      result: total > 1
    });
    
    return total > 1;
  }

  clear() {
    if (this.wrapper) {
      this.wrapper.innerHTML = '';
    }
    this.thumbnails = [];
    this.currentIndex = -1;
  }

  async updateGallery(slideDetail) {
    console.log('ThumbnailGallery: updateGallery called with:', slideDetail);
    
    if (!this.wrapper) {
      console.warn('ThumbnailGallery: No wrapper element');
      return;
    }

    const { globalIndex, total, searchIndex } = slideDetail;
    
    // Determine the range of thumbnails to show
    const centerIndex = state.searchResults?.length > 0 ? searchIndex : globalIndex;
    const totalCount = state.searchResults?.length > 0 ? state.searchResults.length : total;
    
    console.log('ThumbnailGallery: Gallery range calculation:', {
      centerIndex,
      totalCount,
      hasSearchResults: state.searchResults?.length > 0
    });
    
    if (totalCount <= 1) {
      console.log('ThumbnailGallery: Total count <= 1, updating visibility');
      this.updateVisibility();
      return;
    }

    const halfRange = Math.floor(this.maxThumbnails / 2);
    let startIndex = Math.max(0, centerIndex - halfRange);
    let endIndex = Math.min(totalCount - 1, centerIndex + halfRange);

    // Adjust range if we're near the beginning or end
    if (endIndex - startIndex + 1 < this.maxThumbnails) {
      if (startIndex === 0) {
        endIndex = Math.min(totalCount - 1, startIndex + this.maxThumbnails - 1);
      } else if (endIndex === totalCount - 1) {
        startIndex = Math.max(0, endIndex - this.maxThumbnails + 1);
      }
    }

    console.log('ThumbnailGallery: Creating thumbnails from', startIndex, 'to', endIndex);

    this.clear();
    this.currentIndex = centerIndex;

    // Create thumbnail slides
    for (let i = startIndex; i <= endIndex; i++) {
      await this.createThumbnailSlide(i, i === centerIndex);
    }

    this.updateVisibility();
    this.centerOnActive();
  }

  async createThumbnailSlide(index, isActive) {
    const slide = document.createElement('div');
    slide.className = `thumbnail-slide ${isActive ? 'active' : ''}`;
    slide.dataset.index = index;

    // Add loading state
    slide.classList.add('loading');
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
      const img = document.createElement('img');
      img.src = thumbnailUrl;
      img.alt = `Thumbnail ${index + 1}`;
      
      // Handle image load
      img.onload = () => {
        slide.classList.remove('loading');
        slide.innerHTML = '';
        slide.appendChild(img);
      };

      img.onerror = () => {
        slide.classList.remove('loading');
        slide.innerHTML = '<div style="color: #666; font-size: 12px;">Error</div>';
      };

      // Add click handler
      slide.addEventListener('click', () => {
        this.onThumbnailClick(index);
      });

    } catch (error) {
      console.error('Error creating thumbnail slide:', error);
      slide.classList.remove('loading');
      slide.innerHTML = '<div style="color: #666; font-size: 12px;">Error</div>';
    }
  }

  centerOnActive() {
    const activeSlide = this.wrapper.querySelector('.thumbnail-slide.active');
    if (!activeSlide || !this.container) return;

    const containerWidth = this.container.offsetWidth;
    const slideWidth = activeSlide.offsetWidth + 8; // Include gap
    const slideOffset = activeSlide.offsetLeft;
    
    // Calculate the offset needed to center the active slide
    const centerOffset = containerWidth / 2 - slideWidth / 2;
    const translateX = centerOffset - slideOffset;
    
    this.wrapper.style.transform = `translateX(${translateX}px)`;
  }

  async onThumbnailClick(index) {
    // This will need to integrate with your swiper navigation
    // For now, we'll dispatch a custom event that can be handled elsewhere
    window.dispatchEvent(new CustomEvent('thumbnailClicked', {
      detail: { index }
    }));
  }
}

// Create and initialize the gallery
export const thumbnailGallery = new ThumbnailGallery();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  thumbnailGallery.initialize();
});