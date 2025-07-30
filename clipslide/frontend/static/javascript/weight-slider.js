// weight-slider.js
// Support for a weight slider component that allows users to adjust weights interactively.
// Usage:
// <div class="weight-slider-container">
//  <label for="imageWeightSlider">Image Weight</label>
//  <div id="imageWeightSlider"></div>
// </div>
// // In your setup code:
// const imageSlider = new WeightSlider(document.getElementById("imageWeightSlider"), 0.5, (val) => {
//  // handle value change
// });

export class WeightSlider {
  constructor(container, initialValue = 0.5, onChange = null) {
    this.value = initialValue;
    this.onChange = onChange;
    this.container = container;
    this.isDragging = false;
    this.render();
  }

  render() {
    this.container.classList.add("weight-slider");
    this.bar = document.createElement("div");
    this.bar.className = "weight-slider-bar";
    this.fill = document.createElement("div");
    this.fill.className = "weight-slider-fill";
    this.bar.appendChild(this.fill);

    this.valueLabel = document.createElement("span");
    this.valueLabel.className = "weight-slider-value";
    this.valueLabel.textContent = this.value.toFixed(2);

    this.container.innerHTML = "";
    this.container.appendChild(this.bar);
    this.container.appendChild(this.valueLabel);

    this.update();

    // Click to set value
    this.bar.addEventListener("click", (e) => {
      this.setValueFromEvent(e);
    });

    // Drag to set value
    this.bar.addEventListener("mousedown", (e) => {
      this.isDragging = true;
      this.setValueFromEvent(e);
      document.body.style.userSelect = "none";
    });

    window.addEventListener("mousemove", (e) => {
      if (this.isDragging) {
        this.setValueFromEvent(e);
      }
    });

    window.addEventListener("mouseup", () => {
      if (this.isDragging) {
        this.isDragging = false;
        document.body.style.userSelect = "";
      }
    });
  }

  setValueFromEvent(e) {
    const rect = this.bar.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let percent = Math.min(Math.max(x / rect.width, 0), 1);
    this.value = parseFloat(percent.toFixed(2));
    this.update();
    if (this.onChange) this.onChange(this.value);
  }

  update() {
    this.fill.style.width = `${this.value * 100}%`;
    this.valueLabel.textContent = this.value.toFixed(2);
  }

  setValue(val) {
    this.value = Math.min(Math.max(val, 0), 1);
    this.update();
    if (this.onChange) this.onChange(this.value);
  }

  getValue() {
    return this.value;
  }
}