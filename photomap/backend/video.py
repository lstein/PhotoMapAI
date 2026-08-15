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

import functools
import logging
import re
import subprocess
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
_CONTAINER_RE = re.compile(r"^Input #0, (?P<container>[^,]+(?:,[^,]+)*), from ", re.MULTILINE)
# "  Duration: 00:00:05.00, start: 0.000000, bitrate: 551 kb/s"
_DURATION_RE = re.compile(r"Duration:\s*(?P<h>\d+):(?P<m>\d{2}):(?P<s>\d{2}(?:\.\d+)?)")
# "    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x61766331), ..., 30 fps, ..."
_CODEC_RE = re.compile(r"Stream #\d+:\d+.*?: Video:\s*(?P<codec>[A-Za-z0-9_.\-]+)")
_FPS_RE = re.compile(r"(?P<fps>\d+(?:\.\d+)?)\s+fps\b")


@functools.lru_cache(maxsize=1)
def ffmpeg_exe() -> str | None:
    """Path to the bundled ffmpeg binary, or ``None`` if unavailable.

    ``imageio-ffmpeg``'s *sdist* ships no binary, so on platforms without a
    wheel (musl/Alpine, linux armv7, win_arm64) the install succeeds and
    ``get_ffmpeg_exe()`` only fails at runtime — inside a worker thread, once
    per video file.  Probing once and caching the answer turns that into a
    single warning and a clean skip of all videos, leaving image indexing
    exactly as it was.
    """
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        logger.warning(
            f"No usable ffmpeg binary found ({e}); video files will be skipped during indexing."
        )
        return None


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
    """
    info: dict[str, object] = {}

    if m := _CONTAINER_RE.search(stderr):
        info["container"] = m.group("container").strip()

    if m := _DURATION_RE.search(stderr):
        info["duration"] = (
            int(m.group("h")) * 3600 + int(m.group("m")) * 60 + float(m.group("s"))
        )

    if m := _CODEC_RE.search(stderr):
        info["codec"] = m.group("codec")
        # Look for the frame rate only within the video stream line, so an
        # audio stream's numbers can't be mistaken for it.
        line_end = stderr.find("\n", m.start())
        stream_line = stderr[m.start() : line_end if line_end != -1 else len(stderr)]
        if fm := _FPS_RE.search(stream_line):
            info["fps"] = float(fm.group("fps"))

    return info


def _run_ffmpeg(args: list[str], timeout: float) -> subprocess.CompletedProcess[bytes] | None:
    """Run ffmpeg, returning ``None`` if it fails, times out, or is missing.

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
        return None

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
        if result is None:
            return None  # missing binary or timeout — no point retrying
        if result.returncode != 0 or not result.stdout:
            continue

        stderr = result.stderr.decode("utf-8", errors="replace")
        try:
            frame = Image.open(BytesIO(result.stdout))
            frame.load()
        except Exception as e:
            logger.warning(f"ffmpeg produced an undecodable frame for {path}: {e}")
            continue

        # Normalize hard. Downstream this frame is handed straight to
        # encoder.encode_images(), and a batch that raises there takes all of
        # its batch-mates down with it.
        frame = frame.convert("RGB")
        if max(frame.size) > MAX_FRAME_EDGE:
            frame.thumbnail((MAX_FRAME_EDGE, MAX_FRAME_EDGE))

        parsed = _parse_ffmpeg_banner(stderr)
        info = VideoInfo(
            duration=parsed.get("duration"),
            fps=parsed.get("fps"),
            # From the decoded frame, never the banner — see
            # _parse_ffmpeg_banner's docstring.
            width=frame.width,
            height=frame.height,
            codec=parsed.get("codec"),
            container=parsed.get("container"),
            playable=is_web_playable(path),
        )
        return frame, info

    logger.warning(f"Could not extract a frame from {path}; skipping it.")
    return None
