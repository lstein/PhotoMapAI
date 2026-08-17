"""Still-frame extraction and probing for video files.

PhotoMapAI indexes a video by CLIP-encoding one still frame taken near its
start, so a video behaves like a photo everywhere downstream — search,
clustering, curation.  This module owns the one job of turning a path into
``(PIL frame, VideoInfo)``, and returning ``None`` rather than raising when
anything at all goes wrong.

Why the ffmpeg binary is driven directly instead of through
``imageio_ffmpeg.read_frames``: ``read_frames`` is a generator that owns a
``Popen`` it never exposes, leaving no portable way to kill a wedged ffmpeg.
A single unreadable file on a network mount would then hang indexing forever,
uncancellably.  ``subprocess.run(timeout=...)`` is the one construct that
hard-kills a child on every platform, so that is what is used.

``imageio_ffmpeg.count_frames_and_secs`` is likewise avoided: it decodes the
entire file to count frames, which is catastrophic on a multi-gigabyte video.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
from io import BytesIO
from pathlib import Path

from PIL import Image
from pydantic import BaseModel

from .media_types import is_web_playable

logger = logging.getLogger(__name__)

# Seek this far in before grabbing the frame. Frame 0 of consumer video is
# very often black, a fade-in, or a slate; one second in is a materially
# better subject for CLIP at no extra cost, because `-ss` placed *before*
# `-i` is an input seek (jump to the preceding keyframe) rather than a decode
# of everything up to that point.
FRAME_SEEK_SECONDS = 1.0

# Per-attempt wall-clock ceiling. Two attempts max, so the worst case for one
# pathological file is 2x this.
FRAME_EXTRACT_TIMEOUT_SECONDS = 60.0

# Long-edge cap for the stored still. The CLIP encode uses the in-memory
# frame, so this only bounds what the cache writes to disk and what the
# browser downloads for a full-screen poster.
MAX_FRAME_EDGE = 2048

# Reserved key under which VideoInfo rides inside the existing per-image
# metadata dict. Using the metadata dict rather than a new .npz column means
# every rewrite path (delete, batch delete, path update) carries video info
# for free, and indexes predating video support need no migration.
VIDEO_METADATA_KEY = "photomap_video"


class VideoInfo(BaseModel):
    """Facts about a video, as far as they could be determined.

    Every field except ``playable`` is optional: a banner-parse miss must
    degrade one field, never fail the extraction, because the *frame* is what
    indexing actually needs.
    """

    duration: float | None = None
    fps: float | None = None
    width: int | None = None
    height: int | None = None
    codec: str | None = None
    container: str | None = None
    playable: bool = False


# "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/path/clip.mp4':"
#
# The container group is non-greedy so it stops at the *first* ", from " —
# the delimiter. Greedy matching backtracks to the last one instead, which a
# file stored under a path like "/photos/Trip, from Rome/" turns into the
# user's absolute filesystem path being spliced into the container field and
# shown in the metadata drawer.
_CONTAINER_RE = re.compile(r"^Input #\d+, (?P<container>.+?), from ", re.MULTILINE)
# "  Duration: 00:00:05.00, start: 0.000000, bitrate: 551 kb/s"
_DURATION_RE = re.compile(r"Duration:\s*(?P<h>\d+):(?P<m>\d{2}):(?P<s>\d{2}(?:\.\d+)?)")
# "    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x61766331), ..., 30 fps, ..."
_STREAM_VIDEO_RE = re.compile(r"^\s*Stream #\d+:\d+.*?: Video:\s*(?P<codec>[A-Za-z0-9_.\-]+)")
_FPS_RE = re.compile(r"(?P<fps>\d+(?:\.\d+)?)\s+fps\b")
# Cover art embedded in an audio file is reported as a video stream marked
# "(attached pic)". See _has_decodable_video_stream.
_ATTACHED_PIC = "attached pic"


def _strip_metadata_blocks(stderr: str) -> str:
    """Drop ffmpeg's ``Metadata:`` blocks, keeping only its own report lines.

    ffmpeg prints the file's own tags *before* the ``Duration:`` and
    ``Stream #`` lines it generates itself, and the tag values are whatever
    the file says — i.e. attacker- or importer-controlled for any downloaded
    video. Searching the raw text lets a tag hijack every field: verified
    with the bundled ffmpeg, a clip tagged ``comment="Duration: 12:34:56.00"``
    parses as 45296 seconds instead of 2, and a ``Stream #0:0: Video: fake``
    tag overrides codec and fps.

    Blocks are located structurally by indentation rather than by pattern, so
    a tag value containing embedded newlines cannot fake a report line either.
    """
    kept: list[str] = []
    metadata_indent: int | None = None
    for line in stderr.splitlines():
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if metadata_indent is not None:
            if indent > metadata_indent:
                continue  # still inside the tag block
            metadata_indent = None
        if stripped == "Metadata:":
            metadata_indent = indent
            continue
        kept.append(line)
    return "\n".join(kept)


def _has_decodable_video_stream(report: str) -> bool:
    """True if the input carries a real video stream, not just cover art.

    An audio file with embedded album art (routine for ``.ogg``, which is far
    more often Vorbis/Opus audio than Ogg video) presents that art to ffmpeg
    as a video stream tagged ``(attached pic)``. Extracting it succeeds, so
    without this check the album cover would be CLIP-embedded and shown as a
    phantom video slide, complete with a play badge.
    """
    for line in report.splitlines():
        match = _STREAM_VIDEO_RE.match(line)
        if match and _ATTACHED_PIC not in line.lower():
            return True
    return False


_ffmpeg_exe_cache: str | None = None
_ffmpeg_exe_probed = False
_ffmpeg_exe_lock = threading.Lock()


def ffmpeg_exe() -> str | None:
    """A runnable ffmpeg, or ``None`` if this platform has none.

    ``imageio-ffmpeg``'s *sdist* ships no binary, so on platforms without a
    wheel (musl/Alpine, linux armv7, win_arm64) the install succeeds and only
    fails at runtime — inside a worker thread, once per video file. Probing
    once turns that into a single warning and a clean skip of all videos,
    leaving image indexing exactly as it was.

    Two things this deliberately does *not* do with ``lru_cache``:

    * A **negative** result is not cached. ``get_ffmpeg_exe()`` validates its
      candidates by spawning ``ffmpeg -version``, so a transient fork failure
      under memory pressure or an AV scanner holding the file would otherwise
      disable video for the entire process lifetime.
    * A **positive** result is validated before being kept. ``get_ffmpeg_exe``
      returns ``$IMAGEIO_FFMPEG_EXE`` unchecked and can fall back to the bare
      name ``"ffmpeg"`` for a PATH lookup, so a non-``None`` answer is not on
      its own evidence that anything is executable.
    """
    global _ffmpeg_exe_cache, _ffmpeg_exe_probed

    if _ffmpeg_exe_probed:
        return _ffmpeg_exe_cache

    with _ffmpeg_exe_lock:
        if _ffmpeg_exe_probed:
            return _ffmpeg_exe_cache
        try:
            import imageio_ffmpeg

            candidate = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception as e:
            logger.warning(
                f"No usable ffmpeg binary found ({e}); video files will be skipped."
            )
            return None  # not memoized — the next call retries

        resolved = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if not resolved or not Path(resolved).exists():
            logger.warning(
                f"ffmpeg reported as {candidate!r} but is not executable; "
                "video files will be skipped."
            )
            return None

        _ffmpeg_exe_cache = resolved
        _ffmpeg_exe_probed = True
        return _ffmpeg_exe_cache


def _reset_ffmpeg_exe_cache() -> None:
    """Test seam: forget the probed binary so the next call re-resolves."""
    global _ffmpeg_exe_cache, _ffmpeg_exe_probed
    with _ffmpeg_exe_lock:
        _ffmpeg_exe_cache = None
        _ffmpeg_exe_probed = False


def _parse_ffmpeg_banner(stderr: str) -> dict[str, object]:
    """Pull duration/fps/codec/container out of ffmpeg's stderr banner.

    Each field is matched independently and is individually optional, so a
    format whose banner differs only loses that one field.

    Deliberately does **not** parse width/height.  ffmpeg autorotates on
    decode, so a portrait phone video's banner reports the *pre-rotation*
    dimensions (e.g. 1920x1080) while the decoded frame is 1080x1920.
    Dimensions therefore come only from the decoded frame, and there is no
    code path here that could reintroduce the banner's answer.

    All values are plain Python scalars: ``/get_metadata`` runs ``json.dumps``
    over the per-image metadata dict, and numpy scalars raise there.

    Never raises: a field that cannot be parsed is simply absent, because the
    *frame* is what indexing actually needs.
    """
    info: dict[str, object] = {}
    report = _strip_metadata_blocks(stderr)

    if m := _CONTAINER_RE.search(report):
        info["container"] = m.group("container").strip()

    if m := _DURATION_RE.search(report):
        try:
            info["duration"] = (
                int(m.group("h")) * 3600 + int(m.group("m")) * 60 + float(m.group("s"))
            )
        except (ValueError, OverflowError):
            # A pathological hour field (enough digits to overflow the float
            # conversion) must cost this one field, not the whole extraction.
            pass

    for line in report.splitlines():
        m = _STREAM_VIDEO_RE.match(line)
        if not m or _ATTACHED_PIC in line.lower():
            continue
        info["codec"] = m.group("codec")
        # Frame rate is read from this stream's own line, so an audio
        # stream's sample rate can't be mistaken for it.
        if fm := _FPS_RE.search(line):
            try:
                info["fps"] = float(fm.group("fps"))
            except ValueError:
                pass
        break

    return info


class _FfmpegUnavailable:
    """Sentinel: no ffmpeg to run, so retrying this input is pointless."""


FFMPEG_UNAVAILABLE = _FfmpegUnavailable()


def _run_ffmpeg(
    args: list[str], timeout: float
) -> subprocess.CompletedProcess[bytes] | _FfmpegUnavailable | None:
    """Run ffmpeg. ``None`` means this attempt failed; the sentinel means no
    attempt is possible at all.

    The distinction matters: a timeout returns ``None`` so the caller can fall
    back to its cheaper no-seek attempt, since an input seek is precisely the
    operation that stalls on a fragmented file or a slow mount. Collapsing
    both into one value made the fallback unreachable exactly when it was most
    likely to help.

    Uses ``subprocess.run`` rather than ``Popen`` + ``wait(timeout=...)``.
    That is not a style preference: a PNG frame is megabytes and the OS pipe
    buffer is ~64 KB, so ffmpeg blocks writing while the parent blocks
    waiting, and the pair deadlocks *before* the timeout can ever fire.
    ``run`` goes through ``communicate()``, which drains both pipes
    concurrently and kills the child on timeout on every platform.
    (``signal.alarm`` is not an option: absent on Windows, and unusable off
    the main thread anyway.)
    """
    exe = ffmpeg_exe()
    if exe is None:
        return FFMPEG_UNAVAILABLE

    kwargs = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):  # Windows only
        # Without this the packaged launcher flashes a console window for
        # every video it indexes.
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        return subprocess.run(
            [exe, *args],
            capture_output=True,
            # Both -nostdin and DEVNULL: otherwise ffmpeg consumes the
            # parent's stdin and mangles the terminal for `index_images` CLI
            # users.
            stdin=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            **kwargs,
        )
    except subprocess.TimeoutExpired:
        logger.warning(f"ffmpeg timed out after {timeout}s: {' '.join(args[:6])}...")
        return None
    except MemoryError:
        # A 4K/8K frame arrives as one PNG blob in memory; on a constrained
        # box that can fail outright. Treat it as this attempt failing rather
        # than letting it escape into the indexing worker.
        logger.warning(f"Ran out of memory decoding a frame: {' '.join(args[:6])}...")
        return None
    except OSError as e:
        logger.warning(f"Could not run ffmpeg: {e}")
        return None


def _frame_command(path: Path, seek_seconds: float | None) -> list[str]:
    args = ["-nostdin", "-hide_banner"]
    if seek_seconds is not None:
        # -ss BEFORE -i is an input seek: ffmpeg jumps to the nearest
        # preceding keyframe and decodes forward, so this is O(1) rather than
        # a decode of the whole file. Accurate by default since ffmpeg 2.1.
        args += ["-ss", f"{seek_seconds:g}"]
    args += [
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-an",  # drop audio
        "-sn",  # drop subtitles
        "-dn",  # drop data streams
        # Correct non-square pixels. ffmpeg autorotates on decode but does not
        # apply the sample aspect ratio, so anamorphic sources — DVD rips,
        # .vob, .mpg, AVCHD .m2ts, all of which this module accepts — would
        # otherwise extract geometrically squashed: a 720x480 SAR 32:27 clip
        # comes out at aspect 1.50 instead of 1.778. That distorted still is
        # both what CLIP embeds (degrading search across that whole class of
        # file) and what is cached as the poster.
        #
        # Note the expression contains no commas: inside a filtergraph a comma
        # separates filters, so anything needing one would have to be escaped
        # as "\," — a well-known footgun this deliberately avoids.
        "-vf",
        "scale=iw*sar:ih",
        "-c:v",
        "png",
        "-f",
        "image2pipe",
        "-",
    ]
    return args


def extract_video_frame(
    path: Path,
    *,
    seek_seconds: float = FRAME_SEEK_SECONDS,
    timeout: float = FRAME_EXTRACT_TIMEOUT_SECONDS,
) -> tuple[Image.Image, VideoInfo] | None:
    """Extract one still frame and probe ``path``. ``None`` if unusable.

    Never raises.  Callers treat ``None`` as "skip this file with a warning",
    matching how the indexer already handles an unreadable image.

    Two attempts at most: seek to ``seek_seconds``, and if that yields nothing
    (a video shorter than the seek, a single-frame video, a broken index),
    retry from the start.
    """
    attempts: list[float | None] = [seek_seconds, None] if seek_seconds else [None]

    for attempt_seek in attempts:
        result = _run_ffmpeg(_frame_command(path, attempt_seek), timeout)
        if isinstance(result, _FfmpegUnavailable):
            return None  # nothing to run — retrying cannot help
        if result is None:
            # Timed out. Fall through to the no-seek attempt, which is the
            # cheaper of the two and the one most likely to survive whatever
            # made the seek stall.
            continue
        if result.returncode != 0 or not result.stdout:
            continue

        # Everything below can raise — PIL on an exotic pixel format, the
        # banner parser on pathological numbers — and this function's contract
        # is that it never does. An escape here is not merely this file being
        # skipped: the caller hands the frame straight to encoder.encode_images
        # and an exception takes the whole batch of unrelated photos with it.
        try:
            stderr = result.stderr.decode("utf-8", errors="replace")

            if not _has_decodable_video_stream(_strip_metadata_blocks(stderr)):
                # Cover art in an audio file, presented as an "(attached pic)"
                # video stream. Extraction would have succeeded, and the album
                # art would have become a phantom video slide.
                logger.info(f"{path.name} carries no video stream; skipping it.")
                return None

            frame = Image.open(BytesIO(result.stdout))
            frame.load()

            # Normalize hard. Downstream this frame is handed straight to
            # encoder.encode_images(), and a batch that raises there takes all
            # of its batch-mates down with it.
            frame = frame.convert("RGB")

            # Captured *before* the downscale below: thumbnail() resizes in
            # place, so reading frame.width afterwards would record the
            # thumbnail's size as the video's resolution and label every 4K
            # video 2048-wide.
            source_width, source_height = frame.size

            if max(frame.size) > MAX_FRAME_EDGE:
                frame.thumbnail((MAX_FRAME_EDGE, MAX_FRAME_EDGE))

            parsed = _parse_ffmpeg_banner(stderr)
        except Exception as e:
            logger.warning(f"Could not decode a frame from {path}: {e}")
            continue

        info = VideoInfo(
            duration=parsed.get("duration"),
            fps=parsed.get("fps"),
            # The decoded frame's own dimensions, never the banner's: ffmpeg
            # autorotates on decode and the scale filter corrects non-square
            # pixels, so only the pixels know the true display geometry.
            width=source_width,
            height=source_height,
            codec=parsed.get("codec"),
            container=parsed.get("container"),
            playable=is_web_playable(path),
        )
        return frame, info

    logger.warning(f"Could not extract a frame from {path}; skipping it.")
    return None
