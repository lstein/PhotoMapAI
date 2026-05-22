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
    if (!container) {
      console.error("WeightSlider: container element is null or undefined");
      return;
    }
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

    // Drag to set value. Document-level move/up listeners are added on the
    // mousedown (or touchstart) that begins a drag and removed on release,
    // instead of being installed perma-listening at render time — multiple
    // slider instances used to leak one mousemove + one mouseup listener
    // each onto window, and the slider was unusable on touch devices.
    this.bar.addEventListener("mousedown", (e) => this._beginDrag(e, false));
    this.bar.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          return;
        }
        this._beginDrag(e.touches[0], true);
        e.preventDefault();
      },
      { passive: false }
    );
  }

  _beginDrag(event, isTouch) {
    this.isDragging = true;
    this.setValueFromEvent(event);
    document.body.style.userSelect = "none";

    const onMove = (e) => {
      if (!this.isDragging) {
        return;
      }
      const point = isTouch && e.touches ? e.touches[0] : e;
      this.setValueFromEvent(point);
      if (isTouch) {
        e.preventDefault();
      }
    };

    const onEnd = () => {
      this.isDragging = false;
      document.body.style.userSelect = "";
      document.removeEventListener(isTouch ? "touchmove" : "mousemove", onMove);
      document.removeEventListener(isTouch ? "touchend" : "mouseup", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };

    if (isTouch) {
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    } else {
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
    }
  }

  setValueFromEvent(e) {
    const rect = this.bar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.min(Math.max(x / rect.width, 0), 1);
    this.value = parseFloat(percent.toFixed(2));
    this.update();
    if (this.onChange) {
      this.onChange(this.value);
    }
  }

  update() {
    this.fill.style.width = `${this.value * 100}%`;
    this.valueLabel.textContent = this.value.toFixed(2);
  }

  setValue(val) {
    this.value = Math.min(Math.max(val, 0), 1);
    this.update();
    if (this.onChange) {
      this.onChange(this.value);
    }
  }

  getValue() {
    return this.value;
  }
}
