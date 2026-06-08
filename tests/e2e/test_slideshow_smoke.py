"""End-to-end smoke tests for the slideshow, driven through a real browser.

Run with:  RUN_E2E=1 pytest tests/e2e -m e2e

The shuffle test is a regression guard for the freeze fixed in the
"keep shuffle autoplay alive after high-water-mark trim" change: trimming the
slide buffer at the high-water mark stopped Swiper autoplay, so shuffle froze
after ~19 slides. That bug was invisible to the jsdom unit tests (they mock
Swiper) and only reproduced in a real browser — exactly what this guards.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.e2e

# Cross the slide buffer's high-water mark (20) so the trim path runs. With the
# autoplay-restart fix the show sails past this; without it, it freezes here.
SHUFFLE_TARGET_ADVANCES = 25
AUTOPLAY_DELAY_MS = 250


def _select_album(page, album_key: str = "e2e") -> None:
    # The native <select> is hidden behind a custom dropdown, so wait for the
    # album option to be populated (async fetch) rather than for visibility, and
    # drive it via the change event the app listens for.
    page.wait_for_function(
        """(key) => {
            const sel = document.getElementById('albumSelect');
            return sel && Array.from(sel.options).some((o) => o.value === key);
        }""",
        arg=album_key,
        timeout=20_000,
    )
    page.evaluate(
        """(key) => {
            const sel = document.getElementById('albumSelect');
            sel.value = key;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        album_key,
    )
    # Wait until the swiper has the album loaded (at least one real slide).
    page.wait_for_function(
        "() => { const sw = document.getElementById('singleSwiper')?.swiper;"
        " return sw && sw.slides && sw.slides.length >= 1; }",
        timeout=15_000,
    )


def test_app_loads_and_album_has_images(page, e2e_server):
    """Baseline: the app boots, the album loads, and slides are served."""
    page.goto(e2e_server, wait_until="networkidle")
    _select_album(page)
    slide_count = page.evaluate("() => document.getElementById('singleSwiper').swiper.slides.length")
    assert slide_count >= 1


def test_shuffle_runs_past_high_water_mark(page, e2e_server):
    """Shuffle autoplay must keep advancing past the buffer high-water mark."""
    page.goto(e2e_server, wait_until="networkidle")
    _select_album(page)

    # Switch to shuffle, instrument advance counting, then start the show.
    page.evaluate(
        """(delay) => {
            const random = document.getElementById('modeRandom');
            random.checked = true;
            random.dispatchEvent(new Event('change', { bubbles: true }));

            const sw = document.getElementById('singleSwiper').swiper;
            window.__advances = 0;
            sw.on('slideNextTransitionStart', () => { window.__advances += 1; });

            document.getElementById('startStopSlideshowBtn').click();
            // Shrink the live autoplay delay so the test runs quickly.
            const tick = () => { sw.params.autoplay.delay = delay; };
            tick();
            setTimeout(tick, 250);
            setTimeout(tick, 1000);
        }""",
        AUTOPLAY_DELAY_MS,
    )

    try:
        page.wait_for_function(
            "(target) => (window.__advances || 0) >= target",
            arg=SHUFFLE_TARGET_ADVANCES,
            timeout=30_000,
        )
    except Exception:  # surface a useful diagnostic instead of a bare timeout
        state = page.evaluate(
            """() => {
                const sw = document.getElementById('singleSwiper').swiper;
                return {
                    advances: window.__advances || 0,
                    running: !!(sw.autoplay && sw.autoplay.running),
                    activeIndex: sw.activeIndex,
                    slides: sw.slides.length,
                };
            }"""
        )
        pytest.fail(
            "shuffle slideshow stalled before "
            f"{SHUFFLE_TARGET_ADVANCES} advances: {state} "
            "(autoplay likely stopped at the high-water-mark trim)"
        )

    running = page.evaluate(
        "() => { const sw = document.getElementById('singleSwiper').swiper;"
        " return !!(sw.autoplay && sw.autoplay.running); }"
    )
    assert running, "autoplay should still be running after crossing the high-water mark"
