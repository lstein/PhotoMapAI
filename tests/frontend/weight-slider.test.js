// Unit tests for weight-slider.js
import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { WeightSlider } from "../../photomap/frontend/static/javascript/weight-slider.js";

describe("weight-slider.js", () => {
  let container;
  let onChangeMock;

  beforeEach(() => {
    document.body.innerHTML = '<div id="sliderContainer"></div>';
    container = document.getElementById("sliderContainer");
    onChangeMock = jest.fn();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("should initialize with default value of 0.5", () => {
      const slider = new WeightSlider(container);
      expect(slider.value).toBe(0.5);
    });

    it("should initialize with custom initial value", () => {
      const slider = new WeightSlider(container, 0.75);
      expect(slider.value).toBe(0.75);
    });

    it("should store onChange callback", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);
      expect(slider.onChange).toBe(onChangeMock);
    });

    it("should handle null container gracefully", () => {
      // Should log error but not throw
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
      new WeightSlider(null);
      expect(consoleErrorSpy).toHaveBeenCalledWith("WeightSlider: container element is null or undefined");
      consoleErrorSpy.mockRestore();
    });
  });

  describe("render", () => {
    it("should add weight-slider class to container", () => {
      new WeightSlider(container);
      expect(container.classList.contains("weight-slider")).toBe(true);
    });

    it("should create bar element", () => {
      new WeightSlider(container);
      const bar = container.querySelector(".weight-slider-bar");
      expect(bar).toBeInTheDocument();
    });

    it("should create fill element inside bar", () => {
      new WeightSlider(container);
      const fill = container.querySelector(".weight-slider-fill");
      expect(fill).toBeInTheDocument();
    });

    it("should create value label", () => {
      new WeightSlider(container);
      const label = container.querySelector(".weight-slider-value");
      expect(label).toBeInTheDocument();
    });

    it("should display initial value in label", () => {
      new WeightSlider(container, 0.75);
      const label = container.querySelector(".weight-slider-value");
      expect(label.textContent).toBe("0.75");
    });
  });

  describe("update", () => {
    it("should update fill width based on value", () => {
      new WeightSlider(container, 0.5);
      const fill = container.querySelector(".weight-slider-fill");
      expect(fill.style.width).toBe("50%");
    });

    it("should update value label", () => {
      new WeightSlider(container, 0.33);
      const label = container.querySelector(".weight-slider-value");
      expect(label.textContent).toBe("0.33");
    });
  });

  describe("setValue", () => {
    it("should set new value", () => {
      const slider = new WeightSlider(container, 0.5);
      slider.setValue(0.8);
      expect(slider.value).toBe(0.8);
    });

    it("should clamp value to minimum of 0", () => {
      const slider = new WeightSlider(container, 0.5);
      slider.setValue(-0.5);
      expect(slider.value).toBe(0);
    });

    it("should clamp value to maximum of 1", () => {
      const slider = new WeightSlider(container, 0.5);
      slider.setValue(1.5);
      expect(slider.value).toBe(1);
    });

    it("should call onChange callback", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);
      slider.setValue(0.75);
      expect(onChangeMock).toHaveBeenCalledWith(0.75);
    });

    it("should update UI after setting value", () => {
      const slider = new WeightSlider(container, 0.5);
      slider.setValue(0.25);

      const fill = container.querySelector(".weight-slider-fill");
      const label = container.querySelector(".weight-slider-value");

      expect(fill.style.width).toBe("25%");
      expect(label.textContent).toBe("0.25");
    });
  });

  describe("getValue", () => {
    it("should return current value", () => {
      const slider = new WeightSlider(container, 0.65);
      expect(slider.getValue()).toBe(0.65);
    });

    it("should return updated value after setValue", () => {
      const slider = new WeightSlider(container, 0.5);
      slider.setValue(0.9);
      expect(slider.getValue()).toBe(0.9);
    });
  });

  describe("setValueFromEvent", () => {
    it("should set value based on click position", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);

      // Mock getBoundingClientRect
      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Simulate click at 75% position
      slider.setValueFromEvent({ clientX: 75 });

      expect(slider.value).toBe(0.75);
      expect(onChangeMock).toHaveBeenCalledWith(0.75);
    });

    it("should clamp value when click is beyond left edge", () => {
      const slider = new WeightSlider(container, 0.5);

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 50,
        width: 100,
      }));

      // Simulate click before the bar
      slider.setValueFromEvent({ clientX: 0 });

      expect(slider.value).toBe(0);
    });

    it("should clamp value when click is beyond right edge", () => {
      const slider = new WeightSlider(container, 0.5);

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Simulate click beyond the bar
      slider.setValueFromEvent({ clientX: 150 });

      expect(slider.value).toBe(1);
    });
  });

  describe("click interaction", () => {
    it("should update value on bar click", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);
      const bar = container.querySelector(".weight-slider-bar");

      // Mock getBoundingClientRect
      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Simulate click event
      const clickEvent = new MouseEvent("click", { clientX: 30 });
      bar.dispatchEvent(clickEvent);

      expect(slider.value).toBe(0.3);
    });
  });

  describe("drag interaction", () => {
    it("should set isDragging to true on mousedown", () => {
      const slider = new WeightSlider(container, 0.5);
      const bar = container.querySelector(".weight-slider-bar");

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      const mousedownEvent = new MouseEvent("mousedown", { clientX: 50 });
      bar.dispatchEvent(mousedownEvent);

      expect(slider.isDragging).toBe(true);
    });

    it("should set isDragging to false on mouseup", () => {
      const slider = new WeightSlider(container, 0.5);
      const bar = container.querySelector(".weight-slider-bar");

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Start drag
      const mousedownEvent = new MouseEvent("mousedown", { clientX: 50 });
      bar.dispatchEvent(mousedownEvent);

      // End drag
      const mouseupEvent = new MouseEvent("mouseup");
      window.dispatchEvent(mouseupEvent);

      expect(slider.isDragging).toBe(false);
    });

    it("should update value on mousemove while dragging", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);
      const bar = container.querySelector(".weight-slider-bar");

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Start drag
      const mousedownEvent = new MouseEvent("mousedown", { clientX: 50 });
      bar.dispatchEvent(mousedownEvent);

      // Clear the onChange call from mousedown
      onChangeMock.mockClear();

      // Move mouse
      const mousemoveEvent = new MouseEvent("mousemove", { clientX: 70 });
      window.dispatchEvent(mousemoveEvent);

      expect(slider.value).toBe(0.7);
      expect(onChangeMock).toHaveBeenCalledWith(0.7);
    });

    it("should not update value on mousemove when not dragging", () => {
      const slider = new WeightSlider(container, 0.5, onChangeMock);

      slider.bar.getBoundingClientRect = jest.fn(() => ({
        left: 0,
        width: 100,
      }));

      // Move mouse without starting drag
      const mousemoveEvent = new MouseEvent("mousemove", { clientX: 70 });
      window.dispatchEvent(mousemoveEvent);

      expect(slider.value).toBe(0.5);
      expect(onChangeMock).not.toHaveBeenCalled();
    });
  });
});
