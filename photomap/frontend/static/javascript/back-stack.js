// back-stack.js
// Tracks recent slide positions to power an in-app Back button and to wire
// history.pushState for coarse-grained "jumps" (search submit, album switch,
// UMAP cluster click, reference-thumbnail click). Slide-by-slide navigation
// is recorded in memory only — only jumps are pushed onto the browser's
// history stack, keeping the browser back button at a useful granularity.

const MAX_ENTRIES = 50;
const HISTORY_MARKER = "photomap-nav";
const STEP_KIND = "step";

function isJumpKind(kind) {
  return !!kind && kind !== STEP_KIND;
}

class BackStack {
  constructor() {
    this._entries = [];
    this._pendingJumpKind = null;
    this._navigator = null;
    this._anchored = false;

    if (typeof window !== "undefined") {
      window.addEventListener("slideChanged", (e) => this._onSlideChanged(e.detail));
      // seekToSlideIndex fires from slideState.navigateToIndex (seek slider,
      // UMAP cluster click, reference-thumbnail click, our own back-restore).
      // The swiper suppresses its own slideChange handler when seeking to a
      // nearby slide, so listening here is the only way to track programmatic
      // navigation reliably.
      window.addEventListener("seekToSlideIndex", (e) => this._onSlideChanged(e.detail));
      // These two must run before slide-state's listeners so that we can set
      // pendingJumpKind / clear the stack before the resulting slideChanged
      // fires. main.js imports back-stack first to make this true — the
      // listener-registration order on window is what determines firing order
      // (capture:true has no effect for window-dispatched events).
      window.addEventListener("searchResultsChanged", () => this.markNextAsJump("search"));
      window.addEventListener("albumChanged", (e) => this._onAlbumChanged(e.detail));
      window.addEventListener("popstate", (e) => this._onPopState(e));
    }
  }

  init() {
    if (this._anchored) {
      return;
    }
    this._anchored = true;
    if (typeof window !== "undefined" && window.history?.replaceState) {
      try {
        window.history.replaceState({ [HISTORY_MARKER]: "anchor" }, "");
      } catch {
        // ignore — non-fatal
      }
    }
  }

  // Wire the actual slide navigator. Called once during app startup.
  // The function receives an entry and should move the swiper to that position.
  setNavigator(fn) {
    this._navigator = fn;
  }

  // Called by code paths that perform a coarse-grained jump (UMAP cluster
  // click, reference-thumbnail click). The next slideChanged event will be
  // recorded as a jump and pushed onto the browser history stack.
  markNextAsJump(kind = "jump") {
    this._pendingJumpKind = kind;
  }

  size() {
    return this._entries.length;
  }

  // Latest entry is the user's current position. peek(1) returns that;
  // peek(2) returns the slide before it (the "back" target), and so on.
  peek(n = 1) {
    return this._entries[this._entries.length - n] || null;
  }

  // Returns the most recent `limit` entries that the back button could pop to,
  // newest first, excluding the user's current position.
  recent(limit = 10) {
    const end = this._entries.length - 1;
    const start = Math.max(0, end - limit);
    return this._entries.slice(start, end).reverse();
  }

  // Pop the current position, navigate to the previous one. Returns true if
  // a back navigation was performed.
  popOne() {
    if (this._entries.length < 2 || !this._navigator) {
      return false;
    }
    this._entries.pop();
    const target = this._entries[this._entries.length - 1];
    this._notifyChanged();
    this._navigator(target);
    return true;
  }

  // Truncate the stack so the entry with the given id becomes the top, then
  // navigate to it. Used by the thumbnail flyout where the user selects a
  // specific prior position to jump back to.
  popToEntry(entryId) {
    const idx = this._entries.findIndex((e) => e.id === entryId);
    if (idx < 0 || !this._navigator) {
      return false;
    }
    this._entries.length = idx + 1;
    const target = this._entries[idx];
    this._notifyChanged();
    this._navigator(target);
    return true;
  }

  // Pop the stack until just past the most recent jump entry, then navigate
  // there. This is the browser-back semantic.
  popToPreviousJump() {
    let jumpIdx = -1;
    for (let i = this._entries.length - 1; i >= 0; i--) {
      if (isJumpKind(this._entries[i].kind)) {
        jumpIdx = i;
        break;
      }
    }
    if (jumpIdx <= 0 || !this._navigator) {
      return false;
    }
    this._entries.splice(jumpIdx);
    const target = this._entries[this._entries.length - 1];
    this._notifyChanged();
    this._navigator(target);
    return true;
  }

  _onSlideChanged(detail) {
    const { globalIndex, searchIndex, isSearchMode } = detail || {};
    if (typeof globalIndex !== "number") {
      return;
    }

    const kind = this._pendingJumpKind || STEP_KIND;
    this._pendingJumpKind = null;

    const last = this._entries[this._entries.length - 1];
    if (last && last.globalIndex === globalIndex && last.isSearchMode === !!isSearchMode) {
      // Same position re-emitted — handles two cases:
      // 1. Restore: a popOne/popToEntry just landed here and the swiper has
      //    now reported the new active slide; dedup absorbs the re-push.
      // 2. A jump-tagged event for the same slide upgrades kind to jump so
      //    the browser-back boundary lands here.
      if (isJumpKind(kind) && !isJumpKind(last.kind)) {
        last.kind = kind;
        this._pushHistory(last);
        this._notifyChanged();
      }
      return;
    }

    const entry = {
      globalIndex,
      searchIndex: typeof searchIndex === "number" ? searchIndex : null,
      isSearchMode: !!isSearchMode,
      kind,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    this._entries.push(entry);
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.splice(0, this._entries.length - MAX_ENTRIES);
    }

    if (isJumpKind(kind)) {
      this._pushHistory(entry);
    }
    this._notifyChanged();
  }

  _onAlbumChanged(detail) {
    // Deletion: filter entries pointing at deleted indices and shift the rest.
    if (detail && detail.changeType === "deletion" && Array.isArray(detail.deletedIndices)) {
      const deleted = new Set(detail.deletedIndices);
      const sorted = [...detail.deletedIndices].sort((a, b) => a - b);
      const filtered = [];
      for (const e of this._entries) {
        if (deleted.has(e.globalIndex)) {
          continue;
        }
        let before = 0;
        for (const d of sorted) {
          if (d < e.globalIndex) {
            before++;
          } else {
            break;
          }
        }
        filtered.push({ ...e, globalIndex: e.globalIndex - before });
      }
      this._entries = filtered;
      this._notifyChanged();
      return;
    }
    // Album switch / move / index change: cross-album back doesn't make sense.
    this._entries = [];
    this._pendingJumpKind = "jump";
    this._notifyChanged();
  }

  _onPopState(e) {
    const st = e.state;
    if (!st || !st[HISTORY_MARKER]) {
      // Not one of ours — leave it alone.
      return;
    }
    // Whether this is one of our jump entries or the anchor (the original
    // entry created by replaceState on init), the user has moved one step
    // back in browser history. Rewind the stack to the position before the
    // most recent jump.
    this.popToPreviousJump();
  }

  _pushHistory(entry) {
    if (typeof window === "undefined" || !window.history?.pushState) {
      return;
    }
    try {
      window.history.pushState({ [HISTORY_MARKER]: entry.id, kind: entry.kind }, "");
    } catch {
      // ignore — non-fatal
    }
  }

  _notifyChanged() {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("backStackChanged", { detail: { size: this._entries.length } }));
  }

  // Test hook.
  _reset() {
    this._entries = [];
    this._pendingJumpKind = null;
  }
}

export const backStack = new BackStack();
export const __TEST__ = { MAX_ENTRIES, HISTORY_MARKER };
