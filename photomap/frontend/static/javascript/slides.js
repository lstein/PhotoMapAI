// Functions for retrieving slides from the album or search results
import { fetchImageByIndex } from "./search.js";
import { state } from "./state.js";

// Return the next count image data objects
export async function fetchSlideBatch(offset=0, count = 1) {
  if (!state.album) return; // No album set, cannot add slide

  let slides = [];
  let index;
  for (let i = 0; i < count; i++) {
    if (state.searchResults?.length > 0) {
      // return indexs into search results
      index = state.searchResults[state.currentSearchIndex + offset + i]?.index || 0;
    } else if (state.mode === "random") {
      index = Math.floor(Math.random() * state.totalImages);
    } else {
      index = state.currentGlobalIndex + offset + i;
    }
    console.log("fetchNextSlideBatch: fetching index", index);
    slides.push(await fetchImageByIndex(index));
  }
  return slides;
}

// // Keep track of the current slide index
// // Returns an array of [globalIndex, totalImages, searchIndex]
// // searchIndex is the index within the search results.
// // Indices are returned as -1 if not available.
// export async function getCurrentSlideIndex() {

//   // Handle search results
//   if (state.searchResults.length > 0) {
//     if (state.currentGlobalIndex === -1) {
//       return [-1, state.searchResults.length, -1]; // Default to first slide if no current slide
//     } else {
//       return [state.currentGlobalIndex, state.searchResults.length, state.currentSearchIndex]
//     }
//   }
// }
