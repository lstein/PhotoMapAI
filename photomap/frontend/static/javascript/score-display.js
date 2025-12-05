// score-display.js
// This file manages the score display functionality, showing and hiding the score overlay.
import { isColorLight } from "./utils.js"; // Utility function to check if a color is light 

// Star SVG icons for favorites display
const STAR_EMPTY_SVG = `<svg class="score-star" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const STAR_FILLED_SVG = `<svg class="score-star" width="16" height="16" viewBox="0 0 24 24" fill="#ffc107" stroke="#ffc107" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

export class ScoreDisplay {
  constructor() {
    this.scoreElement = document.getElementById("fixedScoreDisplay");
    this.scoreText = document.getElementById("scoreText");
    this.isVisible = false;
    this.opacity = 0.85;
    this.currentGlobalIndex = null;
    this.isBookmarked = false;
  }

  /**
   * Set the current global index and bookmark status for star display
   * @param {number} globalIndex - The current image's global index
   * @param {boolean} isBookmarked - Whether the image is bookmarked/favorited
   */
  setBookmarkStatus(globalIndex, isBookmarked) {
    this.currentGlobalIndex = globalIndex;
    this.isBookmarked = isBookmarked;
  }

  /**
   * Get the star HTML based on bookmark status
   * @returns {string} Star SVG HTML
   */
  getStarHtml() {
    return this.isBookmarked ? STAR_FILLED_SVG : STAR_EMPTY_SVG;
  }

  /**
   * Display search score with format: (star) index/total (score=X.XX)
   * @param {number} score - The search score
   * @param {number} index - Current position in search results (1-based)
   * @param {number} total - Total search results
   */
  showSearchScore(score, index = null, total = null) {
    if (score !== undefined && score !== null) {
      let text = "";
      if (index !== null && total !== null) {
        text = `${index}/${total} (score=${score.toFixed(3)})`;
      } else {
        text = `score=${score.toFixed(3)}`;
      }
      this.scoreText.innerHTML = `${this.getStarHtml()} ${text}`;
      this.scoreElement.style.display = "block";
      this.scoreElement.classList.add("visible");
      this.scoreElement.classList.remove("hidden");
      this.scoreElement.style.backgroundColor = `rgba(0, 0, 0, ${this.opacity})`; // Default background color
      this.scoreElement.style.color = "#fff"; // Default text color
      this.isVisible = true;
    }
  }

  /**
   * Display slide index with format: (star) index/total
   * @param {number} index - Current slide index (0-based)
   * @param {number} total - Total slides
   */
  showIndex(index, total) {
    if (index !== null && total !== null) {
      this.scoreText.innerHTML = `${this.getStarHtml()} ${index + 1}/${total}`;
      this.scoreElement.style.display = "block";
      this.scoreElement.classList.add("visible");
      this.scoreElement.classList.remove("hidden");
      this.scoreElement.style.backgroundColor = `rgba(0, 0, 0, ${this.opacity})`; // Default background color
      this.scoreElement.style.color = "#fff"; // Default text color
      this.isVisible = true;
    }
  }

  /**
   * Display cluster info with format: (star) index/total (cluster=XX)
   * @param {string|number} cluster - Cluster identifier
   * @param {string} color - Background color for cluster
   * @param {number} index - Current position in search results (1-based)
   * @param {number} total - Total search results
   */
  showCluster(cluster, color, index = null, total = null) {
    if (cluster !== undefined && cluster !== null) {
      let clusterText = (cluster === "unclustered") ? "unclustered" : `cluster=${cluster}`;
      let text = "";
      if (index !== null && total !== null) {
        text = `${index}/${total} (${clusterText})`;
      } else {
        text = clusterText === "unclustered" ? "unclustered images" : clusterText;
      }
      this.scoreText.innerHTML = `${this.getStarHtml()} ${text}`;
      this.scoreElement.style.display = "block";
      this.scoreElement.classList.add("visible");
      this.scoreElement.classList.remove("hidden");
      this.isVisible = true;

      if (color) {
        this.scoreElement.style.backgroundColor = color;
        this.scoreElement.style.opacity = this.opacity;
        if (isColorLight(color)) {
          this.scoreElement.style.color = "#000"; // Dark text for light background
        } else {
          this.scoreElement.style.color = "#fff"; // Light text for dark background
        }
      }
    }
  }

  hide() {
    this.scoreElement.classList.add("hidden");
    this.scoreElement.classList.remove("visible");
    this.isVisible = false;

    // Hide after transition
    setTimeout(() => {
      if (!this.isVisible) {
        this.scoreElement.style.display = "none";
      }
    }, 300);
  }

  update(score) {
    if (this.isVisible && score !== undefined && score !== null) {
      this.scoreText.innerHTML = `${this.getStarHtml()} score=${score.toFixed(3)}`;
    }
  }
}

// Create global instance
export const scoreDisplay = new ScoreDisplay();
