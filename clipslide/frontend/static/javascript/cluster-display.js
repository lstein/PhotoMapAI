// cluster-display.js
// This file manages the cluster display functionality, piggybacking on the score element.
import { isColorLight } from "./utils.js";

export class ClusterDisplay {
  constructor() {
    this.scoreElement = document.getElementById('fixedScoreDisplay');
    this.scoreText = document.getElementById('scoreText');
    this.isVisible = false;
  }

  show(cluster, color, index = null, total = null) {
    if (cluster !== undefined && cluster !== null) {
      let text = `cluster ${cluster}`;
      if (index !== null && total !== null) {
        text += ` (${index}/${total})`;
      }
      this.scoreText.textContent = text;
      this.scoreElement.style.display = 'block';
      this.scoreElement.classList.add('visible');
      this.scoreElement.classList.remove('hidden');
      this.isVisible = true;

      if (color) {
        this.scoreElement.style.backgroundColor = color;
        if (isColorLight(color)) {
          this.scoreElement.style.color = "#000"; // Dark text for light background
        }
        else {
          this.scoreElement.style.color = "#fff"; // Light text for dark background
        }
      }
    }
  }

  hide() {
    this.scoreElement.classList.add('hidden');
    this.scoreElement.classList.remove('visible');
    this.isVisible = false;
    
    // Hide after transition
    setTimeout(() => {
      if (!this.isVisible) {
        this.scoreElement.style.display = 'none';
      }
    }, 300);
  }

  update(cluster, color) {
    if (this.isVisible && cluster !== undefined && cluster !== null) {
      this.scoreText.textContent = `cluster ${cluster}`;
      if (color) {
        this.scoreElement.style.backgroundColor = color;
      }
    }
  }
}

// Create global instance
export const clusterDisplay = new ClusterDisplay();