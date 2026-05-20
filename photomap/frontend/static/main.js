// main.js
// This file initializes the application by importing necessary modules and setting up event listeners.

// IMPORTANT: back-stack must load before any module that registers an
// albumChanged or searchResultsChanged listener — its handler must run first
// so it can mark the upcoming slideChanged as a jump. window.dispatchEvent
// listeners fire in registration order; there is no capture-phase shortcut.
import { backStack } from './javascript/back-stack.js';
import './javascript/album-manager.js';
import './javascript/bookmarks.js';
import './javascript/cluster-utils.js';
import './javascript/events.js';
import './javascript/metadata-drawer.js';
import './javascript/invoke-recall.js';
import './javascript/page-visibility.js';
import './javascript/search-ui.js';
import './javascript/search.js';
import './javascript/seek-slider.js';
import './javascript/settings.js';
import { slideState } from './javascript/slide-state.js';
import './javascript/state.js';
import './javascript/swiper.js';
import './javascript/umap.js';
import './javascript/utils.js';
import './javascript/curation.js';

backStack.setNavigator((entry) => {
  slideState.navigateToIndex(entry.globalIndex, entry.isSearchMode);
});
backStack.init();
