// Unit tests for back-stack.js
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const { backStack, __TEST__ } = await import("../../photomap/frontend/static/javascript/back-stack.js");

const HISTORY_MARKER = __TEST__.HISTORY_MARKER;

function emitSlideChanged(globalIndex, { searchIndex = null, isSearchMode = false } = {}) {
  window.dispatchEvent(
    new CustomEvent("slideChanged", {
      detail: { globalIndex, searchIndex, isSearchMode },
    })
  );
}

function emitAlbumChanged(detail) {
  window.dispatchEvent(new CustomEvent("albumChanged", { detail }));
}

function emitSearchResultsChanged(detail = { results: [{ index: 1 }], searchType: "text" }) {
  window.dispatchEvent(new CustomEvent("searchResultsChanged", { detail }));
}

function emitSeekToSlideIndex(globalIndex, { searchIndex = null, isSearchMode = false } = {}) {
  window.dispatchEvent(
    new CustomEvent("seekToSlideIndex", {
      detail: { globalIndex, searchIndex, isSearchMode },
    })
  );
}

describe("back-stack.js", () => {
  let navigator;
  let pushStateSpy;
  let replaceStateSpy;

  beforeEach(() => {
    backStack._reset();
    navigator = jest.fn();
    backStack.setNavigator(navigator);
    pushStateSpy = jest.spyOn(window.history, "pushState").mockImplementation(() => {});
    replaceStateSpy = jest.spyOn(window.history, "replaceState").mockImplementation(() => {});
  });

  // Silence unused-var lint on replaceStateSpy — kept for clarity that init
  // anchors via replaceState.
  it("anchors history on init", () => {
    backStack._anchored = false;
    backStack.init();
    expect(replaceStateSpy).toHaveBeenCalled();
  });

  describe("step pushes", () => {
    it("appends each new slide as a step entry", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      expect(backStack.size()).toBe(3);
      expect(backStack.peek(1).globalIndex).toBe(2);
      expect(backStack.peek(1).kind).toBe("step");
    });

    it("dedupes consecutive identical positions", () => {
      emitSlideChanged(5);
      emitSlideChanged(5);
      emitSlideChanged(5);
      expect(backStack.size()).toBe(1);
    });

    it("does not call history.pushState for plain steps", () => {
      pushStateSpy.mockClear();
      emitSlideChanged(1);
      emitSlideChanged(2);
      expect(pushStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("jump pushes", () => {
    it("tags the next slide as jump after markNextAsJump()", () => {
      emitSlideChanged(0);
      backStack.markNextAsJump("cluster");
      emitSlideChanged(42);
      const top = backStack.peek(1);
      expect(top.globalIndex).toBe(42);
      expect(top.kind).toBe("cluster");
    });

    it("calls history.pushState with the jump marker", () => {
      pushStateSpy.mockClear();
      backStack.markNextAsJump("cluster");
      emitSlideChanged(42);
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
      const [stateArg] = pushStateSpy.mock.calls[0];
      expect(stateArg[HISTORY_MARKER]).toBeTruthy();
      expect(stateArg.kind).toBe("cluster");
    });

    it("treats searchResultsChanged as a jump signal", () => {
      emitSlideChanged(0);
      emitSearchResultsChanged();
      emitSlideChanged(7, { searchIndex: 0, isSearchMode: true });
      expect(backStack.peek(1).kind).toBe("search");
    });

    it("upgrades a same-position step to a jump when re-emitted as jump", () => {
      emitSlideChanged(3);
      backStack.markNextAsJump("cluster");
      pushStateSpy.mockClear();
      emitSlideChanged(3);
      expect(backStack.size()).toBe(1);
      expect(backStack.peek(1).kind).toBe("cluster");
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("ring buffer cap", () => {
    it("caps entries at MAX_ENTRIES", () => {
      for (let i = 0; i < __TEST__.MAX_ENTRIES + 10; i++) {
        emitSlideChanged(i);
      }
      expect(backStack.size()).toBe(__TEST__.MAX_ENTRIES);
      // Oldest entries are dropped, newest kept.
      expect(backStack.peek(1).globalIndex).toBe(__TEST__.MAX_ENTRIES + 9);
    });
  });

  describe("popOne", () => {
    it("returns false on an empty or single-entry stack", () => {
      expect(backStack.popOne()).toBe(false);
      emitSlideChanged(0);
      expect(backStack.popOne()).toBe(false);
    });

    it("pops the top entry and navigates to the previous one", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      expect(backStack.popOne()).toBe(true);
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
      expect(backStack.size()).toBe(2);
    });

    it("dedupes the slideChanged the swiper fires after navigating back", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      backStack.popOne();
      // Simulate the swiper firing slideChanged for the restored position.
      emitSlideChanged(1);
      // Dedup absorbs the re-emit; no new entry pushed.
      expect(backStack.size()).toBe(2);
    });

    it("emits backStackChanged after popOne so the UI can refresh even when slideChanged is suppressed", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      const listener = jest.fn();
      window.addEventListener("backStackChanged", listener);
      backStack.popOne();
      // The pop itself fires backStackChanged synchronously — independent of
      // whether the swiper subsequently emits slideChanged.
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { size: 1 } }));
      window.removeEventListener("backStackChanged", listener);
    });
  });

  describe("popstate handling (browser back / forward)", () => {
    // Helper: read the most recent state object captured by the spy. Since
    // back-stack calls window.history.pushState, the spy receives the same
    // arguments the browser would persist in the history entry.
    function lastPushedState() {
      const calls = pushStateSpy.mock.calls;
      return calls[calls.length - 1]?.[0] || null;
    }

    function fakePopState(state) {
      window.dispatchEvent(new window.PopStateEvent("popstate", { state }));
    }

    it("ignores popstate events that aren't ours", () => {
      emitSlideChanged(0);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      navigator.mockClear();
      fakePopState({ unrelated: true });
      expect(navigator).not.toHaveBeenCalled();
    });

    it("ignores popstate with an orphan id (entry was truncated)", () => {
      emitSlideChanged(0);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      navigator.mockClear();
      fakePopState({ [HISTORY_MARKER]: "no-such-id" });
      expect(navigator).not.toHaveBeenCalled();
    });

    it("back from a jump navigates to the slide just before it", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      emitSlideChanged(51);
      emitSlideChanged(52);
      navigator.mockClear();
      // Browser back from the search-pushed history entry lands on the anchor.
      fakePopState({ [HISTORY_MARKER]: "anchor" });
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
      expect(backStack.size()).toBe(2);
    });

    it("forward to a jump navigates AT the jump entry", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      const searchState = lastPushedState();
      // Back once.
      fakePopState({ [HISTORY_MARKER]: "anchor" });
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 1 }));
      // Forward — we should land at the search target itself.
      navigator.mockClear();
      fakePopState(searchState);
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 50 }));
      expect(backStack.size()).toBe(3);
    });

    it("multi-hop back through stacked jumps lands at the slide before the most recent jump", () => {
      // Reference-click then search, then back twice.
      emitSlideChanged(1);
      backStack.markNextAsJump("reference");
      emitSlideChanged(2);
      const refState = lastPushedState();
      backStack.markNextAsJump("search");
      emitSlideChanged(3);

      // 1st back: leave the search jump, land before it (at the reference jump).
      fakePopState(refState);
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 2 }));
      // 2nd back: leave the reference jump, land before it.
      fakePopState({ [HISTORY_MARKER]: "anchor" });
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 1 }));
    });

    it("forward restores the cursor position the user was at when they pressed back", () => {
      // User does: seek (#2), seek (#3), arrow-step (#4). Browser-back from
      // slide #4 should land at slide #2 (before the second seek). Then
      // browser-forward should return to slide #4 — the actual position
      // when back was pressed — NOT slide #3 (the seek target).
      emitSlideChanged(0); // slide #1
      backStack.markNextAsJump("seek");
      emitSlideChanged(1); // slide #2 (seek)
      const seek2State = lastPushedState();
      backStack.markNextAsJump("seek");
      emitSlideChanged(2); // slide #3 (seek)
      const seek3State = lastPushedState();
      emitSlideChanged(3); // slide #4 (arrow-step)

      // Browser back: leaving the seek-#3 state, land at slide #2.
      fakePopState(seek2State);
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 1 }));

      // Browser forward: should restore slide #4, not slide #3.
      navigator.mockClear();
      fakePopState(seek3State);
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 3 }));
    });

    it("forward redoes a jump that was undone", () => {
      // Mirror native browser back/forward symmetry.
      emitSlideChanged(1);
      backStack.markNextAsJump("reference");
      emitSlideChanged(2);
      const refState = lastPushedState();
      backStack.markNextAsJump("search");
      emitSlideChanged(3);
      const searchState = lastPushedState();

      fakePopState(refState); // back: leaves search jump, lands at 2.
      fakePopState({ [HISTORY_MARKER]: "anchor" }); // back: leaves reference jump, lands at 1.
      navigator.mockClear();
      fakePopState(refState); // forward: arrives at reference jump (entry 2).
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 2 }));
      fakePopState(searchState); // forward: arrives at search jump (entry 3).
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 3 }));
    });

    it("a new action after back truncates forward history", () => {
      emitSlideChanged(1);
      backStack.markNextAsJump("reference");
      emitSlideChanged(2);
      const refState = lastPushedState();
      backStack.markNextAsJump("search");
      emitSlideChanged(3);
      // Back once.
      fakePopState(refState);
      expect(backStack.size()).toBe(2);
      // New action while on entry 2: the search entry should be dropped.
      emitSlideChanged(99);
      expect(backStack.size()).toBe(3);
      expect(backStack.peek(1).globalIndex).toBe(99);
      // Old search state is now orphaned.
      const previousSearchId = "id-no-longer-valid";
      navigator.mockClear();
      fakePopState({ [HISTORY_MARKER]: previousSearchId });
      expect(navigator).not.toHaveBeenCalled();
    });
  });

  describe("album changes", () => {
    it("clears the stack on album switch", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      emitAlbumChanged({ album: "other", totalImages: 100 });
      expect(backStack.size()).toBe(0);
    });

    it("does NOT mark the post-switch first slide as a jump", () => {
      // Album-load isn't a user action that can be undone. If we pushed it
      // to browser history, browser-back from any post-album navigation
      // would arrive at the anchor with no slide to navigate to, leaving
      // the user stuck.
      emitSlideChanged(5);
      emitAlbumChanged({ album: "other", totalImages: 100 });
      pushStateSpy.mockClear();
      emitSlideChanged(0);
      expect(backStack.peek(1).kind).toBe("step");
      expect(pushStateSpy).not.toHaveBeenCalled();
    });

    it("filters and reindexes entries on deletion", () => {
      emitSlideChanged(0);
      emitSlideChanged(2);
      emitSlideChanged(4);
      emitSlideChanged(6);
      emitAlbumChanged({
        changeType: "deletion",
        deletedIndices: [2, 4],
        totalImages: 4,
      });
      // Entries pointing at 2 and 4 should be dropped; 6 should shift to 6 - 2 = 4.
      // peek(1) returns the newest, peek(size()) the oldest — build oldest→newest.
      const indices = [];
      for (let i = backStack.size(); i >= 1; i--) {
        indices.push(backStack.peek(i).globalIndex);
      }
      expect(indices).toEqual([0, 4]);
    });
  });

  describe("seekToSlideIndex (programmatic navigation)", () => {
    it("pushes when slideState.navigateToIndex dispatches seekToSlideIndex", () => {
      // Mirrors what the seek slider does — emits seekToSlideIndex without
      // also firing slideChanged (because the swiper suppresses its own
      // slideChange for nearby slides).
      emitSlideChanged(0);
      emitSeekToSlideIndex(50);
      expect(backStack.size()).toBe(2);
      expect(backStack.peek(1).globalIndex).toBe(50);
    });

    it("dedupes when both seekToSlideIndex and a follow-up slideChanged fire for the same slide", () => {
      // The far-seek path in the swiper does fire its own slideChange after
      // rebuilding slides; the two events should collapse to one entry.
      emitSlideChanged(0);
      emitSeekToSlideIndex(50);
      emitSlideChanged(50);
      expect(backStack.size()).toBe(2);
    });
  });

  describe("listener-order robustness", () => {
    it("captures jump kind even when slide-state-style listeners run first", () => {
      // Simulate the real-world load order: a bubble-phase listener that
      // mimics slide-state's handler is registered first, dispatches
      // slideChanged synchronously inside its searchResultsChanged handler.
      const fakeSlideStateListener = (e) => {
        if (e.detail?.results?.length) {
          window.dispatchEvent(
            new CustomEvent("slideChanged", {
              detail: { globalIndex: 42, searchIndex: 0, isSearchMode: true },
            })
          );
        }
      };
      window.addEventListener("searchResultsChanged", fakeSlideStateListener);
      try {
        emitSlideChanged(0);
        emitSearchResultsChanged({ results: [{ index: 42 }], searchType: "text" });
        // The push from the fake-slide-state-dispatched slideChanged should
        // still be a jump, not a step.
        expect(backStack.peek(1).kind).toBe("search");
      } finally {
        window.removeEventListener("searchResultsChanged", fakeSlideStateListener);
      }
    });
  });

  describe("popToEntry", () => {
    it("navigates to a specific entry by id and truncates above it", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      emitSlideChanged(3);
      const target = backStack.peek(3); // {globalIndex: 1}
      expect(backStack.popToEntry(target.id)).toBe(true);
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
      expect(backStack.size()).toBe(2);
      expect(backStack.peek(1).globalIndex).toBe(1);
    });

    it("returns false for an unknown id", () => {
      emitSlideChanged(0);
      expect(backStack.popToEntry("bogus")).toBe(false);
    });
  });

  describe("recent()", () => {
    it("returns recent entries excluding the current position, newest first", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      emitSlideChanged(2);
      emitSlideChanged(3);
      const recent = backStack.recent(2);
      expect(recent.map((e) => e.globalIndex)).toEqual([2, 1]);
    });

    it("returns [] when the stack has 1 or 0 entries", () => {
      expect(backStack.recent()).toEqual([]);
      emitSlideChanged(0);
      expect(backStack.recent()).toEqual([]);
    });
  });
});
