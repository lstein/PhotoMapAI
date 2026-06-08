# End-to-end (real browser) smoke tests

These tests launch the **actual** PhotoMapAI server and drive it with a headless
Chromium via [Playwright](https://playwright.dev/python/). They exist to catch
integration regressions the jsdom unit tests **cannot** — anything in the real
interaction between our code and Swiper.js (autoplay, slide buffering,
transitions).

The motivating bug: shuffle slideshow froze after ~19 slides because trimming
the slide buffer at the high-water mark stopped Swiper's autoplay. The unit
tests mock Swiper, so they were blind to it; it only reproduced in a real
browser. `test_shuffle_runs_past_high_water_mark` is the regression guard.

## Running

E2E tests are **opt-in** — they're skipped unless `RUN_E2E=1` is set, so the
default `pytest tests` stays fast and browser-free.

```bash
# one-time setup
pip install -e ".[testing,e2e]"
playwright install chromium        # browser binary (cached under ~/.cache/ms-playwright)

# run them
RUN_E2E=1 pytest tests/e2e -m e2e
```

Without `RUN_E2E=1` they report as skipped:

```bash
pytest tests/e2e          # -> 2 skipped
```

## How the fixture works

No CLIP model or network is required. `conftest.py`:

1. Builds a throwaway **fake `.npz` index** at runtime pointing at the committed
   images in `tests/backend/test_images/` (random embedding vectors — the
   slideshow path never loads the encoder, so only the on-disk filenames and the
   image count matter). The real index stores **absolute** paths, so it can't be
   committed as a portable fixture; building at runtime sidesteps that.
2. Writes a one-album `config.yaml` and launches `start_photomap` on a free port
   with `--no-browser --once`.
3. Provides Playwright `browser`/`page` fixtures.

## Adding a test

Mark it `@pytest.mark.e2e` (module-level `pytestmark = pytest.mark.e2e` is fine),
take the `page` and `e2e_server` fixtures, and drive the UI. The native
`#albumSelect` is hidden behind a custom dropdown, so set its value and dispatch
a `change` event via `page.evaluate` rather than clicking. Reach the live Swiper
instance with `document.getElementById('singleSwiper').swiper`.
