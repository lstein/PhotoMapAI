// score-display.js
// This file manages the score display functionality, showing and hiding the score overlay.
export class ScoreDisplay {
  constructor() {
    this.scoreElement = document.getElementById('fixedScoreDisplay');
    this.scoreText = document.getElementById('scoreText');
    this.isVisible = false;
  }

  show(score, index = null, total = null) {
    if (score !== undefined && score !== null) {
      let text = `score=${score.toFixed(3)}`;
      if (index !== null && total !== null) {
        text += ` (${index}/${total})`;
      }
      this.scoreText.textContent = text;
      this.scoreElement.style.display = 'block';
      this.scoreElement.classList.add('visible');
      this.scoreElement.classList.remove('hidden');
      this.scoreElement.style.backgroundColor = "rgba(0, 0, 0, 0.5)"; // Default background color
      this.scoreElement.style.color = "#fff"; // Default text color
      this.isVisible = true;
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

  update(score) {
    if (this.isVisible && score !== undefined && score !== null) {
      this.scoreText.textContent = `score=${score.toFixed(3)}`;
    }
  }
}

// Create global instance
export const scoreDisplay = new ScoreDisplay();