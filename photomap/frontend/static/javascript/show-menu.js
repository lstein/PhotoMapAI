// show-menu.js
// The Search panel's "Show" control: a quick way to choose between images,
// videos and both without opening the semantic map.
//
// It holds no filter logic of its own. A choice goes through setMediaFilter,
// and media-filter.js and umap.js react to the event that setter dispatches.

import { albumMediaMix, effectiveMediaFilter } from "./media-filter.js";
import { setMediaFilter, state } from "./state.js";

const MENU_ID = "showMediaMenu";

// Camera and clapper rather than the picture frame: the frame already means
// "search by image" a few icons along, and these two read as a pair.
const CAMERA_PATHS = `
  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
  <circle cx="12" cy="13" r="3" />`;
const CLAPPER_PATHS = `
  <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
  <path d="m6.2 5.3 3.1 3.9" />
  <path d="m12.4 3.4 3.1 4" />
  <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />`;
// "Both" is literally the other two icons. Scaling them down thins the lines
// with them, so the stroke is raised to stay near the weight of the icons
// beside it.
const BOTH_PATHS = `
  <g transform="translate(-.5 -1) scale(.6)" stroke-width="2.9">${CAMERA_PATHS}</g>
  <g transform="translate(10 9.8) scale(.6)" stroke-width="2.9">${CLAPPER_PATHS}</g>`;

const OPTIONS = [
  { value: "images", label: "Images", title: "Images only", paths: CAMERA_PATHS },
  { value: "videos", label: "Videos", title: "Videos only", paths: CLAPPER_PATHS },
  { value: "both", label: "Both", title: "Images and videos", paths: BOTH_PATHS },
];

function iconSvg(paths) {
  return `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function activeOption() {
  // With the album's contents unknown only the map can still be filtered, and
  // what it follows is the stored value.
  const filter = albumMediaMix() === "unknown" ? state.mediaFilter : effectiveMediaFilter();
  return OPTIONS.find((option) => option.value === filter) || OPTIONS[OPTIONS.length - 1];
}

function tooltipText(mix, option) {
  switch (mix) {
    case "videos":
      return "This album contains only videos";
    case "images":
      return "This album contains no videos";
    case "unknown":
      return `Show: ${option.title} (map only: could not read this album's media list)`;
    default:
      return `Show: ${option.title}`;
  }
}

// Make the button read what is actually in force. That is the effective filter
// rather than the stored one: a stored "videos" on an all-photo album filters
// nothing, and the album-specific reason is what the disabled tooltip explains.
//
// Stays enabled when the media list could not be read: the map may be drawing
// a filter that this is the only way to change.
function syncButton() {
  const button = document.getElementById("showMediaBtn");
  const icon = document.getElementById("showMediaIcon");
  if (!button || !icon) {
    return;
  }
  const option = activeOption();
  const mix = albumMediaMix();
  icon.innerHTML = iconSvg(option.paths);
  button.disabled = mix === "images" || mix === "videos";
  button.setAttribute("aria-label", `Show: ${option.title}`);
  // On the container, because a disabled button shows no tooltip of its own in
  // every browser, and the disabled case is the one that needs explaining.
  button.parentElement.title = tooltipText(mix, option);
}

function closeMenu() {
  const menu = document.getElementById(MENU_ID);
  if (menu) {
    menu._cleanup();
    menu.remove();
  }
  document.getElementById("showMediaBtn")?.setAttribute("aria-expanded", "false");
}

function openMenu() {
  closeMenu();
  const button = document.getElementById("showMediaBtn");
  const menu = document.createElement("div");
  menu.id = MENU_ID;
  const active = activeOption();
  for (const option of OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "show-media-item";
    item.dataset.value = option.value;
    item.innerHTML = `${iconSvg(option.paths)}<span class="show-media-item-label">${option.label}</span>`;
    if (option === active) {
      item.setAttribute("aria-current", "true");
    }
    item.addEventListener("click", () => {
      closeMenu();
      setMediaFilter(option.value);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  // In line with the button but above the whole panel, which is pinned to the
  // bottom of the window, so that the menu does not cover the panel's title.
  const left = Math.min(button.getBoundingClientRect().left, window.innerWidth - menu.offsetWidth - 6);
  const panelTop = button.closest("#searchPanel")?.getBoundingClientRect().top ?? button.getBoundingClientRect().top;
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${Math.max(6, panelTop - menu.offsetHeight - 6)}px`;

  // Capture phase: the bookmarks button stops its click from bubbling, so a
  // listener in the bubble phase would leave this menu open behind that one.
  // pointerdown as well, because the map's draggable titlebar cancels the touch
  // and no click follows. The button is left to its own handler, which toggles
  // the menu shut.
  const onOutside = (ev) => {
    if (!menu.contains(ev.target) && !button.contains(ev.target)) {
      closeMenu();
    }
  };
  // Capture and stop, so that dismissing the menu is all Escape does.
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeMenu();
    }
  };
  document.addEventListener("click", onOutside, true);
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  // The menu is placed once, against a panel these move or hide.
  window.addEventListener("resize", closeMenu);
  document.addEventListener("fullscreenchange", closeMenu);
  document.addEventListener("webkitfullscreenchange", closeMenu);
  menu._cleanup = () => {
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", closeMenu);
    document.removeEventListener("fullscreenchange", closeMenu);
    document.removeEventListener("webkitfullscreenchange", closeMenu);
  };
  button.setAttribute("aria-expanded", "true");
}

function refresh() {
  // An open menu may describe an album or a filter that no longer applies.
  closeMenu();
  syncButton();
}

export function initializeShowMenu() {
  const button = document.getElementById("showMediaBtn");
  if (!button) {
    return;
  }
  // Deliberately NOT stopPropagation: the other popups close from listeners on
  // document, and swallowing this click would strand them open behind this one.
  button.addEventListener("click", () => {
    if (document.getElementById(MENU_ID)) {
      closeMenu();
    } else {
      openMenu();
    }
  });
  syncButton();
}

// The stored filter changed: this menu, or the server's copy of the preference
// arriving after boot.
window.addEventListener("mediaFilterSettingChanged", refresh);
// The album's classification changed: an album switch, a reindex, a deletion.
window.addEventListener("mediaIndicesUpdated", refresh);
// Close as soon as the album changes, not when its list lands: until then the
// menu describes an album the user has left.
window.addEventListener("albumChanged", closeMenu);

document.addEventListener("DOMContentLoaded", initializeShowMenu);
