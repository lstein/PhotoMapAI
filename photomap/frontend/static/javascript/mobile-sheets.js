// mobile-sheets.js
//
// Phone layout: the Control and Search panels share one bottom sheet, and the
// album badge and seek slider share one top sheet. Each sheet slides between
// expanded and collapsed — collapsed leaves only a grab handle on screen — by
// dragging it or tapping its handle, the bottom-sheet pattern of Google Maps.
//
// The bottom sheet has a third stop above "expanded": "details". The metadata
// drawer's contents (#filenameBanner) are moved into the sheet, under the
// panels, and at the expanded stop only their title row (the file name) shows
// along the sheet's bottom edge. Pulling the sheet further up, or tapping that
// row, opens the rest over the photo. Outside the phone layout the banner goes
// back into its drawer, which works as it always has.
//
// Whether the phone layout applies is decided once, by the media query in
// main.html's <meta name="mobile-sheets-query">, and published as the
// `mobile-sheets` class on <html>. Every stylesheet keys off that class rather
// than repeating the query, so CSS and JS cannot disagree about the mode. The
// sheets' states live on <html> too, as data-top-sheet / data-bottom-sheet.
// An inline script in main.html's <head> sets all three before first paint;
// this module keeps them current afterwards.
//
// The top sheet has a switch of its own: the media query in
// <meta name="top-sheet-query"> and the `top-sheet` class on <html>. It is
// currently "all", so the badge and slider sit in the top sheet on every
// screen, tablets and desktop browsers included, while the bottom sheet (and
// the details in it) is still for phones only. Wherever the phone layout is on
// the top sheet must be too: its rules lean on --top-sheet-peek.
//
// Listeners learn about changes from a `mobileSheetChanged` window event,
// detail { sheet: "top" | "bottom", state, expanded, mobile }, where state is
// "collapsed", "expanded" or (bottom only) "details", and expanded is true for
// either of the last two. It is dispatched for a sheet whenever its state
// changes and for both sheets when the mode changes.

const FALLBACK_QUERY = "(max-width: 600px), (max-height: 500px) and (pointer: coarse)";
const MODE_CLASS = "mobile-sheets";
const TOP_FALLBACK_QUERY = "all";
const TOP_MODE_CLASS = "top-sheet";
const DRAGGING_CLASS = "sheet-dragging";
const BOTTOM_STATE_KEY = "bottomSheetState";

export const SHEET_COLLAPSED = "collapsed";
export const SHEET_EXPANDED = "expanded";
export const SHEET_DETAILS = "details";

// Movement before a press on the sheet becomes a drag rather than a tap. Above
// attachLongPress's 10px cancel threshold would let a drag that started on the
// Slideshow button also open its menu, so stay at or under it.
const DRAG_START_PX = 8;
// Release speed, in px/ms toward the collapsed end or away from it, that
// carries the sheet on to the next stop that way however little it has moved
// — a flick.
const FLICK_SPEED = 0.35;
// Only the last stretch of a drag says which way the finger was going at the
// end; an older sample would let a drag that reversed settle the wrong way.
const VELOCITY_WINDOW_MS = 100;
// How long a click is swallowed after a drag ends. The click a drag produces
// arrives straight after pointerup; this only bounds a listener for a click
// that never comes.
const CLICK_SUPPRESS_MS = 400;
// Movement, in the details content, before a touch is judged a scroll or a
// pull on the sheet. Under the browsers' own scroll slop, so the judgement
// comes before any native scroll can start; over a finger's jitter.
const SCROLLER_DECIDE_PX = 4;

// Controls that keep their own pointer gestures. The seek slider is the one
// that matters: dragging its thumb must seek, not move the sheet.
const OWN_GESTURE_SELECTOR = "input, select, textarea";

/** The media query that selects the phone layout. */
export function mobileSheetsQuery() {
  const meta = document.querySelector('meta[name="mobile-sheets-query"]');
  return meta?.content || FALLBACK_QUERY;
}

/** Is the phone layout in effect? */
export function isMobileSheetsMode() {
  return document.documentElement.classList.contains(MODE_CLASS);
}

/** The media query that puts the badge and slider in the top sheet. */
export function topSheetQuery() {
  const meta = document.querySelector('meta[name="top-sheet-query"]');
  return meta?.content || TOP_FALLBACK_QUERY;
}

/** Are the badge and seek slider in the top sheet? */
export function isTopSheetMode() {
  return document.documentElement.classList.contains(TOP_MODE_CLASS);
}

/** Is the named sheet's layout in effect? */
function sheetModeActive(name) {
  return name === "top" ? isTopSheetMode() : isMobileSheetsMode();
}

// mobile-sheets.css hides the bottom sheet while the page is fullscreen, and
// the top sheet too in the phone layout. On larger screens the top sheet stays
// (the badge in it is hidden), so the slider can still be reached to seek, as
// the hover strip always allowed there.
function sheetsHiddenByFullscreen(name) {
  const fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  return fullscreen && (name === "bottom" || isMobileSheetsMode());
}

function readStoredBottomState() {
  try {
    return localStorage.getItem(BOTTOM_STATE_KEY);
  } catch {
    return null;
  }
}

function storeBottomState(value) {
  try {
    localStorage.setItem(BOTTOM_STATE_KEY, value);
  } catch {
    // Private mode or blocked storage: the sheet still works, it just starts
    // expanded again next time.
  }
}

/**
 * The metadata drawer's contents, which the bottom sheet borrows in the phone
 * layout. `slot` is the sheet's empty container for them, `home` the drawer
 * they come from, and `peekRow` the title row left showing at the expanded
 * stop. The banner is also the details' scroll container.
 */
function findDetails() {
  const slot = document.getElementById("sheetDetails");
  const banner = document.getElementById("filenameBanner");
  const home = document.getElementById("bannerDrawerContainer");
  const peekRow = document.getElementById("filenameTitlebar");
  if (!slot || !banner || !home || !peekRow) {
    return null;
  }
  return { slot, banner, home, peekRow };
}

class Sheet {
  /**
   * @param {object} options
   * @param {"top"|"bottom"} options.name which edge of the window it hangs from
   * @param {HTMLElement} options.element the sheet itself
   * @param {HTMLElement} options.handle the grab handle inside it
   * @param {string} options.peekVar CSS custom property holding the collapsed height
   * @param {number} options.peekFallback px to use when the property is unreadable
   * @param {object|null} [options.details] see findDetails(); bottom sheet only
   */
  constructor({ name, element, handle, peekVar, peekFallback, details = null }) {
    this.name = name;
    this.element = element;
    this.handle = handle;
    this.peekVar = peekVar;
    this.peekFallback = peekFallback;
    this.details = details;
    this.attribute = name === "top" ? "topSheet" : "bottomSheet";
    // Distance travelled toward the collapsed end, for each px the pointer
    // moves down the screen.
    this.direction = name === "top" ? -1 : 1;
    this.drag = null;
    // Per-touch decision, inside the scrolling details, whether a downward
    // drag belongs to the sheet; see onScrollerTouchMove.
    this.touchGate = null;
    // The stop the details were opened from, to go back to on closing them.
    this.stateBeforeDetails = SHEET_EXPANDED;
    // Last on-screen height listeners were told about; see notifyIfResized.
    this.notifiedHeight = null;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
    this.onClick = this.onClick.bind(this);
    this.onScrollerTouchStart = this.onScrollerTouchStart.bind(this);
    this.onScrollerTouchMove = this.onScrollerTouchMove.bind(this);
  }

  /** Is this sheet's layout in effect? */
  active() {
    return sheetModeActive(this.name);
  }

  /** "collapsed", "expanded" or, for a sheet with details, "details". */
  get state() {
    const value = document.documentElement.dataset[this.attribute];
    if (value === SHEET_DETAILS) {
      return this.details ? SHEET_DETAILS : SHEET_EXPANDED;
    }
    return value === SHEET_EXPANDED ? SHEET_EXPANDED : SHEET_COLLAPSED;
  }

  get expanded() {
    return this.state !== SHEET_COLLAPSED;
  }

  /** Collapsed height: what stays on screen, in px. */
  peekHeight() {
    // The bottom sheet's handle is exactly its peek, and its height is the
    // one to trust: a phone held sideways sets the peek with calc() and env()
    // (mobile-sheets.css), which a custom property hands back unevaluated.
    if (this.name === "bottom" && this.handle.offsetHeight > 0) {
      return this.handle.offsetHeight;
    }
    const raw = getComputedStyle(this.element).getPropertyValue(this.peekVar);
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : this.peekFallback;
  }

  /** How far the sheet travels between its two ends, in px. */
  travel() {
    return Math.max(0, this.element.offsetHeight - this.peekHeight());
  }

  /**
   * How far below the fully open position the expanded stop is: the height of
   * the details under their title row, which hang below the window there.
   */
  detailsOffset() {
    if (!this.details || !this.active() || !this.details.slot.contains(this.details.banner)) {
      return 0;
    }
    const { slot } = this.details;
    return Math.min(this.travel(), Math.max(0, slot.offsetHeight - this.detailsPeekHeight()));
  }

  /**
   * How much of the details' title row the expanded stop shows: the CSS's
   * fixed --sheet-details-peek, not the row's height, which grows when the
   * open details let the path wrap.
   */
  detailsPeekHeight() {
    const value = parseFloat(getComputedStyle(this.element).getPropertyValue("--sheet-details-peek"));
    return Number.isFinite(value) ? value : this.details.peekRow.offsetHeight;
  }

  /** Distance toward the collapsed end, from fully open, of a stop. */
  offsetOf(state) {
    if (state === SHEET_COLLAPSED) {
      return this.travel();
    }
    return state === SHEET_DETAILS ? 0 : this.detailsOffset();
  }

  /** The sheet's stops, nearest fully open first. */
  stops() {
    const states = this.details ? [SHEET_DETAILS, SHEET_EXPANDED, SHEET_COLLAPSED] : [SHEET_EXPANDED, SHEET_COLLAPSED];
    return states.map((state) => ({ state, offset: this.offsetOf(state) }));
  }

  /**
   * On-screen height in its settled state, in px. The details stop floats
   * over the photo rather than taking room from it, so it reports the
   * expanded height: what is under the sheet does not reflow as it opens.
   */
  visibleHeight() {
    if (!this.active() || sheetsHiddenByFullscreen(this.name)) {
      return 0;
    }
    if (!this.expanded) {
      return this.peekHeight();
    }
    return this.element.offsetHeight - this.detailsOffset();
  }

  attach() {
    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.element.addEventListener("pointermove", this.onPointerMove);
    this.element.addEventListener("pointerup", this.onPointerUp);
    this.element.addEventListener("pointercancel", this.onPointerCancel);
    this.element.addEventListener("click", this.onClick);
    // The handle is the keyboard's way in (events.js leaves it in the tab
    // order, unlike other buttons), but a mouse press should not leave focus
    // on it for the next Space or Enter to land there.
    this.handle.addEventListener("mousedown", (event) => event.preventDefault());
    if (this.details) {
      const scroller = this.details.banner;
      scroller.addEventListener("touchstart", this.onScrollerTouchStart, { passive: true });
      scroller.addEventListener("touchmove", this.onScrollerTouchMove, { passive: false });
    }
    this.syncAccessibility();
  }

  /**
   * Settle the sheet at a stop.
   *
   * @param {"collapsed"|"expanded"|"details"} state
   * @param {object} [options]
   * @param {boolean} [options.force] notify listeners even if nothing changed
   */
  setState(state, { force = false } = {}) {
    if (state === SHEET_DETAILS && !this.details) {
      state = SHEET_EXPANDED;
    }
    const previous = this.state;
    const changed = state !== previous;
    if (changed && state === SHEET_DETAILS) {
      this.stateBeforeDetails = previous;
    }
    document.documentElement.dataset[this.attribute] = state;
    // The details are a visit, not a preference: only the panels' own stops
    // are remembered, so opening the details from a closed sheet and closing
    // them again leaves it closed next time too.
    if (this.name === "bottom" && changed && state !== SHEET_DETAILS) {
      storeBottomState(state);
    }
    if (changed && state !== SHEET_DETAILS && this.details) {
      // Reopened, the details start from the top again.
      this.details.banner.scrollTop = 0;
    }
    this.syncAccessibility();
    if (changed || force) {
      publishSheetHeights();
      this.notify();
    }
  }

  /** Tell listeners the sheet's stop (and so its height) may have changed. */
  notify() {
    const state = this.state;
    this.notifiedHeight = Math.round(this.visibleHeight());
    window.dispatchEvent(
      new CustomEvent("mobileSheetChanged", {
        detail: {
          sheet: this.name,
          state,
          expanded: state !== SHEET_COLLAPSED,
          // Whether this sheet's layout is in effect.
          mobile: this.active(),
        },
      })
    );
  }

  /**
   * The sheet grew or shrank without moving stop — panel labels switched on,
   * a rotation, the badge taking a second line. Whatever was laid out around
   * it has to be told, just as for a change of stop.
   */
  notifyIfResized() {
    if (this.notifiedHeight !== null && Math.round(this.visibleHeight()) !== this.notifiedHeight) {
      this.notify();
    }
  }

  setExpanded(expanded, options) {
    this.setState(expanded ? SHEET_EXPANDED : SHEET_COLLAPSED, options);
  }

  /**
   * Keep keyboard focus and assistive technology off whatever the sheet has
   * slid out of view, and say on the handle which way it goes.
   */
  syncAccessibility() {
    const mobile = this.active();
    const state = this.state;
    const hidden = mobile && state === SHEET_COLLAPSED;
    for (const child of this.element.children) {
      if (child === this.handle || child.dataset.sheetPeek !== undefined) {
        continue;
      }
      child.inert = hidden;
    }
    if (this.details) {
      // Below the title row, the details are off screen until they open. In
      // the drawer (outside the phone layout) none of this applies.
      const belowFold = mobile && state !== SHEET_DETAILS;
      for (const child of this.details.banner.children) {
        if (child !== this.details.peekRow) {
          child.inert = belowFold;
        }
      }
      if (mobile) {
        this.details.peekRow.setAttribute("aria-expanded", String(state === SHEET_DETAILS));
      } else {
        this.details.peekRow.removeAttribute("aria-expanded");
      }
    }
    this.handle.setAttribute("aria-expanded", String(!hidden));
  }

  /** Is this press in the scrolling part of the details (not their title row)? */
  inDetailsScroller(target) {
    if (!this.details || !target) {
      return false;
    }
    const { banner, peekRow } = this.details;
    return banner.contains(target) && !peekRow.contains(target);
  }

  onPointerDown(event) {
    if (!this.active() || !event.isPrimary) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (event.target.closest?.(OWN_GESTURE_SELECTOR)) {
      return;
    }
    // In the open details, a press in the content scrolls it; only one made
    // with the content already at its top can pull the sheet down instead.
    const fromScroller = this.inDetailsScroller(event.target);
    if (fromScroller && this.details.banner.scrollTop > 0) {
      return;
    }
    this.drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: this.offsetOf(this.state),
      offset: null,
      active: false,
      fromScroller,
      pointerType: event.pointerType,
      samples: [],
    };
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    // A mouse released off the sheet before the drag began (and so before
    // the pointer was captured) sends its pointerup elsewhere; drop the press
    // rather than let a later hover move the sheet.
    if (drag.pointerType === "mouse" && event.buttons === 0) {
      this.drag = null;
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.active) {
      if (Math.abs(dy) < DRAG_START_PX || Math.abs(dy) < Math.abs(dx)) {
        // A sideways press is not a sheet gesture at all; let it go so a
        // later vertical wobble cannot turn it into one.
        if (Math.abs(dx) >= DRAG_START_PX) {
          this.drag = null;
        }
        return;
      }
      // Upward in the details content is a scroll, not a sheet gesture.
      if (drag.fromScroller && dy < 0) {
        this.drag = null;
        return;
      }
      drag.active = true;
      // Keep receiving the moves when the finger leaves the sheet, which it
      // does at once when dragging a collapsed sheet open.
      try {
        this.element.setPointerCapture?.(drag.id);
      } catch {
        // The pointer has already gone; pointerup/cancel will clean up.
      }
      this.element.classList.add(DRAGGING_CLASS);
    }

    const offset = Math.min(this.travel(), Math.max(0, drag.startOffset + dy * this.direction));
    drag.offset = offset;
    drag.samples.push({ t: event.timeStamp, offset });
    while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].t > VELOCITY_WINDOW_MS) {
      drag.samples.shift();
    }
    this.element.style.transform = `translateY(${offset * this.direction}px)`;
    event.preventDefault();
  }

  onPointerUp(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    this.drag = null;
    if (!drag.active) {
      return;
    }
    // A mouse (or pen) press dragged and released still clicks whatever it
    // began on — the Delete button, say. A touch that moved past the slop
    // never clicks, so for touch there is nothing to swallow, and swallowing
    // anyway would eat the user's next real tap.
    if (drag.pointerType !== "touch") {
      this.suppressNextClick();
    }
    this.finishDrag(drag, this.releaseSpeed(drag));
  }

  onPointerCancel(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    this.drag = null;
    if (drag.active) {
      // No release to read a flick from: settle at the nearest stop.
      this.finishDrag(drag, 0);
    }
  }

  /**
   * A touch in the details content scrolls it natively (touch-action: pan-y
   * there), and once the browser starts that pan the pointer is cancelled. A
   * downward drag with the content at its top has nothing to scroll and
   * belongs to the sheet, so stop the browser from claiming it; any other
   * first move is left to scroll.
   */
  onScrollerTouchStart(event) {
    const touch = event.touches[0];
    const atTop = this.details.banner.scrollTop <= 0;
    this.touchGate =
      event.touches.length === 1 &&
      atTop &&
      this.state === SHEET_DETAILS &&
      this.inDetailsScroller(event.target) &&
      !event.target.closest?.(OWN_GESTURE_SELECTOR)
        ? { y: touch.clientY, owner: null }
        : null;
  }

  onScrollerTouchMove(event) {
    const gate = this.touchGate;
    if (!gate) {
      return;
    }
    if (event.touches.length !== 1) {
      this.touchGate = null;
      return;
    }
    if (gate.owner === null) {
      const dy = event.touches[0].clientY - gate.y;
      if (Math.abs(dy) < SCROLLER_DECIDE_PX) {
        return;
      }
      gate.owner = dy > 0 ? "sheet" : "scroll";
    }
    if (gate.owner === "sheet" && event.cancelable) {
      event.preventDefault();
    }
  }

  /** Speed toward the collapsed end at release, in px/ms (negative = opening). */
  releaseSpeed(drag) {
    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    if (!first || !last || last.t <= first.t) {
      return 0;
    }
    return (last.offset - first.offset) / (last.t - first.t);
  }

  finishDrag(drag, speed) {
    this.element.classList.remove(DRAGGING_CLASS);
    this.element.style.transform = "";

    const position = drag.offset ?? drag.startOffset;
    const stops = this.stops();
    let target;
    if (speed > FLICK_SPEED) {
      // On to the next stop toward collapsed, or the last one.
      target = stops.find((stop) => stop.offset > position + 1) ?? stops[stops.length - 1];
    } else if (speed < -FLICK_SPEED) {
      target = [...stops].reverse().find((stop) => stop.offset < position - 1) ?? stops[0];
    } else {
      target = stops.reduce((best, stop) =>
        Math.abs(stop.offset - position) < Math.abs(best.offset - position) ? stop : best
      );
    }
    this.setState(target.state);
  }

  /** Swallow the one click a mouse drag ends in (see onPointerUp). */
  suppressNextClick() {
    const swallow = (event) => {
      event.stopPropagation();
      event.preventDefault();
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("click", swallow, true);
      clearTimeout(timer);
    };
    window.addEventListener("click", swallow, true);
    const timer = setTimeout(cleanup, CLICK_SUPPRESS_MS);
  }

  onClick(event) {
    if (!this.active()) {
      return;
    }
    const state = this.state;
    // The handle steps between collapsed and expanded, and down out of the
    // details. Anywhere else on a collapsed sheet is part of the strip left
    // showing, and opens it — the target there is small enough. The details'
    // title row opens and closes them (its copy button just copies).
    if (this.handle.contains(event.target)) {
      this.setState(state === SHEET_EXPANDED ? SHEET_COLLAPSED : SHEET_EXPANDED);
    } else if (state === SHEET_COLLAPSED) {
      this.setState(SHEET_EXPANDED);
    } else if (this.details?.peekRow.contains(event.target) && !event.target.closest?.("button, a")) {
      this.setState(state === SHEET_DETAILS ? SHEET_EXPANDED : SHEET_DETAILS);
    }
  }
}

const sheets = {};

/**
 * Publish each sheet's settled on-screen height as --top-sheet-height and
 * --bottom-sheet-height on <html>, for rules that have to clear them (the
 * text search box sits above the bottom sheet), and the height of the bottom
 * sheet above its details as --bottom-sheet-panels-height, which sizes them.
 */
function publishSheetHeights() {
  const root = document.documentElement;
  const mobile = isMobileSheetsMode();
  for (const sheet of Object.values(sheets)) {
    const property = `--${sheet.name}-sheet-height`;
    if (sheet.active()) {
      root.style.setProperty(property, `${Math.round(sheet.visibleHeight())}px`);
    } else {
      root.style.removeProperty(property);
    }
  }
  const details = sheets.bottom?.details;
  if (mobile && details) {
    // The sheet is position: fixed, so it is the slot's offsetParent.
    root.style.setProperty("--bottom-sheet-panels-height", `${Math.round(details.slot.offsetTop)}px`);
  } else {
    root.style.removeProperty("--bottom-sheet-panels-height");
  }
}

/** Put the metadata drawer's contents in the bottom sheet, or back. */
function placeDetails(mobile) {
  const details = sheets.bottom?.details;
  if (!details) {
    return;
  }
  const parent = mobile ? details.slot : details.home;
  if (details.banner.parentElement !== parent) {
    parent.appendChild(details.banner);
  }
}

/**
 * On-screen height of a sheet in its settled state, in px; 0 outside the
 * phone layout or before initialization. The bottom sheet's details stop
 * counts as expanded: it floats over the page.
 *
 * @param {"top"|"bottom"} name
 */
export function sheetVisibleHeight(name) {
  return sheets[name]?.visibleHeight() ?? 0;
}

/**
 * Height of a sheet's handle strip, in px; 0 outside the phone layout. For the
 * bottom sheet held sideways on a touch screen that is its collapsed height
 * only while it is collapsed: the handle grows when it collapses.
 *
 * @param {"top"|"bottom"} name
 */
export function sheetPeekHeight(name) {
  if (!sheetModeActive(name)) {
    return 0;
  }
  return sheets[name]?.peekHeight() ?? 0;
}

/** A sheet's stop: "collapsed", "expanded" or "details"; null if there is none. */
export function sheetState(name) {
  return sheets[name]?.state ?? null;
}

/**
 * Move a sheet to a stop from code. No-op outside the phone layout, and while
 * fullscreen hides the sheets: a change made then would only show, unasked
 * for, when fullscreen ends.
 */
export function setSheetState(name, state) {
  if (sheetModeActive(name) && !sheetsHiddenByFullscreen(name)) {
    sheets[name]?.setState(state);
  }
}

/** Close the bottom sheet's details, back to the stop they were opened from. */
export function closeSheetDetails() {
  const sheet = sheets.bottom;
  if (sheet && sheet.state === SHEET_DETAILS && !sheetsHiddenByFullscreen("bottom")) {
    sheet.setState(sheet.stateBeforeDetails === SHEET_COLLAPSED ? SHEET_COLLAPSED : SHEET_EXPANDED);
  }
}

/** Open or close a sheet from code. No-op outside the phone layout. */
export function setSheetExpanded(name, expanded) {
  setSheetState(name, expanded ? SHEET_EXPANDED : SHEET_COLLAPSED);
}

/** Reset a sheet whose layout just switched on or off. */
function resetSheetForMode(sheet) {
  // A drag cannot survive the layout changing under it.
  sheet.drag = null;
  sheet.touchGate = null;
  sheet.element.classList.remove(DRAGGING_CLASS);
  sheet.element.style.transform = "";
}

function applyMode(mobile) {
  const root = document.documentElement;
  const wasMobile = root.classList.contains(MODE_CLASS);
  root.classList.toggle(MODE_CLASS, mobile);
  if (mobile === wasMobile) {
    return;
  }
  for (const sheet of Object.values(sheets)) {
    resetSheetForMode(sheet);
  }
  placeDetails(mobile);
  // The slider row is only ever opened by the user; coming back into the
  // phone layout it starts closed, as it does on load. Nor do the details
  // carry over: the drawer they came from was closed or open on its own.
  if (sheets.top) {
    root.dataset.topSheet = SHEET_COLLAPSED;
  }
  for (const sheet of Object.values(sheets)) {
    const state = sheet.state === SHEET_DETAILS ? SHEET_EXPANDED : sheet.state;
    sheet.setState(state, { force: true });
  }
}

function applyTopMode(topMode) {
  const root = document.documentElement;
  const was = root.classList.contains(TOP_MODE_CLASS);
  root.classList.toggle(TOP_MODE_CLASS, topMode);
  const sheet = sheets.top;
  if (topMode === was || !sheet) {
    return;
  }
  resetSheetForMode(sheet);
  root.dataset.topSheet = SHEET_COLLAPSED;
  sheet.setState(SHEET_COLLAPSED, { force: true });
}

/** Find the sheets in the page and start following the media query. */
export function initializeMobileSheets() {
  const root = document.documentElement;
  if (!root.dataset.bottomSheet) {
    root.dataset.bottomSheet = readStoredBottomState() === SHEET_COLLAPSED ? SHEET_COLLAPSED : SHEET_EXPANDED;
  }
  if (!root.dataset.topSheet) {
    root.dataset.topSheet = SHEET_COLLAPSED;
  }

  const definitions = [
    {
      name: "bottom",
      element: document.getElementById("panelStackContainer"),
      handle: document.getElementById("bottomSheetHandle"),
      peekVar: "--bottom-sheet-peek",
      peekFallback: 24,
      details: findDetails(),
    },
    {
      name: "top",
      element: document.getElementById("topSheetContainer"),
      handle: document.getElementById("topSheetHandle"),
      peekVar: "--top-sheet-peek",
      peekFallback: 26,
    },
  ];
  for (const definition of definitions) {
    if (definition.element && definition.handle) {
      const sheet = new Sheet(definition);
      sheet.attach();
      sheets[definition.name] = sheet;
    }
  }

  const query = window.matchMedia?.(mobileSheetsQuery());
  const mobile = Boolean(query?.matches);
  root.classList.toggle(MODE_CLASS, mobile);
  const topQuery = window.matchMedia?.(topSheetQuery());
  root.classList.toggle(TOP_MODE_CLASS, Boolean(topQuery?.matches));
  placeDetails(mobile);
  for (const sheet of Object.values(sheets)) {
    sheet.syncAccessibility();
  }
  publishSheetHeights();
  query?.addEventListener?.("change", (event) => applyMode(event.matches));
  topQuery?.addEventListener?.("change", (event) => applyTopMode(event.matches));

  // Heights change with rotation and with what the sheets hold (the panel
  // labels can be switched off; a search changes the badge).
  window.addEventListener("resize", publishSheetHeights);
  document.addEventListener("fullscreenchange", publishSheetHeights);
  document.addEventListener("webkitfullscreenchange", publishSheetHeights);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      publishSheetHeights();
      for (const sheet of Object.values(sheets)) {
        sheet.notifyIfResized();
      }
    });
    for (const sheet of Object.values(sheets)) {
      observer.observe(sheet.element);
    }
  }

  // Transitions are switched on only now, so the state the <head> script
  // restored does not animate in on load.
  requestAnimationFrame(() => root.classList.add("sheets-ready"));

  // Announce the starting state. This module initializes as soon as it is
  // imported, before most listeners are attached, so they cannot rely on
  // hearing it: each reads the current state (isMobileSheetsMode,
  // sheetVisibleHeight) when it sets itself up, and listens for changes.
  for (const sheet of Object.values(sheets)) {
    sheet.setState(sheet.state, { force: true });
  }
}

/** Test hook: what the ResizeObserver does, which jsdom lacks. */
export function notifySheetsResizedForTests() {
  publishSheetHeights();
  for (const sheet of Object.values(sheets)) {
    sheet.notifyIfResized();
  }
}

/** Test hook: forget the sheets found by the last initialization. */
export function resetMobileSheetsForTests() {
  for (const key of Object.keys(sheets)) {
    delete sheets[key];
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMobileSheets);
} else {
  initializeMobileSheets();
}
