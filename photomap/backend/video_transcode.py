"""On-demand conversion of videos the browser refuses to play.

A typical personal video collection is mostly *not* web-playable: DivX/XviD
``.avi``, MPEG-2 ``.vob`` and ``.mpg`` off DVDs, ``.wmv``, HEVC and 10-bit
H.264 in ``.mkv``.  ``<video>`` shows a black rectangle for all of them.  This
module turns any of them into one H.264/AAC MP4 in the per-user cache
directory, which the existing ``FileResponse`` path then serves with Range
support — so the result is fully seekable and instant on every replay.

**Remux before re-encode.**  Most of that collection is not actually encoded
wrongly, it is *packaged* wrongly: an ``.mkv`` or ``.avi`` holding H.264 video
and AAC audio needs its streams copied into an MP4 container and nothing
more.  That is I/O-bound and finishes in seconds on a file a real re-encode
would spend minutes on, so the two cases are decided per stream —
:func:`plan_for` can copy the video and re-encode only the audio, or the
reverse.

**Why a cache file and not a pipe.**  Piping ffmpeg's stdout into a
``StreamingResponse`` starts faster but has no Range support, so the scrubber
cannot seek and the duration is unknown; and every replay pays for the
conversion again.  Writing the file first costs a wait on the first play,
which is what the player's progress readout is for.

**Abandonment.**  Conversions run one at a time on a single worker thread, so
a user opening several unplayable clips in a row would otherwise queue every
one of them and watch the last sit behind minutes of work they no longer
want.  A job is therefore only kept alive while a client is asking about it:
:func:`request_transcode` doubles as the poll, and a job nobody has polled for
``ABANDON_AFTER_SECONDS`` is killed and its partial output discarded.  Closing
the player is what abandonment looks like from here.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Literal

from platformdirs import user_cache_dir
from pydantic import BaseModel

from .video import StreamProbe, ffmpeg_exe, probe_streams
from .video_cache import VideoFrameCache, album_dirname

logger = logging.getLogger(__name__)

# Name of the cache directory under the per-user cache root.  Deliberately a
# sibling of ``video_frames`` rather than a subdirectory of it: the frame
# cache's sweeper deletes everything in its own tree that is not a current
# ``.jpg``, and a converted movie is neither.
TRANSCODE_CACHE_DIRNAME = "video_transcodes"

# Total size the converted-video cache is allowed to reach before the oldest
# entries are reclaimed.  Videos are orders of magnitude larger than the
# stills next door, so this cache is bounded by bytes rather than swept
# against the index the way ``VideoFrameCache.prune`` is.
MAX_TRANSCODE_CACHE_BYTES = 8 * 1024**3

# Streams that can be copied into an MP4 rather than re-encoded.
#
# H.264 only, and only in 8-bit 4:2:0.  Every browser decodes that; 10-bit
# (``yuv420p10le``, routine in modern ``.mkv`` rips) and 4:2:2/4:4:4 are
# rejected by the very decoders this exists to satisfy, so a copy would
# produce a valid MP4 that still shows a black rectangle.  HEVC is absent for
# the same reason it is absent from ``WEB_PLAYABLE_EXTENSIONS``: Safari plays
# it and nothing else does.
COPYABLE_VIDEO_CODECS: frozenset[str] = frozenset({"h264"})
COPYABLE_VIDEO_PIX_FMTS: frozenset[str] = frozenset({"yuv420p", "yuvj420p"})
# AAC only. MP4 can legally carry MP3 and current browsers do decode it, but
# it is the one audio path with a history of silence rather than an error in
# Safari — and the failure this whole module exists to remove is exactly "the
# file loads and plays nothing". Re-encoding audio runs at a hundred times
# realtime, so copying it saves seconds on a job whose cost is the video.
COPYABLE_AUDIO_CODECS: frozenset[str] = frozenset({"aac"})

# x264 settings.  ``veryfast``/CRF 23 is the point where a wait the user is
# watching a progress bar through stops being the dominant cost; slower
# presets buy file size this cache does not care about.
X264_PRESET = "veryfast"
X264_CRF = "23"
AAC_BITRATE = "160k"

# No progress line for this long means ffmpeg is wedged — a truncated file, a
# stalled network mount — rather than merely slow.  ffmpeg emits a progress
# block roughly twice a second whenever it is making any headway at all.
STALL_TIMEOUT_SECONDS = 180.0

# Absolute ceilings, scaled off the source duration: a two-hour movie
# legitimately takes far longer than a ten-second clip, and neither should run
# forever.
JOB_TIMEOUT_PER_SECOND = 20.0
MIN_JOB_TIMEOUT_SECONDS = 600.0
MAX_JOB_TIMEOUT_SECONDS = 6 * 3600.0

# How often the watchdog samples the stall / deadline / abandonment clocks.
WATCHDOG_INTERVAL_SECONDS = 2.0

# A job nobody has asked about for this long is dropped.  The player polls
# about once a second while its progress panel is up, so this is only reached
# by a client that has genuinely gone away.
ABANDON_AFTER_SECONDS = 45.0

# How long a failure is remembered.  Without this a permanently unconvertible
# file re-runs ffmpeg on every poll — several times a second.  It expires
# because failure is also transient (a full disk, a mount that came back), and
# a permanent record would mean one unlucky moment disables a video for the
# life of the process.  Mirrors ``video_cache``'s failure memory.
FAILURE_MEMORY_SECONDS = 300.0

TranscodeState = Literal["queued", "running", "ready", "failed", "unavailable"]


class TranscodePlan(BaseModel):
    """How a particular file has to be converted.

    ``copy_video``/``copy_audio`` are per-stream because the common cases are
    mixed: an ``.mkv`` of H.264 video with AC-3 audio needs the video copied
    and only the audio re-encoded, which is nearly as cheap as a pure remux.
    """

    copy_video: bool
    has_audio: bool
    copy_audio: bool
    duration: float | None = None

    @property
    def is_remux(self) -> bool:
        """True when no stream is being re-encoded — seconds, not minutes."""
        return self.copy_video and (not self.has_audio or self.copy_audio)


class TranscodeStatus(BaseModel):
    """What to tell a client asking about a conversion.

    ``url`` is deliberately absent: this module knows nothing about routes.
    The router fills it in when ``state`` is ``"ready"``.
    """

    state: TranscodeState
    progress: float = 0.0
    detail: str | None = None
    url: str | None = None


def plan_for(probe: StreamProbe | None) -> TranscodePlan:
    """Decide what has to be re-encoded, from what the probe could determine.

    Every unknown resolves to "re-encode".  A probe that returned ``None``, a
    codec line the banner parser did not match, an unrecognized pixel format —
    all of them mean *we cannot prove a copy would play*, and the cost of
    guessing wrong is the exact black rectangle this module exists to remove.
    Re-encoding when a copy would have done merely wastes time once, and the
    result is cached.
    """
    if probe is None:
        return TranscodePlan(copy_video=False, has_audio=True, copy_audio=False)

    copy_video = (
        (probe.video_codec or "").lower() in COPYABLE_VIDEO_CODECS
        and (probe.video_pix_fmt or "").lower() in COPYABLE_VIDEO_PIX_FMTS
    )
    copy_audio = (probe.audio_codec or "").lower() in COPYABLE_AUDIO_CODECS
    return TranscodePlan(
        copy_video=copy_video,
        has_audio=probe.has_audio,
        copy_audio=probe.has_audio and copy_audio,
        duration=probe.duration,
    )


def ffmpeg_args(source: Path, target: Path, plan: TranscodePlan) -> list[str]:
    """The ffmpeg argument list for ``plan``, writing ``target``."""
    args = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        # mkstemp has already created the output file, so ffmpeg must be told
        # it may overwrite it — without this it blocks on a y/n prompt whose
        # stdin is /dev/null and dies.
        "-y",
        "-i",
        str(source),
        # Exactly one video and at most one audio stream.  A ``.mkv`` rip
        # routinely carries five audio tracks and a pile of subtitle streams,
        # most of which MP4 cannot hold at all; mapping explicitly is what
        # keeps the mux from failing on them.  The trailing "?" makes the
        # audio stream optional, so a silent clip is not an error.
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
    ]

    if plan.copy_video:
        args += ["-c:v", "copy"]
    else:
        args += [
            "-c:v",
            "libx264",
            "-preset",
            X264_PRESET,
            "-crf",
            X264_CRF,
            # Browsers decode 8-bit 4:2:0 and nothing else reliably, so the
            # output format is pinned rather than inherited from the source.
            "-pix_fmt",
            "yuv420p",
            # Correct non-square pixels, for the same reason the still-frame
            # extractor does: DVD rips, .vob, .mpg and AVCHD .m2ts are all
            # anamorphic, and a 720x480 SAR 32:27 source plays back squashed
            # to 1.50 instead of 1.778 if the sample aspect is dropped.  Only
            # on the re-encode path — a stream copy carries the source's own
            # aspect metadata through untouched.
            "-vf",
            "scale=iw*sar:ih",
        ]

    if not plan.has_audio:
        args += ["-an"]
    elif plan.copy_audio:
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", "aac", "-b:a", AAC_BITRATE, "-ac", "2"]

    args += [
        # Put the moov atom at the front.  Without it the browser has to fetch
        # the end of the file before it can play or seek anywhere, which over
        # a Range request is an extra round trip on every single open.
        "-movflags",
        "+faststart",
        # Interleaving a copied video stream with a re-encoded audio one can
        # buffer a lot of packets on a source with sparse audio; the default
        # queue is small enough that ffmpeg aborts on it.
        "-max_muxing_queue_size",
        "4096",
        # Machine-readable progress on stdout, and the human progress line
        # off, so the reader loop below sees one and only one format.
        "-progress",
        "pipe:1",
        "-nostats",
        # The container is stated rather than inferred, because the output is
        # a mkstemp ".tmp" name that no muxer would recognize.
        "-f",
        "mp4",
        str(target),
    ]
    return args


def transcode_cache_root() -> Path:
    """Root of the per-user converted-video cache."""
    return Path(user_cache_dir("photomap", "photomap")) / TRANSCODE_CACHE_DIRNAME


class TranscodeCache:
    """Converted videos for one album, addressed by source video path.

    Keyed identically to :class:`~photomap.backend.video_cache.VideoFrameCache`
    — ``<path digest>-<mtime digest>`` — so an edited video invalidates its
    conversion for free, and so the album-scoped directory can be dropped
    wholesale when the album is deleted.
    """

    def __init__(self, album_key: str, root: Path | None = None) -> None:
        if not album_key:
            raise ValueError("Album key must not be empty")
        self.album_key = album_key
        self._root = root if root is not None else transcode_cache_root()

    @property
    def directory(self) -> Path:
        return self._root / album_dirname(self.album_key)

    @staticmethod
    def key_for(video_path: Path, mtime: float | None = None) -> str:
        return VideoFrameCache.key_for(video_path, mtime)

    def path_for(self, video_path: Path, mtime: float | None = None) -> Path:
        return self.directory / f"{self.key_for(video_path, mtime)}.mp4"

    def get(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """The converted file, if one has already been produced."""
        path = self.path_for(video_path, mtime)
        return path if path.is_file() else None

    def clear(self) -> None:
        """Drop this album's conversions entirely (album deletion)."""
        shutil.rmtree(self.directory, ignore_errors=True)


def sweep_transcode_cache(
    keep: Path | None = None,
    budget: int = MAX_TRANSCODE_CACHE_BYTES,
    root: Path | None = None,
) -> int:
    """Evict least-recently-used conversions until the cache fits ``budget``.

    Recency is the file's mtime, which :func:`request_transcode` refreshes on
    every cache hit — so a clip watched repeatedly outlives one converted
    once and forgotten, regardless of when either was produced.

    ``keep`` is never evicted: it is the file the caller has just produced and
    is about to serve, and on a cache whose budget is smaller than a single
    movie it would otherwise be deleted before it could be played.
    """
    base = root if root is not None else transcode_cache_root()
    if not base.is_dir():
        return 0

    entries: list[tuple[float, int, Path]] = []
    total = 0
    keep_resolved = keep.resolve() if keep else None
    for path in base.rglob("*.mp4"):
        try:
            stat = path.stat()
        except OSError:
            continue
        total += stat.st_size
        if keep_resolved is not None and path.resolve() == keep_resolved:
            continue
        entries.append((stat.st_mtime, stat.st_size, path))

    if total <= budget:
        return 0

    removed = 0
    entries.sort(key=lambda item: item[0])
    for _mtime, size, path in entries:
        if total <= budget:
            break
        try:
            path.unlink()
        except OSError as e:
            logger.debug(f"Could not evict cached conversion {path}: {e}")
            continue
        total -= size
        removed += 1
    return removed


@dataclass
class _Job:
    """One conversion, from the moment it is requested until it is forgotten."""

    state: TranscodeState = "queued"
    progress: float = 0.0
    detail: str | None = None
    last_polled: float = field(default_factory=time.monotonic)
    finished_at: float | None = None


_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()
_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()


def _worker_pool() -> ThreadPoolExecutor:
    """The single worker every conversion runs on.

    One worker, not several: ffmpeg saturates whatever cores it is given, so
    a second concurrent encode does not finish two videos any sooner — it just
    makes the one the user is actually waiting on take twice as long.
    """
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="video-transcode"
            )
        return _executor


def _scoped_key(album_key: str, key: str) -> str:
    # NUL cannot appear in either half, so no album key can be crafted to
    # collide with another album's entry.
    return f"{album_key}\x00{key}"


def _forget_stale_jobs(now: float) -> None:
    """Drop finished entries nobody can still be waiting on. Caller holds the lock."""
    for scoped, job in list(_jobs.items()):
        if job.finished_at is not None and now - job.finished_at > FAILURE_MEMORY_SECONDS:
            del _jobs[scoped]


def request_transcode(
    album_key: str, video_path: Path, root: Path | None = None
) -> TranscodeStatus:
    """Ensure a playable conversion of ``video_path`` exists, and report progress.

    Idempotent, and doubles as the poll: calling it repeatedly is how a client
    both starts a conversion and watches it, and each call is what keeps the
    job from being treated as abandoned.  Returns immediately in every case —
    the conversion itself runs on the worker pool.
    """
    if ffmpeg_exe() is None:
        return TranscodeStatus(
            state="unavailable",
            detail="Video conversion needs ffmpeg, which is not available on this system.",
        )

    cache = TranscodeCache(album_key, root=root)
    try:
        mtime = video_path.stat().st_mtime
    except OSError as e:
        logger.warning(f"Could not stat {video_path} for conversion: {e}")
        return TranscodeStatus(
            state="failed", detail="The video file could not be read."
        )

    key = cache.key_for(video_path, mtime)
    target = cache.path_for(video_path, mtime)
    if target.is_file():
        # Refresh the LRU stamp so a clip that keeps being watched keeps its
        # place ahead of one converted once and never opened again.
        try:
            os.utime(target, None)
        except OSError:
            pass
        return TranscodeStatus(state="ready", progress=1.0)

    scoped = _scoped_key(album_key, key)
    now = time.monotonic()
    with _jobs_lock:
        _forget_stale_jobs(now)
        job = _jobs.get(scoped)
        if job is not None:
            job.last_polled = now
            if job.state in ("queued", "running"):
                return TranscodeStatus(state=job.state, progress=job.progress)
            if job.state == "failed":
                return TranscodeStatus(state="failed", detail=job.detail)
            # "ready" with no file on disk means the cache was swept or wiped
            # under us; fall through and rebuild it.
        _jobs[scoped] = _Job()

    _worker_pool().submit(_run_job, scoped, video_path, target)
    return TranscodeStatus(state="queued")


def _update(scoped: str, **fields: object) -> _Job | None:
    with _jobs_lock:
        job = _jobs.get(scoped)
        if job is None:
            return None
        for name, value in fields.items():
            setattr(job, name, value)
        return job


def _abandoned(scoped: str, now: float) -> bool:
    with _jobs_lock:
        job = _jobs.get(scoped)
        return job is None or now - job.last_polled > ABANDON_AFTER_SECONDS


def _drop(scoped: str) -> None:
    with _jobs_lock:
        _jobs.pop(scoped, None)


def _job_timeout(duration: float | None) -> float:
    scaled = (duration or 0.0) * JOB_TIMEOUT_PER_SECOND
    return min(max(scaled, MIN_JOB_TIMEOUT_SECONDS), MAX_JOB_TIMEOUT_SECONDS)


def _run_job(scoped: str, source: Path, target: Path) -> None:
    """Worker body: probe, convert, publish.  Never raises."""
    try:
        if _abandoned(scoped, time.monotonic()):
            # Queued behind another conversion for long enough that whoever
            # asked has gone; do not burn the CPU on it.
            _drop(scoped)
            return

        plan = plan_for(probe_streams(source))
        _update(scoped, state="running", progress=0.0)
        logger.info(
            f"Converting {source.name} for playback "
            f"({'remux' if plan.is_remux else 're-encode'})"
        )
        error = _run_ffmpeg_transcode(scoped, source, target, plan)
    except Exception as e:  # pragma: no cover - defensive
        logger.exception(f"Unexpected failure converting {source}")
        error = str(e)

    if error is _ABANDONED:
        _drop(scoped)
        return
    if error:
        _update(
            scoped, state="failed", detail=error, finished_at=time.monotonic()
        )
        return

    _update(scoped, state="ready", progress=1.0, finished_at=time.monotonic())
    try:
        sweep_transcode_cache(keep=target, root=target.parent.parent)
    except Exception as e:  # pragma: no cover - defensive
        logger.warning(f"Could not sweep the conversion cache: {e}")


# Distinct from an error string: the job was dropped on purpose and must not
# be recorded as a failure the client would then be shown.
_ABANDONED = "\x00abandoned"


def _run_ffmpeg_transcode(
    scoped: str, source: Path, target: Path, plan: TranscodePlan
) -> str | None:
    """Run ffmpeg into ``target``.  ``None`` on success, else a message."""
    exe = ffmpeg_exe()
    if exe is None:
        return "Video conversion needs ffmpeg, which is not available on this system."

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # mkstemp, not a name derived from the key: two threads converting the
        # same video would otherwise interleave into one file and os.replace
        # would publish the mixture.  (The single worker makes that unreachable
        # today; it costs nothing to not depend on that.)
        fd, tmp_name = tempfile.mkstemp(
            dir=target.parent, prefix=f"{target.stem}.", suffix=".tmp"
        )
        os.close(fd)
    except OSError as e:
        return f"Could not write to the conversion cache: {e}"
    tmp_path = Path(tmp_name)

    # stderr goes to a file rather than a pipe.  Nothing drains it while the
    # progress stream on stdout is being read, and a pipe that fills blocks
    # ffmpeg forever — the deadlock ``video._run_ffmpeg`` avoids by using
    # communicate().  A conversion cannot use communicate(): its whole point
    # is reporting progress while the child is still running.
    #
    # The ``with`` covers every exit, including one nothing here anticipated:
    # a conversion that escaped through an unexpected exception would
    # otherwise leak the handle, and on Windows leave the temp file itself
    # behind for as long as the process lives.
    with tempfile.TemporaryFile() as stderr_file:
        return _drive_ffmpeg(scoped, exe, source, tmp_path, target, plan, stderr_file)


def _drive_ffmpeg(
    scoped: str,
    exe: str,
    source: Path,
    tmp_path: Path,
    target: Path,
    plan: TranscodePlan,
    stderr_file: IO[bytes],
) -> str | None:
    """Spawn ffmpeg, follow its progress, and publish the result."""
    kwargs: dict[str, object] = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):  # Windows only
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        proc = subprocess.Popen(
            [exe, *ffmpeg_args(source, tmp_path, plan)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=stderr_file,
            **kwargs,
        )
    except OSError as e:
        tmp_path.unlink(missing_ok=True)
        return f"Could not start ffmpeg: {e}"

    stop = threading.Event()
    last_beat = [time.monotonic()]
    deadline = time.monotonic() + _job_timeout(plan.duration)
    killed_for = [""]

    def watchdog() -> None:
        while not stop.wait(WATCHDOG_INTERVAL_SECONDS):
            now = time.monotonic()
            if now - last_beat[0] > STALL_TIMEOUT_SECONDS:
                killed_for[0] = "stalled"
            elif now > deadline:
                killed_for[0] = "timeout"
            elif _abandoned(scoped, now):
                killed_for[0] = "abandoned"
            else:
                continue
            proc.kill()
            return

    watcher = threading.Thread(target=watchdog, daemon=True)
    watcher.start()

    total_us = (plan.duration or 0.0) * 1_000_000
    try:
        # readline, not iteration: a buffered iterator holds lines back, which
        # would both stall the progress readout and make the stall detector
        # fire on a conversion that is working perfectly.
        for raw in iter(proc.stdout.readline, b""):
            last_beat[0] = time.monotonic()
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("out_time_us=") or total_us <= 0:
                continue
            try:
                done = float(line.split("=", 1)[1])
            except ValueError:
                continue
            # Never reports 1.0: only the file landing in place means done,
            # and ffmpeg's last block arrives before the faststart rewrite.
            _update(scoped, progress=max(0.0, min(0.999, done / total_us)))
    finally:
        stop.set()
        try:
            proc.stdout.close()
        except OSError:
            pass
        returncode = proc.wait()
        watcher.join(timeout=WATCHDOG_INTERVAL_SECONDS * 2)

    # What ffmpeg actually produced decides, not what the watchdog intended.
    # The watchdog samples on a timer, so it can wake and fire in the moment
    # between the last progress line and the process exiting cleanly — and a
    # finished conversion must be published even if the client walked away a
    # fraction of a second before it landed. Throwing it out there would mean
    # re-running the whole encode on the next request for no reason.
    try:
        succeeded = (
            returncode == 0 and tmp_path.is_file() and tmp_path.stat().st_size > 0
        )
    except OSError:
        succeeded = False

    if succeeded:
        try:
            os.replace(tmp_path, target)
        except OSError as e:
            tmp_path.unlink(missing_ok=True)
            return f"Could not publish the converted video: {e}"
        return None

    tmp_path.unlink(missing_ok=True)

    if killed_for[0] == "abandoned":
        logger.info(f"Abandoned the conversion of {source.name}; nobody is waiting.")
        return _ABANDONED
    if killed_for[0] == "stalled":
        return "Converting this video stalled; the file may be truncated."
    if killed_for[0] == "timeout":
        return "Converting this video took too long and was stopped."

    detail = _stderr_tail(stderr_file)
    logger.warning(f"ffmpeg could not convert {source}: {detail or returncode}")
    return detail or "This video could not be converted for playback."


# Cap on how much of ffmpeg's complaint is shown to the user.  It goes into a
# panel in the player, not a log.
_MAX_DETAIL_CHARS = 200


def _stderr_tail(handle: IO[bytes]) -> str | None:
    """ffmpeg's last complaint, short enough to show in the player."""
    try:
        handle.seek(0)
        text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    return lines[-1][:_MAX_DETAIL_CHARS]


def _reset_jobs_for_tests() -> None:
    """Test seam: forget every job so a fresh registry can be exercised."""
    with _jobs_lock:
        _jobs.clear()
