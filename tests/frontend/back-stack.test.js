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

  describe("popToPreviousJump (browser back)", () => {
    it("returns false when there's no prior jump", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      expect(backStack.popToPreviousJump()).toBe(false);
    });

    it("pops past the most recent jump and navigates to the step before it", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      emitSlideChanged(51);
      emitSlideChanged(52);
      expect(backStack.popToPreviousJump()).toBe(true);
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
      expect(backStack.size()).toBe(2);
    });

    it("popstate triggers popToPreviousJump", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      backStack.markNextAsJump("search");
      emitSlideChanged(99);
      window.dispatchEvent(
        new window.PopStateEvent("popstate", {
          state: { [HISTORY_MARKER]: "some-id", kind: "jump" },
        })
      );
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 1 }));
    });

    it("ignores popstate events that aren't ours", () => {
      emitSlideChanged(0);
      emitSlideChanged(1);
      backStack.markNextAsJump("search");
      emitSlideChanged(50);
      navigator.mockClear();
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: { unrelated: true } }));
      expect(navigator).not.toHaveBeenCalled();
    });

    it("treats an anchor popstate as a back-one-jump signal too", () => {
      // Reaching the anchor means the user has hit back enough times to
      // pop the last jump entry off the browser history; we should still
      // rewind the in-memory stack.
      emitSlideChanged(0);
      backStack.markNextAsJump("search");
      emitSlideChanged(10);
      navigator.mockClear();
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: { [HISTORY_MARKER]: "anchor" } }));
      expect(navigator).toHaveBeenCalledWith(expect.objectContaining({ globalIndex: 0 }));
    });

    it("handles multiple browser-back hops through stacked jumps", () => {
      // Mirrors the user-reported scenario: ref-image click then search,
      // then two browser-backs should land back at the original slide.
      emitSlideChanged(1);
      backStack.markNextAsJump("reference");
      emitSlideChanged(2);
      backStack.markNextAsJump("search");
      emitSlideChanged(3);

      // 1st browser back: state is the reference jump's entry.
      window.dispatchEvent(
        new window.PopStateEvent("popstate", {
          state: { [HISTORY_MARKER]: "ref-id", kind: "reference" },
        })
      );
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 2 }));

      // 2nd browser back: state is the anchor.
      window.dispatchEvent(new window.PopStateEvent("popstate", { state: { [HISTORY_MARKER]: "anchor" } }));
      expect(navigator).toHaveBeenLastCalledWith(expect.objectContaining({ globalIndex: 1 }));
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

    it("marks the post-switch first slide as a jump", () => {
      emitSlideChanged(5);
      emitAlbumChanged({ album: "other", totalImages: 100 });
      pushStateSpy.mockClear();
      emitSlideChanged(0);
      expect(backStack.peek(1).kind).toBe("jump");
      expect(pushStateSpy).toHaveBeenCalledTimes(1);
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
