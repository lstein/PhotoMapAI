// Functions for retrieving slides from the album or search results
import { fetchImageByIndex } from "./search.js";
import { state } from "./state.js";

// Return the next count image data objects
export async function fetchNextSlideBatch(count = 1) {
  if (!state.album) return; // No album set, cannot add slide

  let slides = [];
  let index;
  for (let i = 0; i < count; i++) {
    if (state.searchResults?.length > 0) {
      // return indexs into search results
      index = state.searchResults[state.currentSearchIndex++]?.index || 0;
    } else if (state.mode === "random") {
      console.log("Total images:", state.totalImages);
      index = Math.floor(Math.random() * state.totalImages);
    } else {
      index = state.currentGlobalIndex++;
    }
    console.log("fetchNextSlideBatch: fetching index", index);
    slides.push(await fetchImageByIndex(index));
  }
  return slides;
}
