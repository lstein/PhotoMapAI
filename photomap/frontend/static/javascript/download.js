/**
 * Saving a single album item to disk.
 *
 * Extracted from bookmarks.js so the control panel and the bookmark menu
 * share one implementation rather than growing two that drift — the video
 * handling below in particular is easy to get wrong in a way that only shows
 * up on large files.
 */

import { state } from "./state.js";
import { fetchJson } from "./utils.js";

/**
 * Download the album item at `globalIndex` under its own filename.
 *
 * Videos are saved as the **original** file, never a converted copy. The
 * conversion exists so the browser can play a container it cannot decode; it
 * is a lossy re-encode in the general case, and it is not what is in the
 * user's library. `video_url` is the source bytes — see `create_slide_url`.
 */
export async function downloadItem(globalIndex) {
  const data = await fetchJson(`retrieve_image/${encodeURIComponent(state.album)}/${globalIndex}`);
  const isVideo = data.media_type === "video";
  // For a video, download the playable file rather than its still frame.
  const itemUrl = isVideo && data.video_url ? data.video_url : data.image_url;
  // Derive the fallback extension from the real path — a hardcoded .jpg would
  // save a video under a name no player would open.
  const fallbackExtension = data.filepath?.split(".").pop() || (isVideo ? "mp4" : "jpg");
  const filename = data.filename || `image_${globalIndex}.${fallbackExtension}`;

  if (isVideo) {
    // Videos are far too large to buffer into a blob: a 200 MB clip would sit
    // entirely in browser memory before the save dialog appeared. Point the
    // download straight at the URL and let the browser stream it.
    triggerSave(itemUrl, filename);
    return;
  }

  // Photos go through a blob so the object URL can carry the chosen filename.
  const response = await fetch(itemUrl);
  if (!response.ok) {
    throw new Error("Failed to fetch image");
  }
  const url = URL.createObjectURL(await response.blob());
  triggerSave(url, filename);
  URL.revokeObjectURL(url);
}

/** Synthesise the anchor a save needs, click it, and clean up. */
export function triggerSave(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
