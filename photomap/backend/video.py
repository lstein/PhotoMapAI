"""Still-frame extraction and probing for video files.

PhotoMapAI indexes a video by CLIP-encoding one still frame taken from a
little way in, so a video behaves like a photo everywhere downstream —
search, clustering, curation.  This module owns the one job of turning a path into
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
import math
import os
import re
import shutil
import subprocess
import threading
import time
from io import BytesIO
from pathlib import Path

from PIL import Image
from pydantic import BaseModel

from .media_types import is_web_playable

logger = logging.getLogger(__name__)

# Seek this far in before grabbing the frame. The opening of real-world
# video is very often black, a fade-in, a slate, or a title card, none of
# which is a useful poster or a useful CLIP subject; several seconds in is a
# materially better frame at no extra cost, because `-ss` placed *before*
# `-i` is an input seek (jump to the preceding keyframe) rather than a decode
# of everything up to that point.
FRAME_SEEK_SECONDS = 5.0

# When the seek above lands past the end, the retry is aimed at the middle of
# the clip the banner has just reported. A fixed shallower offset would land
# on the same frame the old code took and make the extra attempt pure waste.
SHORT_FILE_SEEK_FRACTION = 0.5

# Last resorts, in order, when the duration is unknown or the aimed retry
# also comes back empty.
SHALLOW_SEEK_FALLBACKS: tuple[float | None, ...] = (1.0, None)

# Where to go when a frame *was* extracted but is empty (see `_frame_entropy`)
# — the long title sequence case, which no fixed offset can cover because it
# scales with the runtime. Fractions of the duration, which the successful
# attempt has just told us. More candidates than MAX_DEEPER_ATTEMPTS on
# purpose: the early ones are unusable on a short clip (too close to the frame
# just rejected) and get skipped.
DEEPER_SEEK_FRACTIONS: tuple[float, ...] = (0.1, 0.35, 0.6)

# Same, for the rare file whose duration the banner does not report.
DEEPER_SEEK_FALLBACK_SECONDS = 20.0

# Ceiling on those retries, and on the whole search. Each attempt costs
# another ffmpeg spawn, and this runs once per video across a collection.
MAX_DEEPER_ATTEMPTS = 2
MAX_FRAME_ATTEMPTS = 4

# A deeper attempt must move meaningfully later, and no attempt may be aimed
# at the last instant of the file: seeking there returns nothing (so the
# attempt is wasted) or the closing fade (the same problem at the other end).
MIN_DEEPER_SEEK_GAP_SECONDS = 1.0
SEEK_TAIL_MARGIN_SECONDS = 0.25

# Shannon entropy of the luma histogram, in bits, below which a frame is
# treated as empty: a black screen, a fade, a solid slate, or titles over
# black. Calibrated against a labelled corpus of synthetic-but-realistic
# frames and real encodes. Junk frames measure 0.0-0.8 bits (a pure black
# frame is 0.0, a one-line title card ~0.2, dense end credits ~0.65); real
# content starts around 1.1 even when it is almost entirely dark — a night
# skyline, fireworks against black, a snowfield, a pillarboxed phone video.
# Entropy is what separates those: a title card is two levels, black and
# white, while a dark *scene* has tone everywhere.
#
# Erring low is deliberate. A frame wrongly called empty only triggers
# another attempt, and the best-scoring frame is returned either way; a frame
# wrongly kept is the black thumbnail this whole search exists to avoid.
FRAME_ENTROPY_FLOOR = 0.75

# Per-attempt wall-clock ceiling, and also the budget for the whole file:
# once this much time has gone into one video, the search stops trying to
# improve on the frame it already has. A wedged input therefore still costs
# at most two of these (the stalled seek, then the no-seek attempt), exactly
# as it did before the search learned to look for a better frame.
FRAME_EXTRACT_TIMEOUT_SECONDS = 60.0

# Long-edge cap for the stored still. The CLIP encode uses the in-memory
# frame, so this only bounds what the cache writes to disk and what the
# browser downloads for a full-screen poster.
MAX_FRAME_EDGE = 2048

# Bumped whenever a change here would pick a different frame out of the same
# unchanged file. Both the cached stills and the grid tiles built from them
# are keyed on it, so an existing album shows the better frames without being
# re-indexed.
#
# What that costs, once, on the release that bumps it: the previous
# generation's stills are pruned at the next index write and re-extracted
# lazily, one ffmpeg run per video, as the tiles that need them are painted.
# The stored CLIP embeddings are not re-computed at all — only a re-index
# does that — so this changes what is *displayed* immediately, and search
# catches up whenever the album is next indexed.
FRAME_SELECTION_GENERATION = 2

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
        # Fixed point, not %g: a container that reports no duration makes
        # ffmpeg print Duration: 596523:14:07.99 (2^31-1 seconds), and %g
        # renders a proportional offset into that as "2.14748e+08", which
        # ffmpeg itself refuses to parse.
        args += ["-ss", f"{seek_seconds:.3f}"]
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


def _banner_duration(stderr: str) -> float | None:
    """Duration from an ffmpeg banner, including one that produced no frame.

    An attempt that seeked past the end still opened the file and printed its
    header, which is what lets the retry be aimed rather than guessed.
    """
    try:
        duration = _parse_ffmpeg_banner(stderr).get("duration")
    except Exception:
        return None
    return duration if isinstance(duration, float) else None


def _frame_entropy(frame: Image.Image) -> float:
    """Shannon entropy of ``frame``'s luma histogram, in bits.

    The frame's score as a poster and as a CLIP subject, in one number that
    costs a histogram over pixels already in memory. Zero for a frame of one
    solid colour; near zero for titles over black, because two levels carry
    almost no information however sharp the text.

    Returns infinity for a frame that cannot be measured: an unmeasurable
    frame is one we keep, never one we discard.
    """
    try:
        histogram = frame.convert("L").histogram()
        total = sum(histogram)
        if not total:
            return math.inf
        return -sum(
            (count / total) * math.log2(count / total) for count in histogram if count
        )
    except Exception:
        return math.inf


def _seek_is_inside(seek: float | None, duration: float | None) -> bool:
    """Would ``seek`` land inside ``duration``, as far as we know?

    Filters out attempts that provably return nothing — the shallow fallback
    rungs on a clip shorter than they are, for instance.
    """
    if seek is None or not duration or duration <= 0:
        return True
    return seek <= duration - SEEK_TAIL_MARGIN_SECONDS


def _next_deeper_seek(
    current: float | None, duration: float | None, tried: set[float | None]
) -> float | None:
    """The next offset to try after an empty frame, or ``None``.

    ``duration`` comes from the banner of the attempt that just ran, so a
    proportional offset is available without a separate probe.
    """
    if duration and duration > 0:
        candidates = [duration * fraction for fraction in DEEPER_SEEK_FRACTIONS]
    else:
        candidates = [DEEPER_SEEK_FALLBACK_SECONDS]

    floor = (current or 0.0) + MIN_DEEPER_SEEK_GAP_SECONDS
    for candidate in candidates:
        candidate = round(candidate, 3)
        if candidate < floor or candidate in tried:
            continue
        if not _seek_is_inside(candidate, duration):
            continue
        return candidate
    return None


def extract_video_frame(
    path: Path,
    *,
    seek_seconds: float = FRAME_SEEK_SECONDS,
    timeout: float = FRAME_EXTRACT_TIMEOUT_SECONDS,
) -> tuple[Image.Image, VideoInfo] | None:
    """Extract one still frame and probe ``path``. ``None`` if unusable.

    Never raises.  Callers treat ``None`` as "skip this file with a warning",
    matching how the indexer already handles an unreadable image.

    Attempts ``seek_seconds`` first, then walks in whichever direction the
    result calls for:

    * nothing came back at all — a clip shorter than the offset — so aim the
      retry at the middle of the duration the banner just reported, and fall
      back to the start if even that fails;
    * a frame came back but is empty (black, a fade, titles) — retry deeper,
      at a fraction of the duration, and if the whole film is dark, walk back
      towards the start rather than settle for the frame in hand.

    The highest-scoring frame seen is what is returned, so a video that
    really is all black still gets indexed rather than skipped, and a frame
    wrongly called empty is never lost to a worse one found later.

    Cost is bounded two ways: at most MAX_FRAME_ATTEMPTS ffmpeg spawns, and a
    deadline of twice ``timeout`` for the whole file — the same ceiling the
    two-attempt version had, which callers in ``video_cache`` and the
    thumbnail route rely on for their own sizing.
    """
    queue: list[float | None] = [seek_seconds if seek_seconds else None]
    shallow: list[float | None] = list(SHALLOW_SEEK_FALLBACKS) if seek_seconds else []
    deeper_attempts_left = MAX_DEEPER_ATTEMPTS if seek_seconds else 0
    tried: set[float | None] = set()
    duration: float | None = None
    best: tuple[float, Image.Image, VideoInfo] | None = None
    deadline = time.monotonic() + 2 * timeout

    while len(tried) < MAX_FRAME_ATTEMPTS:
        if queue:
            attempt_seek = queue.pop(0)
        elif shallow:
            attempt_seek = shallow.pop(0)
        else:
            break

        # Skip rungs that provably return nothing — a 1.0s fallback on a 0.2s
        # clip — rather than spending an attempt proving it.
        if attempt_seek in tried or not _seek_is_inside(attempt_seek, duration):
            continue

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        tried.add(attempt_seek)

        result = _run_ffmpeg(_frame_command(path, attempt_seek), min(timeout, remaining))
        if isinstance(result, _FfmpegUnavailable):
            break  # nothing to run — retrying cannot help
        if result is None:
            # Timed out. Seeking is precisely what stalls on a fragmented
            # file or a slow mount, so abandon the ladder and go straight to
            # the no-seek attempt: it is the cheapest one and the one most
            # likely to survive.
            queue, shallow, deeper_attempts_left = [], [None], 0
            continue

        stderr = result.stderr.decode("utf-8", errors="replace")
        if duration is None:
            duration = _banner_duration(stderr)

        if result.returncode != 0 or not result.stdout:
            # Nothing came back: the seek landed past the end of a clip
            # shorter than the offset. The banner still reported its
            # duration, so aim the retry at the middle of the file instead of
            # guessing — that beats the frame a fixed shallow offset lands on.
            if duration and not queue:
                aimed = round(duration * SHORT_FILE_SEEK_FRACTION, 3)
                if aimed not in tried and _seek_is_inside(aimed, duration):
                    queue.append(aimed)
            continue

        # Everything below can raise — PIL on an exotic pixel format, the
        # banner parser on pathological numbers — and this function's contract
        # is that it never does. An escape here is not merely this file being
        # skipped: the caller hands the frame straight to encoder.encode_images
        # and an exception takes the whole batch of unrelated photos with it.
        try:
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

        score = _frame_entropy(frame)
        if score >= FRAME_ENTROPY_FLOOR:
            return frame, info
        if best is None or score > best[0]:
            best = (score, frame, info)

        if deeper_attempts_left:
            deeper = _next_deeper_seek(attempt_seek, duration, tried)
            if deeper is not None:
                deeper_attempts_left -= 1
                queue.append(deeper)

    if best is not None:
        # Every frame we could reach was empty. The file is genuinely dark,
        # and a dark poster beats dropping it from the album.
        return best[1], best[2]

    logger.warning(f"Could not extract a frame from {path}; skipping it.")
    return None


# Wall-clock ceiling for a bare ``-i`` probe.  No decoding happens, so this is
# only ever hit by an input ffmpeg cannot open at all (a dead network mount).
PROBE_TIMEOUT_SECONDS = 30.0

# "    Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, ..."
_STREAM_AUDIO_RE = re.compile(
    r"^\s*Stream #\d+:\d+.*?: Audio:\s*(?P<codec>[A-Za-z0-9_.\-]+)"
)
# The pixel format token on a video stream line: "yuv420p", "yuvj420p",
# "yuv420p10le", "yuv444p".  Anything this does not match is reported as
# ``None``, which every caller must read as "not known to be safe" rather than
# "absent" — the transcoder's copy decision depends on it.
_PIX_FMT_RE = re.compile(r"\byuvj?\d{3}p(?:\d{1,2}(?:le|be))?\b")


class StreamProbe(BaseModel):
    """What the streams inside a container are, as far as ffmpeg reports them.

    Distinct from :class:`VideoInfo`, which describes a video *as a slide* —
    duration, frame rate, display geometry.  This describes it *as something
    to remux or re-encode*: which codecs are in there and whether the pixel
    format is one a browser's H.264 decoder will accept.

    Every field is optional for the same reason ``VideoInfo``'s are: a banner
    this does not recognize must degrade one field.  Here that degradation is
    load-bearing rather than cosmetic, so it degrades in the *conservative*
    direction — an unparsed ``video_pix_fmt`` is ``None``, and
    :func:`~photomap.backend.video_transcode.plan_for` re-encodes rather than
    copies when it cannot prove the format is safe.
    """

    duration: float | None = None
    has_video: bool = False
    video_codec: str | None = None
    video_pix_fmt: str | None = None
    has_audio: bool = False
    audio_codec: str | None = None
    #: False when something in the banner could not be attributed to ffmpeg
    #: itself, so no field here may be used to justify a stream copy.  See
    #: :func:`probe_streams` for the two ways that happens.  Callers that only
    #: want a rough description (duration for a caption, say) may ignore it;
    #: anything deciding whether a stream is safe to copy may not.
    trusted: bool = True


def probe_streams(path: Path) -> StreamProbe | None:
    """Report the streams inside ``path``.  ``None`` if ffmpeg could not run.

    Runs ffmpeg with an input and no output.  That exits non-zero — "At least
    one output file must be specified" — which is why the return code is
    ignored: the banner is printed to stderr before the complaint, and the
    banner is the entire point.  ffprobe would be the obvious tool, but
    ``imageio-ffmpeg`` ships only the ffmpeg binary.

    The banner is passed through :func:`_strip_metadata_blocks` first, for the
    reason documented there: stream and duration lines are ffmpeg's own
    report, while the ``Metadata:`` blocks above them are attacker-controlled
    file tags that would otherwise be able to spoof a codec.

    Stripping those blocks is necessary but **not sufficient**, because two
    pieces of file-controlled text are printed outside them, on ffmpeg's own
    report lines:

    * A stream's *language tag* is printed inline as ``(%s)`` in its own
      ``Stream #`` line, before the ``: Video:``/``: Audio:`` delimiter. A tag
      of ``x): Video: h264 (High), yuv420p`` makes an **audio** stream's line
      match the video pattern — and it degrades toward *copy*, which is the
      dangerous direction: a copied HEVC stream is exactly the black rectangle
      the converter exists to remove. Detected structurally: ffmpeg prints one
      kind delimiter per stream line, so a line carrying more than one is not
      a line ffmpeg composed alone.
    * The input **path** is echoed in the ``Input #0, ..., from '...':``
      header, and a filename may contain a newline on Linux and macOS — which
      splits it into further lines that look exactly like report lines. There
      is no way to tell those apart after the fact, so a path containing one
      poisons the whole banner.

    Neither is recoverable by parsing harder, so both set ``trusted=False``
    rather than trying to pick the real line out. The fields are still
    populated on a best-effort basis for descriptive use; what changes is that
    :func:`~photomap.backend.video_transcode.plan_for` will not copy a stream
    on their say-so.
    """
    result = _run_ffmpeg(
        ["-nostdin", "-hide_banner", "-i", str(path)], PROBE_TIMEOUT_SECONDS
    )
    if result is None or isinstance(result, _FfmpegUnavailable):
        return None

    report = _strip_metadata_blocks(result.stderr.decode("utf-8", errors="replace"))
    probe = StreamProbe()

    # The banner echoes the input path, so a newline in the filename can forge
    # whole report lines. Checked on the path rather than on the banner: by the
    # time it is text there is nothing left to distinguish the forgery.
    if "\n" in str(path) or "\r" in str(path):
        probe.trusted = False

    if m := _DURATION_RE.search(report):
        try:
            probe.duration = (
                int(m.group("h")) * 3600 + int(m.group("m")) * 60 + float(m.group("s"))
            )
        except (ValueError, OverflowError):
            pass

    for line in report.splitlines():
        if not line.lstrip().startswith("Stream #"):
            continue
        # ffmpeg emits exactly one kind delimiter per stream line. More than
        # one means part of the line came from the file, not from ffmpeg.
        if line.count(": Video:") + line.count(": Audio:") > 1:
            probe.trusted = False
        if not probe.has_video:
            m = _STREAM_VIDEO_RE.match(line)
            # Cover art embedded in an audio file presents as a video stream;
            # transcoding it would produce a one-frame "video".
            if m and _ATTACHED_PIC not in line.lower():
                probe.has_video = True
                probe.video_codec = m.group("codec")
                if pm := _PIX_FMT_RE.search(line):
                    probe.video_pix_fmt = pm.group(0)
                continue
        if not probe.has_audio:
            if m := _STREAM_AUDIO_RE.match(line):
                probe.has_audio = True
                probe.audio_codec = m.group("codec")

    return probe
