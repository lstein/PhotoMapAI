// album-select.js
// The album pulldowns that read as a title: one in the semantic-map titlebar
// (#semanticMapAlbumSelect) and one in the album badge at the top left of the
// swiper/grid view (#albumBadgeSelect). Every `select.album-select` in the
// page is populated with the same album list and kept in step with
// state.album; a change on any of them switches the album through
// settings.js switchAlbum(). When the server locks a single album the badge
// renders a plain #albumBadgeName span instead of a select, which is filled
// with the album's display name.
//
// The list is refreshed from the "albumListChanged" event that settings.js
// dispatches whenever it reloads available_albums/ (initial load and after
// every Album Manager add/edit/delete), so a rename shows up here without a
// second fetch.

import { albumManager } from "./album-manager.js";
import { switchAlbum } from "./settings.js";
import { state } from "./state.js";

const EMPTY_LABEL = "No albums";

let albumsByKey = new Map();

function selects() {
  return Array.from(document.querySelectorAll("select.album-select"));
}

// Let the seek slider re-measure the badge after its text changes — same
// event score-display.js fires when the position text changes.
function dispatchContentChanged() {
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent("scoreDisplayContentChanged"));
  });
}

function fillSelect(select, albums) {
  select.innerHTML = "";
  if (!albums || albums.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = EMPTY_LABEL;
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    return;
  }
  for (const album of albums) {
    const option = document.createElement("option");
    option.value = album.key;
    option.textContent = album.name;
    select.appendChild(option);
  }
}

// Point every select (and the static badge name) at the current album.
function syncCurrentAlbum() {
  for (const select of selects()) {
    if (state.album && albumsByKey.has(state.album)) {
      select.value = state.album;
    } else if (select.options.length > 0) {
      // A key that is not in the list (e.g. the current album was just
      // deleted) would deselect every option and render the select blank;
      // fall back to the first option, which is the placeholder when empty.
      select.selectedIndex = 0;
    }
  }
  const nameEl = document.getElementById("albumBadgeName");
  if (nameEl) {
    const album = state.album ? albumsByKey.get(state.album) : null;
    nameEl.textContent = album ? album.name : state.album || "";
    nameEl.title = nameEl.textContent;
  }
  dispatchContentChanged();
}

// Rebuild the option lists. Pass the album list when the caller already has
// it; otherwise it is fetched.
export async function populateAlbumSelects(albums = null) {
  if (!albums) {
    try {
      albums = await albumManager.fetchAvailableAlbums();
    } catch (err) {
      console.error("Failed to load albums for album pulldowns:", err);
      return;
    }
  }
  albumsByKey = new Map((albums || []).map((album) => [album.key, album]));
  for (const select of selects()) {
    fillSelect(select, albums);
  }
  syncCurrentAlbum();
}

function attachSelect(select) {
  if (select.dataset.listenerAttached === "true") {
    return;
  }
  select.dataset.listenerAttached = "true";
  // Keep pointer-down and double-click from reaching the containers: the
  // semantic-map titlebar would start a drag or toggle its shade. Plain
  // clicks are left alone so document-level "click outside" handlers still
  // close open menus; the badge's own click handler ignores this row.
  for (const evt of ["mousedown", "touchstart", "dblclick"]) {
    select.addEventListener(evt, (e) => e.stopPropagation());
  }
  select.addEventListener("change", () => {
    const newAlbum = select.value;
    if (newAlbum && newAlbum !== state.album) {
      switchAlbum(newAlbum);
    }
    // Drop focus so the next keystroke goes to the global shortcuts rather
    // than to the select's type-ahead, which would switch albums again.
    select.blur();
  });
}

let windowListenersAttached = false;

export function initAlbumSelects() {
  for (const select of selects()) {
    attachSelect(select);
  }
  if (windowListenersAttached) {
    return;
  }
  windowListenersAttached = true;

  window.addEventListener("albumChanged", (e) => {
    // "refresh" is the same album re-indexed in place; nothing to re-select.
    if (e.detail?.changeType !== "refresh") {
      syncCurrentAlbum();
    }
  });

  window.addEventListener("albumListChanged", (e) => {
    populateAlbumSelects(e.detail?.albums ?? null);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initAlbumSelects();
  populateAlbumSelects();
});
