# Release Notes

Welcome to PhotoMapAI, an AI-based image manager. See
[Features](https://lstein.github.io/PhotoMapAI/) for a quick
introduction,
[Installation](https://lstein.github.io/PhotoMapAI/installation) to
get PhotoMapAI installed on your home computer, and [User
Guide](https://lstein.github.io/PhotoMapAI/user-guide/basic-usage/)
for usage and configuration.

## PhotoMapAI Version 1.1.0

This is a big feature release — the highlight is a **much smoother install experience**
on Macintoshes, Windows machines and Linux boxes. In addition, since the previous
1.0.5 release there are 22 new features and dozens of fixes large and small.

### ⭐ New install experience

- **Signed, double-clickable desktop installer for macOS, Windows, and Linux**
  (#300). No need to install Python, CUDA, or anything else first — on first
  launch it downloads a private Python plus the AI libraries, starts the server,
  and opens your browser automatically. Later launches start in seconds.
- **Reliable first-run setup, everywhere.** The launcher installs its
  private Python and required libraries, avoiding interfering with
  other software installed on the machine.
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

For the full commit-level history, see the [GitHub releases
page](https://github.com/lstein/PhotoMapAI/releases).

