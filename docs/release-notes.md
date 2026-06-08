# Release Notes

Notable changes to PhotoMapAI, newest first. For the full commit-level history,
see the [GitHub releases page](https://github.com/lstein/PhotoMapAI/releases).

## 1.1.0

This is a big feature release — the highlight is a **brand-new, signed desktop
installer** that removes the old "install Python and CUDA first" friction. Since
1.0.5 there are 22 new features and dozens of fixes, with no breaking changes.

### ⭐ New install experience

- **Signed, double-clickable desktop installer for macOS, Windows, and Linux**
  (#300). No need to install Python, CUDA, or anything else first — on first
  launch it downloads a private Python plus the AI libraries, starts the server,
  and opens your browser automatically. Later launches start in seconds.
    - Code-signed on macOS and Windows, so no more Gatekeeper/quarantine dances.
    - Custom app icons across all three platforms (#304).
    - Advanced `--pkg-version` flag to install a specific release (#310).
- **GPU "just works":** an NVIDIA GPU is detected and used automatically. You no
  longer need to install the CUDA Toolkit — only a recent NVIDIA driver. Apple
  Silicon acceleration is automatic too.
- **Python 3.14 support** (#258).

### 🗺️ Semantic map (UMAP)

- **Automatic cluster labeling** — clusters are now named by content (#234).
- **Per-image tags in the hover popup** (#262).
- **Album switcher** built into the semantic-map titlebar (#287).
- **Smooth zoom everywhere:** custom scroll-wheel and pinch-to-zoom that work
  across all browsers, including Safari and iOS touch (#312).

### 🔎 Search & discovery

- **In-app Back button + browser back/forward** for navigating your slide
  history (#241).
- **Encoder model download progress** is now surfaced in the album UI during
  indexing (#308).
- **Platform-aware default encoder** for new albums (#307).
- Broader **auto-tagging vocabulary**, with an opt-out toggle (#251).
- Search and other server errors now appear as **toast notifications** instead of
  failing silently (#278, #288).

### 🖼️ Slideshow

- Smarter end-of-show behavior: sequential mode stops cleanly on the last slide
  (with the play button grayed out), while shuffle mode reshuffles endlessly
  (#293, #296).
- Shuffle autoplay stays alive through long runs and buffer rebuilds (#297, #313).

### 🎯 Curation

- **Grid view** plus an automatic UMAP on completion, and a **~200× speedup** in
  BLOCKS curation (#281).

### 🏷️ Metadata

- EXIF drawer now shows **DateTimeOriginal, Orientation, and image dimensions**
  (#279).
- **Clickable reference-image thumbnails** in the metadata drawer (#238).
- Better handling of InvokeAI v5 metadata and assorted format edge cases (#267,
  #268).

### ⚙️ Preferences & quality of life

- **Per-device, server-side UI preferences** — your layout choices persist per
  device (#284).
- **Move to Trash / Recycle Bin** option for image deletion, instead of permanent
  removal (#273).
- An **update badge** on the About button when a newer version is available
  (#280).
- Cached reverse-geocoding for faster GPS location lookups (#272).

### 🔒 Notable fixes

- Closed **XSS, path-traversal, and partial-write** security risks (#242).
- Resolved indexing/concurrency race conditions and VRAM-release issues (#243,
  #271).
- Numerous UI leak and stability fixes across the slideshow, curation, and grid
  views.

Plus internal refactors, CI repairs, and frontend cleanups under the hood.

!!! note "Upgrading from the `1.0.6rc1` prerelease"
    The `1.0.6rc1` prerelease line is superseded — please move to `1.1.0`.
