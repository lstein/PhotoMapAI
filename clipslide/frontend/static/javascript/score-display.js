// score-display.js
// This file manages the score display functionality, showing and hiding the score overlay.
export class ScoreDisplay {
  constructor() {
    this.scoreElement = document.getElementById('fixedScoreDisplay');
    this.scoreText = document.getElementById('scoreText');
    this.isVisible = false;
  }

  show(score) {
    if (score !== undefined && score !== null) {
      this.scoreText.textContent = `score=${score.toFixed(3)}`;
      this.scoreElement.style.display = 'block';
      this.scoreElement.classList.add('visible');
      this.scoreElement.classList.remove('hidden');
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