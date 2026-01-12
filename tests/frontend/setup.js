// Test setup file for Jest with jsdom
import "@testing-library/jest-dom";
import { jest } from "@jest/globals";

// Setup global window.slideshowConfig for tests
global.window = global.window || {};
window.slideshowConfig = {
  currentDelay: 5,
  mode: "chronological",
  album: "test-album",
};

// Make jest available globally for ES modules
global.jest = jest;
