// state.js
// This file manages the state of the application, including slide management and metadata handling.

export const state = {
  swiper: null, // Will be initialized in swiper.js
  currentTextToCopy: "", // Text to be copied to clipboard
  currentDelay: 5, // Delay in seconds for slide transitions
  mode: "random", // next slide selection when no search is active ("random", "sequential", "search")
  embeddingsFile: null, // Path to the current embeddings file
  highWaterMark: 20, // Maximum number of slides to load at once
  searchIndex: 0, // When in search mode, this is the index of the current slide in the search results
  searchResults: [], // List of file paths matching the current search query
};
