# PhotoMapAI Frontend JavaScript Tests

This directory contains unit tests for the PhotoMapAI frontend JavaScript components using Jest with jsdom.

## Test Stack

- **Jest** (v29.7.0) - JavaScript testing framework
- **jest-environment-jsdom** - Provides DOM simulation for testing browser code
- **@testing-library/dom** - DOM testing utilities
- **@testing-library/jest-dom** - Custom Jest matchers for DOM assertions

## Running Tests

From the repository root directory:

```bash
# Install dependencies
npm install

# Run all tests
npm test
```

## Test Coverage

The following JavaScript modules are covered by unit tests:

### utils.js (33 tests)
- `showSpinner()` - Shows the loading spinner
- `hideSpinner()` - Hides the loading spinner
- `joinPath()` - Joins directory paths correctly
- `isColorLight()` - Determines if a color is light or dark
- `debounce()` - Debounces function calls with configurable delay
- `getPercentile()` - Calculates percentile values from arrays
- `setCheckmarkOnIcon()` - Adds/removes checkmark overlays on icons

### search.js (10 tests)
- `calculate_search_score_cutoff()` - Calculates weighted search score cutoffs
- `setSearchResults()` - Sets search results and dispatches events

### slideshow.js (23 tests)
- `slideShowRunning()` - Checks if slideshow autoplay is active
- `updateSlideshowButtonIcon()` - Updates play/pause button icons
- `showPlayPauseIndicator()` - Shows fullscreen play/pause indicator
- `removeExistingIndicator()` - Removes existing indicators

### score-display.js (26 tests)
- `ScoreDisplay` class
  - `show()` - Displays score with formatting
  - `showIndex()` - Displays slide index
  - `showCluster()` - Displays cluster information
  - `hide()` - Hides the score display
  - `update()` - Updates displayed score

### weight-slider.js (28 tests)
- `WeightSlider` class
  - Constructor and initialization
  - `render()` - Renders slider UI
  - `update()` - Updates slider display
  - `setValue()` - Sets slider value with clamping
  - `getValue()` - Gets current value
  - `setValueFromEvent()` - Sets value from mouse events
  - Click and drag interactions

## Test Coverage Gaps

The following modules are not yet covered by tests and represent areas for future improvement:

- `album-manager.js` - Album management functionality (has DOM side effects on import)
- `control-panel.js` - Control panel UI
- `events.js` - Global event handlers
- `filetree.js` - Directory picker functionality
- `grid-view.js` - Grid view swiper
- `index.js` - Index metadata functions
- `metadata-drawer.js` - Metadata overlay
- `progress-bar.js` - Index progress polling (has FormData constructor issue)
- `seek-slider.js` - Slide seeking slider
- `settings.js` - Settings management
- `slide-state.js` - Slide state management
- `swiper.js` - Single swiper initialization
- `touch.js` - Touch event handlers
- `umap.js` - UMAP visualization

## CI Integration

JavaScript tests run automatically on pull requests via GitHub Actions when changes are made to:
- `photomap/frontend/static/javascript/**`
- `tests/frontend/**`
- `package.json`
- `jest.config.js`

See `.github/workflows/run_js_tests.yml` for the workflow configuration.

## Writing New Tests

When adding new tests:

1. Create a test file in `tests/frontend/` with the naming convention `<module-name>.test.js`
2. Import Jest globals and the module under test:
   ```javascript
   import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
   import { functionToTest } from '../../photomap/frontend/static/javascript/module.js';
   ```
3. If the module has dependencies with DOM side effects (like album-manager.js), use `jest.unstable_mockModule()` to mock them before importing:
   ```javascript
   jest.unstable_mockModule('../../photomap/frontend/static/javascript/album-manager.js', () => ({
     albumManager: { fetchAvailableAlbums: jest.fn(() => Promise.resolve([])) }
   }));
   const { functionToTest } = await import('../../photomap/frontend/static/javascript/module.js');
   ```
4. Use fake timers for testing debounce, setTimeout, and animation-related code:
   ```javascript
   beforeEach(() => { jest.useFakeTimers(); });
   afterEach(() => { jest.useRealTimers(); });
   ```
