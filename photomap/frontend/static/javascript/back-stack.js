// back-stack.js
// Tracks recent slide positions to power an in-app Back button and to wire
// history.pushState for coarse-grained "jumps" (search submit, album switch,
// UMAP cluster click, reference-thumbnail click). Slide-by-slide navigation
// is recorded in memory only — only jumps are pushed onto the browser's
// history stack, keeping the browser back button at a useful granularity.
//
// _entries is a timeline (NOT a stack): forward history is preserved when
// the user backs up, so browser Forward can redo a jump that was undone.
// _cursor points to the user's current position in the timeline. A new push
// after a back-action truncates the forward portion of the timeline
// (text-editor undo/redo semantics).

const MAX_ENTRIES = 50;
const HISTORY_MARKER = "photomap-nav";
const STEP_KIND = "step";
const ANCHOR_ID = "anchor";

function isJumpKind(kind) {
  return !!kind && kind !== STEP_KIND;
}

class BackStack {
  constructor() {
    this._entries = [];
    this._cursor = -1;
    // Parallel to the browser's history stack: each entry mirrors one
    // history.pushState call (plus the anchor from init's replaceState).
    // anchor's entryIdx is null; jump entries point at the _entries index
    // where that jump landed the user.
    this._historyStates = [{ id: ANCHOR_ID, entryIdx: null }];
    this._currentHistoryIdx = 0;
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
        window.history.replaceState({ [HISTORY_MARKER]: ANCHOR_ID }, "");
      } catch {
        // ignore — non-fatal
      }
    }
  }

  setNavigator(fn) {
    this._navigator = fn;
  }

  // Called by code paths that perform a coarse-grained jump (UMAP cluster
  // click, reference-thumbnail click). The next slideChanged event will be
  // recorded as a jump and pushed onto the browser history stack.
  markNextAsJump(kind = "jump") {
    this._pendingJumpKind = kind;
  }

  // Number of entries up to and including the current cursor — i.e., how
  // far back the user could pop. Forward history (entries above the cursor)
  // is not counted.
  size() {
    return this._cursor + 1;
  }

  // peek(1) is the user's current position, peek(2) the previous, etc.
  peek(n = 1) {
    const idx = this._cursor - (n - 1);
    if (idx < 0) {
      return null;
    }
    return this._entries[idx] || null;
  }

  // Up to `limit` entries the Back button could pop to, newest first,
  // excluding the user's current position. Does NOT include forward history.
  recent(limit = 10) {
    if (this._cursor <= 0) {
      return [];
    }
    const end = this._cursor;
    const start = Math.max(0, end - limit);
    return this._entries.slice(start, end).reverse();
  }

  // Move cursor one step back. Does not touch _entries (preserves forward
  // history for browser Forward).
  popOne() {
    if (this._cursor <= 0 || !this._navigator) {
      return false;
    }
    this._cursor--;
    const target = this._entries[this._cursor];
    this._notifyChanged();
    this._navigator(target);
    return true;
  }

  // Move cursor to the entry with the given id (must be at or below the
  // current cursor — the flyout only surfaces back-able entries).
  popToEntry(entryId) {
    const idx = this._entries.findIndex((e) => e.id === entryId);
    if (idx < 0 || idx > this._cursor || !this._navigator) {
      return false;
    }
    this._cursor = idx;
    const target = this._entries[idx];
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

    const current = this._cursor >= 0 ? this._entries[this._cursor] : null;
    if (current && current.globalIndex === globalIndex && current.isSearchMode === !!isSearchMode) {
      // Same position re-emitted — common after a restore (the swiper echoes
      // a slideChanged when it actually moves) or when a jump-tagged event
      // re-fires for the same slide. Upgrade kind to jump if needed so the
      // browser-back boundary lands here.
      if (isJumpKind(kind) && !isJumpKind(current.kind)) {
        current.kind = kind;
        this._pushHistory(current);
        this._notifyChanged();
      }
      return;
    }

    // New entry: truncate the forward portion of the timeline and append.
    this._entries.length = this._cursor + 1;
    this._truncateHistoryStatesAboveCursor();

    const entry = {
      globalIndex,
      searchIndex: typeof searchIndex === "number" ? searchIndex : null,
      isSearchMode: !!isSearchMode,
      kind,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    this._entries.push(entry);
    this._cursor = this._entries.length - 1;

    if (this._entries.length > MAX_ENTRIES) {
      const drop = this._entries.length - MAX_ENTRIES;
      this._entries.splice(0, drop);
      this._cursor -= drop;
      // Shift entryIdx in _historyStates and drop any that fell off the front.
      this._historyStates = this._historyStates
        .map((s) => (s.entryIdx === null ? s : { ...s, entryIdx: s.entryIdx - drop }))
        .filter((s) => s.entryIdx === null || s.entryIdx >= 0);
      this._currentHistoryIdx = Math.min(this._currentHistoryIdx, this._historyStates.length - 1);
    }

    if (isJumpKind(kind)) {
      this._pushHistory(entry);
    }
    this._notifyChanged();
  }

  _onAlbumChanged(detail) {
    if (detail && detail.changeType === "deletion" && Array.isArray(detail.deletedIndices)) {
      const deleted = new Set(detail.deletedIndices);
      const sorted = [...detail.deletedIndices].sort((a, b) => a - b);
      const filtered = [];
      let newCursor = this._cursor;
      for (let i = 0; i < this._entries.length; i++) {
        const e = this._entries[i];
        if (deleted.has(e.globalIndex)) {
          if (i <= this._cursor) {
            newCursor--;
          }
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
      this._cursor = filtered.length === 0 ? -1 : Math.max(0, Math.min(newCursor, filtered.length - 1));
      // Browser history entries with the old entryIdx mapping are now stale;
      // dropping all of them is simpler than re-deriving — the user remains
      // in the same album and only loses browser back/forward across
      // pre-deletion jumps.
      this._historyStates = [this._historyStates[0]];
      this._currentHistoryIdx = 0;
      this._notifyChanged();
      return;
    }
    if (detail && detail.changeType === "refresh") {
      // Same album re-indexed in place. Index updates append, so existing
      // entries stay valid unless images were removed — drop only the ones
      // that now point past the end rather than wiping the whole stack.
      const total = typeof detail.totalImages === "number" ? detail.totalImages : Infinity;
      let newCursor = this._cursor;
      const kept = [];
      for (let i = 0; i < this._entries.length; i++) {
        if (this._entries[i].globalIndex >= total) {
          if (i <= this._cursor) {
            newCursor--;
          }
          continue;
        }
        kept.push(this._entries[i]);
      }
      if (kept.length !== this._entries.length) {
        this._entries = kept;
        this._cursor = kept.length === 0 ? -1 : Math.max(0, Math.min(newCursor, kept.length - 1));
        this._historyStates = [this._historyStates[0]];
        this._currentHistoryIdx = 0;
        this._notifyChanged();
      }
      return;
    }
    // Album switch / move / index change: cross-album back doesn't make sense.
    // The next slideChanged is recorded as a plain step (NOT a jump), so the
    // album load itself doesn't create a browser-history entry. If we did
    // push it, browser-back from any post-album navigation would arrive at
    // the anchor and try to navigate to "the slide before the album existed"
    // — a non-position — and silently do nothing, leaving the user stuck.
    this._entries = [];
    this._cursor = -1;
    this._historyStates = [this._historyStates[0]];
    this._currentHistoryIdx = 0;
    this._pendingJumpKind = null;
    this._notifyChanged();
  }

  _onPopState(e) {
    const st = e.state;
    if (!st || !st[HISTORY_MARKER]) {
      // Not one of ours — leave it alone.
      return;
    }
    const stateId = st[HISTORY_MARKER];
    const newHistIdx = stateId === ANCHOR_ID ? 0 : this._historyStates.findIndex((s) => s.id === stateId);
    if (newHistIdx < 0) {
      // Orphan: the matching entry was truncated when the user took a new
      // action after backing up. Skip silently.
      return;
    }
    if (newHistIdx === this._currentHistoryIdx) {
      return;
    }

    let targetCursor;
    if (newHistIdx < this._currentHistoryIdx) {
      // Back: rewind to the slide just before the jump we're leaving.
      const leaving = this._historyStates[this._currentHistoryIdx];
      if (leaving.entryIdx === null) {
        // Shouldn't happen — the anchor lives at index 0, you can't leave it
        // by going backwards.
        return;
      }
      // Record where the user was on this state so a future forward can
      // restore them there (instead of the jump's original landing position,
      // which may be behind their actual cursor if they took steps after
      // the jump).
      leaving.lastCursorBeforeLeaving = this._cursor;
      targetCursor = leaving.entryIdx - 1;
    } else {
      // Forward: prefer the cursor the user was at when they last left this
      // state (saved during the back-popstate that landed us here), so steps
      // taken after the original jump are restored too. Fall back to the
      // jump's original entryIdx if no leaving-cursor was recorded or if
      // it's been invalidated by a truncation.
      const arriving = this._historyStates[newHistIdx];
      if (arriving.entryIdx === null) {
        return;
      }
      const restored = arriving.lastCursorBeforeLeaving;
      if (typeof restored === "number" && restored >= 0 && restored < this._entries.length) {
        targetCursor = restored;
      } else {
        targetCursor = arriving.entryIdx;
      }
    }

    this._currentHistoryIdx = newHistIdx;

    if (targetCursor >= 0 && targetCursor < this._entries.length && this._navigator) {
      this._cursor = targetCursor;
      const target = this._entries[this._cursor];
      this._notifyChanged();
      this._navigator(target);
    } else {
      // Notify even when we don't navigate (e.g., backed to the anchor) so
      // the UI can refresh its enabled/disabled state.
      this._notifyChanged();
    }
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
    // Browser truncates forward history on pushState; mirror that in our
    // parallel array.
    this._historyStates.length = this._currentHistoryIdx + 1;
    this._historyStates.push({ id: entry.id, entryIdx: this._cursor });
    this._currentHistoryIdx = this._historyStates.length - 1;
  }

  _truncateHistoryStatesAboveCursor() {
    // Drop _historyStates entries that reference entries beyond the cursor.
    // The anchor (entryIdx === null) is always preserved.
    for (let i = this._historyStates.length - 1; i > 0; i--) {
      const s = this._historyStates[i];
      if (s.entryIdx !== null && s.entryIdx > this._cursor) {
        this._historyStates.splice(i, 1);
        if (i <= this._currentHistoryIdx) {
          this._currentHistoryIdx--;
        }
      }
    }
    if (this._currentHistoryIdx >= this._historyStates.length) {
      this._currentHistoryIdx = this._historyStates.length - 1;
    }
  }

  _notifyChanged() {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("backStackChanged", { detail: { size: this.size() } }));
  }

  // Test hook.
  _reset() {
    this._entries = [];
    this._cursor = -1;
    this._historyStates = [{ id: ANCHOR_ID, entryIdx: null }];
    this._currentHistoryIdx = 0;
    this._pendingJumpKind = null;
  }
}

export const backStack = new BackStack();
export const __TEST__ = { MAX_ENTRIES, HISTORY_MARKER, ANCHOR_ID };
