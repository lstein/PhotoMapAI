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

import atexit
import hashlib
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
from .video_cache import album_dirname

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

# A conversion whose mtime was refreshed this recently is never evicted.
# ``TranscodeCache.get`` stamps an entry every time it is served, so this is
# what stops the sweeper deleting the film somebody is in the middle of
# watching — which, since the browser fetches it with Range requests over the
# whole viewing session, would otherwise 404 mid-playback.
EVICTION_GRACE_SECONDS = 900.0

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
    probe whose banner could not be fully attributed to ffmpeg
    (``trusted=False`` — see :func:`~photomap.backend.video.probe_streams`), a
    codec line the banner parser did not match, an unrecognized pixel format —
    all of them mean *we cannot prove a copy would play*, and the cost of
    guessing wrong is the exact black rectangle this module exists to remove.
    Re-encoding when a copy would have done merely wastes time once, and the
    result is cached.
    """
    if probe is None or not probe.trusted:
        # Duration is dropped along with the rest: on the untrusted path it is
        # the same forged text, and a bogus duration drives both the progress
        # readout and the job deadline.
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
            #
            # Both axes are rounded to even numbers, which is not decoration:
            # ``scale`` truncates to int, and libx264 refuses a yuv420p frame
            # with an odd dimension outright ("width not divisible by 2").
            # 720*32/27 is 853.33 -> 853, so the single most common shape this
            # filter exists for — 16:9 NTSC DVD — failed every time without
            # the rounding.  ``setsar=1`` then states that the output pixels
            # really are square, so nothing downstream re-applies the source's
            # aspect a second time.
            #
            # The comma here separates two filters, which is what a filtergraph
            # wants; note that a comma *inside* one of these expressions would
            # have to be escaped, which is why none of them contains one.
            "-vf",
            "scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1",
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
        """``<exact-case path digest>-<mtime digest>``.

        Shaped like :meth:`VideoFrameCache.key_for` but deliberately **not**
        delegating to it: that one casefolds the path, so on a case-sensitive
        filesystem two genuinely different files whose names differ only in
        case (``clip.mp4`` and ``Clip.mp4``) collide whenever their mtimes also
        match — which is routine for anything unpacked from one archive. For a
        still that means the wrong thumbnail; here it would mean **playing the
        wrong movie**, and reporting it ``ready`` without converting it.

        The casefold exists there to stop a case-insensitive filesystem
        presenting one file under two spellings and thrashing the extract/prune
        loop. This cache has no such loop — it is swept by byte budget, not
        against the index — so the worst an exact-case key costs it is
        converting one file twice on macOS or Windows. That is the right way
        round: duplicated work over wrong content.
        """
        if mtime is None:
            try:
                mtime = video_path.stat().st_mtime
            except OSError:
                mtime = 0.0
        try:
            resolved = Path(video_path).resolve().as_posix()
        except (OSError, RuntimeError, ValueError):
            resolved = Path(video_path).as_posix()
        digest = hashlib.blake2b(
            resolved.encode("utf-8", errors="surrogatepass"), digest_size=16
        ).hexdigest()
        stamp = hashlib.blake2b(f"{mtime:.6f}".encode(), digest_size=8).hexdigest()
        return f"{digest}-{stamp}"

    def path_for(self, video_path: Path, mtime: float | None = None) -> Path:
        return self.directory / f"{self.key_for(video_path, mtime)}.mp4"

    def get(self, video_path: Path, mtime: float | None = None) -> Path | None:
        """The converted file, if one has already been produced.

        Stamps the entry as used. That is what keeps it out of the sweeper's
        reach while it is being watched: the browser fetches a film with Range
        requests spread over the whole viewing session, and without a stamp
        here its mtime would be frozen at the moment the progress panel last
        polled — making the film currently on screen the *first* thing evicted
        when some other conversion finishes.
        """
        path = self.path_for(video_path, mtime)
        if not path.is_file():
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return path

    def prune(self, keep_keys: set[str]) -> int:
        """Delete every conversion whose key is not in ``keep_keys``.

        The index-save sweep, mirroring :meth:`VideoFrameCache.prune`: one
        pass covers mtime changes, moves, copies, deletes and files removed
        outside the app, none of which have a hook of their own.

        Unlike the frame cache's version this deliberately leaves ``.tmp``
        files alone. There, a stray temp is a dead extraction worth seconds;
        here it is very likely the conversion running *right now*, which may
        have hours invested in it. Abandoned temps are reclaimed by
        :func:`sweep_transcode_cache`, which can tell the difference by age.
        """
        directory = self.directory
        if not directory.is_dir():
            return 0
        try:
            entries = list(directory.iterdir())
        except OSError as e:
            logger.warning(f"Could not sweep the conversion cache {directory}: {e}")
            return 0
        removed = 0
        for entry in entries:
            if entry.suffix != ".mp4" or entry.stem in keep_keys:
                continue
            try:
                entry.unlink()
                removed += 1
            except OSError as e:
                logger.debug(f"Could not remove stale conversion {entry}: {e}")
        return removed

    def discard(self, video_path: Path, mtime: float | None = None) -> None:
        """Drop every converted generation of ``video_path``.

        Globs the path digest rather than computing one key, for the same
        reason :meth:`VideoFrameCache.discard` does: the usual reason to
        discard is that the source has just been deleted, so its mtime can no
        longer be read and the exact key is unrecoverable.
        """
        prefix = self.key_for(video_path, mtime).split("-")[0]
        directory = self.directory
        if not directory.is_dir():
            return
        try:
            stale = list(directory.glob(f"{prefix}-*.mp4"))
        except OSError:
            return
        for entry in stale:
            try:
                entry.unlink()
            except OSError as e:
                logger.debug(f"Could not discard conversion {entry}: {e}")

    def clear(self) -> None:
        """Drop this album's conversions entirely (album deletion)."""
        shutil.rmtree(self.directory, ignore_errors=True)


def sweep_transcode_cache(
    keep: Path | None = None,
    budget: int = MAX_TRANSCODE_CACHE_BYTES,
    root: Path | None = None,
) -> int:
    """Evict least-recently-used conversions until the cache fits ``budget``.

    Recency is the file's mtime, which :meth:`TranscodeCache.get` and
    :func:`request_transcode` both refresh on every hit — so a clip watched
    repeatedly outlives one converted once and forgotten, regardless of when
    either was produced.

    Two things are never evicted:

    * ``keep`` — the file the caller has just produced and is about to serve.
      On a cache whose budget is smaller than a single movie it would
      otherwise be deleted before it could be played.
    * anything stamped within :data:`EVICTION_GRACE_SECONDS`, which is what a
      film being watched right now looks like. Honouring the budget is worth
      less than not yanking a file out from under an open player, so the cache
      is allowed to sit over budget until the viewing finishes.

    Abandoned ``.tmp`` files are collected too, and *before* the budget test:
    a conversion killed by a crash or a hard server stop leaves one behind,
    and because they are not ``.mp4`` they would otherwise be invisible to the
    accounting forever — the one class of garbage nothing else reclaims.
    """
    base = root if root is not None else transcode_cache_root()
    if not base.is_dir():
        return 0

    now = time.time()
    removed = 0
    for stale in base.rglob("*.tmp"):
        try:
            if now - stale.stat().st_mtime <= EVICTION_GRACE_SECONDS:
                continue  # very likely the conversion running right now
            stale.unlink()
            removed += 1
        except OSError as e:
            logger.debug(f"Could not remove abandoned conversion temp {stale}: {e}")

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
        if now - stat.st_mtime <= EVICTION_GRACE_SECONDS:
            continue
        entries.append((stat.st_mtime, stat.st_size, path))

    if total <= budget:
        return removed

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
    #: Set when the reason to stop is *known*, not merely inferred from
    #: silence: the album was deleted, or the process is shutting down. Kept
    #: apart from the polling clock because the two want opposite treatment of
    #: a conversion that finishes anyway — see :func:`_drive_ffmpeg`.
    cancelled: bool = False


_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()
_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()

# Every ffmpeg this module currently has running, so shutdown can kill them.
_live_processes: set[subprocess.Popen] = set()
_live_lock = threading.Lock()
_shutting_down = threading.Event()


def _shutdown_conversions() -> None:
    """Stop every conversion so the interpreter can actually exit.

    ``ThreadPoolExecutor``'s worker threads are non-daemon and
    ``concurrent.futures`` registers an ``atexit`` hook that *joins* them, so
    without this a re-encode holds the whole process open at shutdown — the
    watchdog would not notice for ``ABANDON_AFTER_SECONDS``, so stopping the
    server took the better part of a minute, every time.

    Registered after ``concurrent.futures``'s own hook (this module imports it
    first) and ``atexit`` runs last-registered-first, so this gets to kill the
    children before anything waits on the thread running them.
    """
    _shutting_down.set()
    with _jobs_lock:
        for job in _jobs.values():
            job.cancelled = True
    with _live_lock:
        doomed = list(_live_processes)
    for proc in doomed:
        try:
            proc.kill()
        except OSError:
            pass


atexit.register(_shutdown_conversions)


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
    """Drop entries nobody can still be waiting on. Caller holds the lock.

    Two kinds, and the second is what bounds the registry:

    * finished entries older than :data:`FAILURE_MEMORY_SECONDS`;
    * **queued or running** entries whose client stopped polling. Reaping
      these is not merely tidiness — a source whose mtime keeps moving (a
      file still being copied in, a growing recording) produces a *new* cache
      key on every poll, so every poll creates a job and queues a worker task,
      once a second, none of which can ever be reclaimed by the first rule
      because none of them ever finishes. Dropping the entry is also what
      makes the watchdog treat the job as abandoned and kill its ffmpeg.
    """
    for scoped, job in list(_jobs.items()):
        if job.finished_at is not None:
            if now - job.finished_at > FAILURE_MEMORY_SECONDS:
                del _jobs[scoped]
        elif now - job.last_polled > ABANDON_AFTER_SECONDS:
            del _jobs[scoped]


def forget_album(album_key: str) -> int:
    """Cancel every conversion belonging to ``album_key``. Returns how many.

    Called when the album is deleted. Without it, a conversion already in
    flight finishes afterwards and ``mkdir(parents=True)`` **recreates the
    directory that was just removed**, publishing a whole movie into a cache
    nothing will ever clear again — the album key it is filed under no longer
    exists, so the only remaining reclamation is the global byte budget.
    """
    prefix = f"{album_key}\x00"
    cancelled = 0
    with _jobs_lock:
        for scoped, job in _jobs.items():
            if scoped.startswith(prefix):
                job.cancelled = True
                cancelled += 1
    return cancelled


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
    now = time.monotonic()

    # Before the cache-hit shortcut, not after it: on a library whose videos
    # are all already converted every call returns here, and the registry
    # would never be swept at all.
    with _jobs_lock:
        _forget_stale_jobs(now)

    if target.is_file():
        # Refresh the LRU stamp so a clip that keeps being watched keeps its
        # place ahead of one converted once and never opened again.
        try:
            os.utime(target, None)
        except OSError:
            pass
        return TranscodeStatus(state="ready", progress=1.0)

    scoped = _scoped_key(album_key, key)
    with _jobs_lock:
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
    """True when nothing is waiting for this job any more."""
    if _shutting_down.is_set():
        return True
    with _jobs_lock:
        job = _jobs.get(scoped)
        if job is None:
            return True
        return job.cancelled or now - job.last_polled > ABANDON_AFTER_SECONDS


def _cancelled(scoped: str) -> bool:
    """True only for a *known* reason to stop, never for mere silence."""
    if _shutting_down.is_set():
        return True
    with _jobs_lock:
        job = _jobs.get(scoped)
        return job is None or job.cancelled


def _drop(scoped: str) -> None:
    with _jobs_lock:
        _jobs.pop(scoped, None)


def _job_timeout(duration: float | None) -> float:
    """Wall-clock ceiling for one conversion, scaled off the source duration.

    An *unknown* duration takes the loosest ceiling, not the tightest. MPEG-2
    elementary streams (``.m2v``) report ``Duration: N/A`` as a matter of
    course, and giving those the ten-minute floor killed every one longer than
    ten minutes of encoding — deterministically, so it recurred on every
    retry. A genuinely wedged job is caught by the stall detector instead,
    which does not depend on knowing the duration.
    """
    if duration is None or duration <= 0:
        return MAX_JOB_TIMEOUT_SECONDS
    return min(
        max(duration * JOB_TIMEOUT_PER_SECOND, MIN_JOB_TIMEOUT_SECONDS),
        MAX_JOB_TIMEOUT_SECONDS,
    )


def _run_job(scoped: str, source: Path, target: Path) -> None:
    """Worker body: probe, convert, publish.  Never raises."""
    try:
        if _abandoned(scoped, time.monotonic()):
            # Queued behind another conversion for long enough that whoever
            # asked has gone; do not burn the CPU on it.
            _drop(scoped)
            return

        probe = probe_streams(source)
        # An extension in VIDEO_EXTENSIONS is no promise of a video stream:
        # .mkv, .mov, .ogg and .asf all routinely hold audio only. ffmpeg
        # would fail on the unconditional "-map 0:v:0" with "Error opening
        # output files: Invalid argument", which is what the player would then
        # show the user. Say what is actually wrong instead.
        if probe is not None and probe.trusted and not probe.has_video:
            _update(
                scoped,
                state="failed",
                detail="This file has no video track to play.",
                finished_at=time.monotonic(),
            )
            return

        plan = plan_for(probe)
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

    with _live_lock:
        _live_processes.add(proc)
    try:
        return _follow_ffmpeg(scoped, proc, source, tmp_path, target, plan, stderr_file)
    except BaseException:
        # Everything from here to the read loop's own try/finally used to be
        # unprotected, so anything raising in between — thread exhaustion at
        # `watcher.start()` is the reachable one — left ffmpeg running with no
        # watchdog, unreaped, and a multi-gigabyte ".tmp" behind that the
        # sweeper could not even see (it counts ".mp4"). Killing here costs a
        # conversion that was already lost.
        try:
            proc.kill()
            proc.wait(timeout=WATCHDOG_INTERVAL_SECONDS)
        except (OSError, subprocess.TimeoutExpired):
            pass
        tmp_path.unlink(missing_ok=True)
        raise
    finally:
        with _live_lock:
            _live_processes.discard(proc)


def _follow_ffmpeg(
    scoped: str,
    proc: subprocess.Popen,
    source: Path,
    tmp_path: Path,
    target: Path,
    plan: TranscodePlan,
    stderr_file: IO[bytes],
) -> str | None:
    """Watch a running ffmpeg to completion and publish what it produced."""
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
                # Covers the polling clock, an explicit cancel, and shutdown.
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

    # Cancellation is checked here rather than only up front, because the
    # album can be deleted (or the server stopped) at any point during a
    # conversion that then completes perfectly well. Publishing it would
    # recreate the directory that was just removed. Note this is
    # ``_cancelled``, not ``_abandoned``: mere silence from the client must
    # NOT discard a finished conversion — see the comment above `succeeded`.
    if succeeded and _cancelled(scoped):
        tmp_path.unlink(missing_ok=True)
        logger.info(f"Discarded the finished conversion of {source.name}; cancelled.")
        return _ABANDONED

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
    """ffmpeg's *first* complaint, short enough to show in the player.

    The first, not the last. Under ``-loglevel error`` ffmpeg prints the
    diagnosis first and a generic muxer post-mortem last — "Nothing was
    written into output file, because at least one of its streams received no
    packets", or "Error opening output files: Invalid argument" — so taking
    the last line reliably showed the user the one line that says nothing
    about what went wrong, while the actual cause (say "[libx264] width not
    divisible by 2") sat above it.
    """
    try:
        handle.seek(0)
        text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return None
    return lines[0][:_MAX_DETAIL_CHARS]


def _reset_jobs_for_tests() -> None:
    """Test seam: forget every job so a fresh registry can be exercised."""
    with _jobs_lock:
        _jobs.clear()
