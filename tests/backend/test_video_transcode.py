"""Converting videos the browser cannot play.

Three layers, deliberately separated:

* the **decision** (``probe_streams`` -> ``plan_for`` -> ``ffmpeg_args``),
  which is pure and tested against captured banners with no ffmpeg at all;
* the **cache and job registry**, tested against the filesystem;
* the **routes**, tested through the app, including the guards that stop
  ``/prepare_video/<key>/passwd`` from becoming an arbitrary-file-read.

Only the two end-to-end tests need a real ffmpeg binary.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fixtures import (
    ENCODER_SPEC,
    VIDEO_INFO,
    _write_synthetic_index,
    media_fixture_path,
    requires_ffmpeg,
)

from photomap.backend import video as video_module
from photomap.backend import video_transcode
from photomap.backend.video import StreamProbe, ffmpeg_exe, probe_streams
from photomap.backend.video_cache import VideoFrameCache
from photomap.backend.video_transcode import (
    TranscodeCache,
    ffmpeg_args,
    plan_for,
    request_transcode,
    sweep_transcode_cache,
)

# --------------------------------------------------------------------------
# probe_streams — what is actually inside the container
# --------------------------------------------------------------------------

# Captured from the bundled ffmpeg. Parser tests run against fixed strings so
# they need no binary.
MODERN_BANNER = """Input #0, matroska,webm, from 'modern.mkv':
  Metadata:
    ENCODER         : Lavf61.1.100
  Duration: 00:00:04.02, start: 0.000000, bitrate: 110 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 15 fps, 15 tbr, 1k tbn
  Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp
At least one output file must be specified
"""

TEN_BIT_BANNER = """Input #0, matroska,webm, from 'hdr.mkv':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv, progressive), 1920x1080, 24 fps, 24 tbr, 1k tbn
  Stream #0:1: Audio: ac3, 48000 Hz, 5.1, fltp, 448 kb/s
At least one output file must be specified
"""

OLD_AVI_BANNER = """Input #0, avi, from 'old.avi':
  Duration: 00:00:04.07, start: 0.000000, bitrate: 118 kb/s
  Stream #0:0: Video: mpeg4 (Simple Profile) (xvid / 0x64697678), yuv420p, 320x240, 15 fps, 15 tbr, 15 tbn
  Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 44100 Hz, mono, fltp, 64 kb/s
At least one output file must be specified
"""

SILENT_BANNER = """Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent.mp4':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 40 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x61766331), yuv420p, 64x64, 10 fps, 10 tbr, 10240 tbn
At least one output file must be specified
"""

COVER_ART_BANNER = """Input #0, ogg, from 'song.ogg':
  Duration: 00:03:20.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Video: mjpeg (attached pic), yuvj420p(pc), 500x500, 90k tbr
  Stream #0:1: Audio: vorbis, 44100 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified
"""


class _FakeRun:
    """Stands in for ``subprocess.CompletedProcess`` with a canned banner."""

    def __init__(self, banner: str) -> None:
        self.stderr = banner.encode()
        self.stdout = b""
        self.returncode = 1


@pytest.fixture
def banner(monkeypatch):
    """Make ``probe_streams`` see whatever banner a test hands it."""

    def install(text: str) -> None:
        monkeypatch.setattr(
            video_module, "_run_ffmpeg", lambda args, timeout: _FakeRun(text)
        )

    return install


def test_probe_reads_codecs_pixel_format_and_duration(banner):
    banner(MODERN_BANNER)
    probe = probe_streams(Path("modern.mkv"))
    assert probe.duration == pytest.approx(4.02)
    assert probe.has_video and probe.video_codec == "h264"
    assert probe.video_pix_fmt == "yuv420p"
    assert probe.has_audio and probe.audio_codec == "aac"


def test_probe_distinguishes_ten_bit_from_eight_bit(banner):
    """The whole point of parsing the pixel format.

    ``yuv420p10le`` contains ``yuv420p`` as a substring, so a naive contains
    test would call a 10-bit stream copy-safe — and browsers do not decode it,
    which is the exact black rectangle this feature exists to remove.
    """
    banner(TEN_BIT_BANNER)
    probe = probe_streams(Path("hdr.mkv"))
    assert probe.video_codec == "h264"
    assert probe.video_pix_fmt == "yuv420p10le"


def test_probe_reports_a_silent_file_as_having_no_audio(banner):
    banner(SILENT_BANNER)
    probe = probe_streams(Path("silent.mp4"))
    assert probe.has_video is True
    assert probe.has_audio is False
    assert probe.audio_codec is None


def test_probe_ignores_cover_art_as_a_video_stream(banner):
    """An audio file with embedded art must not look like a video to convert."""
    banner(COVER_ART_BANNER)
    probe = probe_streams(Path("song.ogg"))
    assert probe.has_video is False
    assert probe.video_codec is None
    assert probe.audio_codec == "vorbis"


def test_probe_returns_none_when_ffmpeg_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        video_module, "_run_ffmpeg", lambda args, timeout: video_module.FFMPEG_UNAVAILABLE
    )
    assert probe_streams(Path("anything.mkv")) is None


# An audio stream whose *language tag* closes its own paren early and then
# spells out a video stream. ffmpeg prints the tag inline, before the
# ": Audio:" delimiter, so the line matches the video pattern — and it
# degrades toward *copy*, which is the dangerous direction.
TAG_INJECTION_BANNER = """Input #0, matroska,webm, from 'attack.mkv':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0(x): Video: h264 (High), yuv420p, 1920x1080, 25 fps): Audio: opus, 48000 Hz, mono, fltp
  Stream #0:1: Video: hevc (Main 10), yuv420p10le(tv), 320x240, 10 fps
At least one output file must be specified
"""


def test_a_language_tag_cannot_forge_a_copyable_video_stream(banner):
    """The file's own metadata must not be able to win a stream copy.

    Without the ambiguity check this probes as h264/yuv420p — so a 10-bit
    HEVC stream would be copied into an MP4 and cached as ``ready``, which is
    exactly the black rectangle the converter exists to remove.
    """
    banner(TAG_INJECTION_BANNER)
    probe = probe_streams(Path("attack.mkv"))
    assert probe.trusted is False
    assert plan_for(probe).copy_video is False


def test_a_newline_in_the_filename_cannot_forge_report_lines(banner, tmp_path):
    """ffmpeg echoes the input path, and a filename may contain a newline.

    The forged lines are indistinguishable from real ones once they are text,
    so the path itself is what condemns the banner.
    """
    banner(MODERN_BANNER)  # a banner that would otherwise justify a copy
    evil = tmp_path / "a\nStream #0:0: Video: h264 (High), yuv420p\n.mkv"
    probe = probe_streams(evil)
    assert probe.trusted is False
    assert plan_for(probe).copy_video is False


def test_an_ordinary_banner_stays_trusted(banner):
    """The guard must not condemn every normal file."""
    banner(MODERN_BANNER)
    assert probe_streams(Path("modern.mkv")).trusted is True


def test_probe_of_garbage_reports_nothing_rather_than_raising(banner):
    banner("this is not an ffmpeg banner at all")
    probe = probe_streams(Path("junk.bin"))
    assert probe.has_video is False and probe.duration is None


# --------------------------------------------------------------------------
# plan_for — remux when possible, re-encode when not
# --------------------------------------------------------------------------


def test_plan_remuxes_h264_aac(banner):
    banner(MODERN_BANNER)
    plan = plan_for(probe_streams(Path("modern.mkv")))
    assert plan.copy_video and plan.copy_audio
    assert plan.is_remux is True
    assert plan.duration == pytest.approx(4.02)


def test_plan_re_encodes_ten_bit_video_and_ac3_audio(banner):
    banner(TEN_BIT_BANNER)
    plan = plan_for(probe_streams(Path("hdr.mkv")))
    assert plan.copy_video is False
    assert plan.copy_audio is False
    assert plan.is_remux is False


def test_plan_re_encodes_an_old_codec(banner):
    banner(OLD_AVI_BANNER)
    plan = plan_for(probe_streams(Path("old.avi")))
    assert plan.copy_video is False
    # MP4 can legally carry MP3 and browsers do decode it, but Safari has a
    # history of playing it as silence. Audio re-encodes at ~100x realtime, so
    # copying it saves nothing worth the risk.
    assert plan.copy_audio is False


def test_plan_copies_video_even_when_only_the_audio_is_wrong():
    """The common .mkv case: H.264 picture, AC-3 sound.

    Copying the video and re-encoding only the audio is nearly as cheap as a
    pure remux, so the two streams are decided independently.
    """
    plan = plan_for(
        StreamProbe(
            has_video=True,
            video_codec="h264",
            video_pix_fmt="yuv420p",
            has_audio=True,
            audio_codec="ac3",
            duration=90.0,
        )
    )
    assert plan.copy_video is True
    assert plan.copy_audio is False
    assert plan.is_remux is False


def test_a_silent_h264_file_is_a_remux(banner):
    banner(SILENT_BANNER)
    plan = plan_for(probe_streams(Path("silent.mp4")))
    assert plan.has_audio is False
    assert plan.is_remux is True


def test_plan_re_encodes_hevc():
    """Safari plays HEVC and nothing else does, so it is never copied."""
    plan = plan_for(
        StreamProbe(
            has_video=True, video_codec="hevc", video_pix_fmt="yuv420p", has_audio=False
        )
    )
    assert plan.copy_video is False


def test_an_unparsed_pixel_format_is_re_encoded():
    """The conservative direction, and the one that matters.

    A copy we cannot prove is safe risks producing a valid MP4 that still
    shows a black rectangle. Re-encoding when a copy would have done merely
    wastes time once, and the result is cached.
    """
    plan = plan_for(
        StreamProbe(has_video=True, video_codec="h264", video_pix_fmt=None)
    )
    assert plan.copy_video is False


def test_an_untrusted_probe_re_encodes_everything():
    """A banner that could not be fully attributed to ffmpeg justifies nothing.

    The fields are still populated for descriptive use; what must not happen
    is a stream *copy* on their say-so.
    """
    plan = plan_for(
        StreamProbe(
            has_video=True,
            video_codec="h264",
            video_pix_fmt="yuv420p",
            has_audio=True,
            audio_codec="aac",
            duration=42.0,
            trusted=False,
        )
    )
    assert plan.copy_video is False
    assert plan.copy_audio is False
    # The duration comes from the same forged text and drives both the
    # progress readout and the job deadline.
    assert plan.duration is None


def test_a_failed_probe_re_encodes_everything():
    plan = plan_for(None)
    assert plan.copy_video is False
    assert plan.copy_audio is False
    assert plan.duration is None


# --------------------------------------------------------------------------
# ffmpeg_args
# --------------------------------------------------------------------------


def _args(**kwargs) -> list[str]:
    plan = video_transcode.TranscodePlan(**kwargs)
    return ffmpeg_args(Path("/in/clip.mkv"), Path("/out/clip.tmp"), plan)


def test_copy_path_re_encodes_nothing():
    args = _args(copy_video=True, has_audio=True, copy_audio=True)
    assert "-c:v" in args and args[args.index("-c:v") + 1] == "copy"
    assert args[args.index("-c:a") + 1] == "copy"
    # A stream copy carries the source's own aspect metadata through; applying
    # a filter to it is not even possible.
    assert "-vf" not in args


def test_encode_path_pins_a_browser_decodable_format():
    args = _args(copy_video=False, has_audio=True, copy_audio=False)
    assert args[args.index("-c:v") + 1] == "libx264"
    assert args[args.index("-pix_fmt") + 1] == "yuv420p"
    assert args[args.index("-c:a") + 1] == "aac"


def test_encode_path_corrects_non_square_pixels():
    """DVD rips, .vob, .mpg and AVCHD .m2ts are all anamorphic."""
    args = _args(copy_video=False, has_audio=False, copy_audio=False)
    assert args[args.index("-vf") + 1] == "scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1"


def test_the_scale_filter_rounds_both_axes_to_even():
    """libx264 refuses an odd dimension in yuv420p outright.

    720x480 SAR 32:27 is 16:9 NTSC DVD — the single most common shape this
    filter exists for. 720*32/27 = 853.33, and ``scale`` truncates, so an
    unrounded expression yields 853 and every such rip fails permanently.
    """
    vf = _args(copy_video=False, has_audio=False, copy_audio=False)[
        _args(copy_video=False, has_audio=False, copy_audio=False).index("-vf") + 1
    ]
    assert "trunc(" in vf and "*2" in vf
    # And the output must declare square pixels, or a player re-applies the
    # source aspect on top of the correction.
    assert vf.endswith("setsar=1")


def test_a_silent_source_drops_audio_explicitly():
    args = _args(copy_video=True, has_audio=False, copy_audio=False)
    assert "-an" in args
    assert "-c:a" not in args


def test_every_plan_maps_one_video_and_an_optional_audio_stream():
    """A .mkv rip routinely carries five audio tracks and a pile of subtitle
    streams MP4 cannot hold; mapping explicitly is what keeps the mux from
    failing on them."""
    for kwargs in (
        {"copy_video": True, "has_audio": True, "copy_audio": True},
        {"copy_video": False, "has_audio": False, "copy_audio": False},
    ):
        args = _args(**kwargs)
        assert args[args.index("0:v:0") - 1] == "-map"
        assert args[args.index("0:a:0?") - 1] == "-map"


def test_every_plan_front_loads_the_index_and_states_the_container():
    args = _args(copy_video=True, has_audio=True, copy_audio=True)
    # Without faststart the browser fetches the end of the file before it can
    # play or seek — an extra round trip on every open.
    assert args[args.index("-movflags") + 1] == "+faststart"
    # The output is a mkstemp ".tmp" name no muxer would recognize.
    assert args[args.index("-f") + 1] == "mp4"
    assert args[-1] == "/out/clip.tmp"
    assert "-progress" in args and args[args.index("-progress") + 1] == "pipe:1"


# --------------------------------------------------------------------------
# TranscodeCache
# --------------------------------------------------------------------------


def test_cache_paths_are_album_scoped_and_mp4(tmp_path):
    a = TranscodeCache("album-one", root=tmp_path)
    b = TranscodeCache("album-two", root=tmp_path)
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")

    assert a.path_for(video).suffix == ".mp4"
    assert a.path_for(video).parent != b.path_for(video).parent
    assert a.path_for(video).parent.parent == tmp_path


def test_editing_the_source_invalidates_its_conversion(tmp_path):
    """Keying on (path, mtime) is what makes invalidation free."""
    cache = TranscodeCache("album", root=tmp_path)
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")

    before = cache.path_for(video)
    import os

    os.utime(video, (1000, 1000))
    after = cache.path_for(video)
    assert before != after


def test_get_returns_none_until_something_is_converted(tmp_path):
    cache = TranscodeCache("album", root=tmp_path)
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")
    assert cache.get(video) is None

    target = cache.path_for(video)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"converted")
    assert cache.get(video) == target


def test_clear_drops_the_album_directory(tmp_path):
    cache = TranscodeCache("album", root=tmp_path)
    cache.directory.mkdir(parents=True)
    (cache.directory / "a.mp4").write_bytes(b"x")

    cache.clear()
    assert not cache.directory.exists()


def test_an_empty_album_key_is_refused(tmp_path):
    with pytest.raises(ValueError):
        TranscodeCache("", root=tmp_path)


# --------------------------------------------------------------------------
# sweep_transcode_cache
# --------------------------------------------------------------------------


def _make_conversion(root: Path, album: str, name: str, size: int, mtime: float) -> Path:
    import os

    path = root / album / f"{name}.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * size)
    os.utime(path, (mtime, mtime))
    return path


def test_sweep_does_nothing_under_budget(tmp_path):
    _make_conversion(tmp_path, "a", "one", 100, 1000)
    assert sweep_transcode_cache(budget=1000, root=tmp_path) == 0


def test_sweep_evicts_least_recently_used_first(tmp_path):
    old = _make_conversion(tmp_path, "a", "old", 100, 1000)
    middle = _make_conversion(tmp_path, "a", "middle", 100, 2000)
    fresh = _make_conversion(tmp_path, "b", "fresh", 100, 3000)

    removed = sweep_transcode_cache(budget=150, root=tmp_path)

    assert removed == 2
    assert not old.exists() and not middle.exists()
    assert fresh.exists()


def test_sweep_never_evicts_the_file_just_produced(tmp_path):
    """On a budget smaller than a single movie the new file is the oldest
    thing there by mtime only by accident; evicting it would delete the very
    conversion the caller is about to serve."""
    keep = _make_conversion(tmp_path, "a", "keep", 500, 1000)
    other = _make_conversion(tmp_path, "a", "other", 500, 5000)

    sweep_transcode_cache(keep=keep, budget=100, root=tmp_path)

    assert keep.exists()
    assert not other.exists()


def test_sweep_tolerates_a_missing_root(tmp_path):
    assert sweep_transcode_cache(root=tmp_path / "nope") == 0


# --------------------------------------------------------------------------
# request_transcode — the job registry
# --------------------------------------------------------------------------


def test_request_reports_unavailable_without_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr(video_transcode, "ffmpeg_exe", lambda: None)
    status = request_transcode("album", tmp_path / "clip.mkv", root=tmp_path)
    assert status.state == "unavailable"
    assert "ffmpeg" in (status.detail or "")


def test_request_is_an_instant_hit_when_already_converted(monkeypatch, tmp_path):
    monkeypatch.setattr(video_transcode, "ffmpeg_exe", lambda: "/bin/true")
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")
    cache = TranscodeCache("album", root=tmp_path)
    target = cache.path_for(video)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"converted")

    status = request_transcode("album", video, root=tmp_path)
    assert status.state == "ready"
    assert status.progress == 1.0


def test_request_fails_cleanly_when_the_source_is_gone(monkeypatch, tmp_path):
    monkeypatch.setattr(video_transcode, "ffmpeg_exe", lambda: "/bin/true")
    status = request_transcode("album", tmp_path / "missing.mkv", root=tmp_path)
    assert status.state == "failed"


def _await_conversion(album_key: str, video: Path, root: Path, timeout: float = 180.0):
    """Poll the way the player does, until the job reaches a terminal state."""
    deadline = time.monotonic() + timeout
    while True:
        status = request_transcode(album_key, video, root=root)
        if status.state in ("ready", "failed", "unavailable"):
            return status
        assert time.monotonic() < deadline, f"conversion never finished: {status}"
        time.sleep(0.05)


@requires_ffmpeg
def test_an_unplayable_file_becomes_a_playable_one(tmp_path):
    """End to end: XviD/MP3 in an AVI is what a browser refuses outright."""
    exe = ffmpeg_exe()
    source = tmp_path / "old.avi"
    subprocess.run(
        [exe, "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "mpeg4", "-vtag", "xvid", "-c:a", "libmp3lame", str(source)],
        check=True,
    )

    status = _await_conversion("album", source, tmp_path / "cache")
    assert status.state == "ready", status.detail

    converted = TranscodeCache("album", root=tmp_path / "cache").get(source)
    assert converted is not None and converted.stat().st_size > 0
    result = probe_streams(converted)
    assert result.video_codec == "h264"
    assert result.video_pix_fmt == "yuv420p"
    assert result.audio_codec == "aac"


@requires_ffmpeg
def test_a_mismatched_container_is_only_remuxed(tmp_path):
    """H.264/AAC in a .mkv is packaged wrongly, not encoded wrongly."""
    exe = ffmpeg_exe()
    source = tmp_path / "modern.mkv"
    subprocess.run(
        [exe, "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)],
        check=True,
    )
    assert plan_for(probe_streams(source)).is_remux is True

    status = _await_conversion("album", source, tmp_path / "cache")
    assert status.state == "ready", status.detail
    assert TranscodeCache("album", root=tmp_path / "cache").get(source) is not None


@requires_ffmpeg
def test_a_file_ffmpeg_cannot_read_fails_rather_than_hanging(tmp_path):
    source = tmp_path / "notavideo.mkv"
    source.write_bytes(b"this is not a video" * 100)

    status = _await_conversion("album", source, tmp_path / "cache", timeout=60)
    assert status.state == "failed"
    assert status.detail


@requires_ffmpeg
def test_a_remembered_failure_is_not_retried_on_every_poll(tmp_path):
    """Without this a permanently unconvertible file re-runs ffmpeg several
    times a second for as long as the player is open."""
    source = tmp_path / "notavideo.mkv"
    source.write_bytes(b"nope" * 100)
    assert _await_conversion("album", source, tmp_path / "cache", timeout=60).state == "failed"

    calls = []
    original = video_transcode._worker_pool

    def spy():
        calls.append(1)
        return original()

    video_transcode._worker_pool = spy
    try:
        again = request_transcode("album", source, root=tmp_path / "cache")
    finally:
        video_transcode._worker_pool = original

    assert again.state == "failed"
    assert calls == []


def test_names_differing_only_in_case_get_different_conversions(tmp_path):
    """On a case-sensitive filesystem these are two different movies.

    The frame cache casefolds its key, so with matching mtimes — routine for
    anything unpacked from one archive — both would map to one entry. For a
    still that is the wrong thumbnail; here it would play the wrong film.
    """
    cache = TranscodeCache("album", root=tmp_path)
    lower = tmp_path / "clip.mp4"
    upper = tmp_path / "Clip.mp4"
    lower.write_bytes(b"a")
    upper.write_bytes(b"b")
    import os

    os.utime(lower, (1000, 1000))
    os.utime(upper, (1000, 1000))

    assert cache.path_for(lower) != cache.path_for(upper)


def test_serving_a_conversion_refreshes_its_place_in_the_queue(tmp_path):
    """A film is fetched with Range requests across the whole viewing session.

    Without a stamp here its mtime is frozen at the moment the progress panel
    last polled, making the film on screen the first thing the sweeper evicts.
    """
    import os

    cache = TranscodeCache("album", root=tmp_path)
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")
    target = cache.path_for(video)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"converted")
    os.utime(target, (1000, 1000))

    assert cache.get(video) == target
    assert target.stat().st_mtime > 1000


def test_discard_removes_every_generation(tmp_path):
    """The usual reason to discard is that the source is gone, so its mtime
    can no longer be read and the exact key is unrecoverable."""
    cache = TranscodeCache("album", root=tmp_path)
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x")
    directory = cache.directory
    directory.mkdir(parents=True, exist_ok=True)
    prefix = cache.key_for(video).split("-")[0]
    old = directory / f"{prefix}-deadbeefdeadbeef.mp4"
    new = cache.path_for(video)
    old.write_bytes(b"old")
    new.write_bytes(b"new")
    unrelated = directory / "ffffffffffffffffffffffffffffffff-0000000000000000.mp4"
    unrelated.write_bytes(b"other")

    video.unlink()  # the realistic case: source already deleted
    cache.discard(video)

    assert not old.exists() and not new.exists()
    assert unrelated.exists()


def test_prune_keeps_the_index_and_spares_work_in_progress(tmp_path):
    cache = TranscodeCache("album", root=tmp_path)
    directory = cache.directory
    directory.mkdir(parents=True, exist_ok=True)
    keep = directory / "aaaa-bbbb.mp4"
    drop = directory / "cccc-dddd.mp4"
    running = directory / "aaaa.xyz.tmp"
    for f in (keep, drop, running):
        f.write_bytes(b"x")

    assert cache.prune({"aaaa-bbbb"}) == 1
    assert keep.exists() and not drop.exists()
    # A .tmp here is very likely the conversion running right now, which may
    # have hours invested in it; only the age-aware sweeper may remove one.
    assert running.exists()


def test_sweep_spares_a_conversion_that_is_being_watched(tmp_path):
    """Honouring the budget is worth less than not yanking a file out from
    under an open player."""
    fresh = _make_conversion(tmp_path, "a", "watching", 500, time.time())
    old = _make_conversion(tmp_path, "a", "cold", 500, 1000)

    sweep_transcode_cache(budget=100, root=tmp_path)

    assert fresh.exists()
    assert not old.exists()


def test_sweep_reclaims_abandoned_temp_files(tmp_path):
    """A conversion killed by a crash leaves a .tmp behind, and because it is
    not a .mp4 nothing else can even see it."""
    import os

    stale = tmp_path / "a" / "abc.deadbeef.tmp"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"\0" * 1000)
    os.utime(stale, (1000, 1000))

    assert sweep_transcode_cache(budget=10**9, root=tmp_path) == 1
    assert not stale.exists()


def test_an_unknown_duration_gets_the_loosest_deadline_not_the_tightest():
    """MPEG-2 elementary streams (.m2v) always report Duration: N/A.

    Giving those the ten-minute floor killed every one longer than ten minutes
    of encoding, deterministically, on every retry.
    """
    assert video_transcode._job_timeout(None) == video_transcode.MAX_JOB_TIMEOUT_SECONDS
    assert video_transcode._job_timeout(0) == video_transcode.MAX_JOB_TIMEOUT_SECONDS
    assert video_transcode._job_timeout(5.0) == video_transcode.MIN_JOB_TIMEOUT_SECONDS


def test_forget_album_cancels_only_that_album(monkeypatch, tmp_path):
    monkeypatch.setattr(video_transcode, "ffmpeg_exe", lambda: "/bin/true")
    mine = video_transcode._scoped_key("gone", "key")
    theirs = video_transcode._scoped_key("staying", "key")
    video_transcode._jobs[mine] = video_transcode._Job(state="running")
    video_transcode._jobs[theirs] = video_transcode._Job(state="running")

    assert video_transcode.forget_album("gone") == 1
    assert video_transcode._cancelled(mine) is True
    assert video_transcode._cancelled(theirs) is False
    # An explicit cancel also reads as abandonment, so the watchdog kills it.
    assert video_transcode._abandoned(mine, time.monotonic()) is True


def test_a_stalled_job_nobody_polls_is_reaped_from_the_registry():
    """A source whose mtime keeps moving (a file still being copied in) makes
    every poll a new key, so without this the registry grows once a second and
    nothing can ever reclaim it."""
    scoped = video_transcode._scoped_key("album", "key")
    video_transcode._jobs[scoped] = video_transcode._Job(
        state="running",
        last_polled=time.monotonic() - video_transcode.ABANDON_AFTER_SECONDS - 1,
    )
    with video_transcode._jobs_lock:
        video_transcode._forget_stale_jobs(time.monotonic())
    assert scoped not in video_transcode._jobs


def test_stderr_reports_the_cause_not_the_muxer_post_mortem(tmp_path):
    """ffmpeg prints the diagnosis first and a generic summary last."""
    import io

    handle = io.BytesIO(
        b"[libx264] width not divisible by 2 (853x480)\n"
        b"[vf#0:0] Error while filtering\n"
        b"[out#0/mp4] Nothing was written into output file.\n"
    )
    assert "not divisible by 2" in video_transcode._stderr_tail(handle)


@requires_ffmpeg
def test_a_cancelled_job_discards_even_a_finished_conversion(tmp_path, monkeypatch):
    """The album can be deleted while a conversion that then succeeds is still
    running. Publishing it would recreate the directory just removed, into a
    cache keyed by an album that no longer exists.

    Drives the worker body directly rather than polling: a cancelled job never
    reaches a terminal state, because polling for it is precisely what
    cancellation revokes.
    """
    exe = ffmpeg_exe()
    source = tmp_path / "clip.mkv"
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         "testsrc=size=160x120:rate=10:duration=1", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(source)],
        check=True,
    )
    cache = TranscodeCache("album", root=tmp_path / "cache")
    target = cache.path_for(source)
    scoped = video_transcode._scoped_key("album", cache.key_for(source))
    video_transcode._jobs[scoped] = video_transcode._Job(state="running")

    # Cancelled only once ffmpeg has already finished, which is the case that
    # matters: the conversion succeeded and must still be thrown away.
    monkeypatch.setattr(video_transcode, "_cancelled", lambda key: True)
    video_transcode._run_job(scoped, source, target)

    assert not target.exists()
    assert not list(target.parent.glob("*.mp4"))
    assert not list(target.parent.glob("*.tmp"))
    # Dropped rather than recorded as a failure the client would be shown.
    assert scoped not in video_transcode._jobs


@requires_ffmpeg
def test_an_audio_only_container_fails_legibly(tmp_path):
    """.mkv/.mov/.ogg are all in VIDEO_EXTENSIONS but routinely hold audio only.

    ffmpeg's own message is "Error opening output files: Invalid argument",
    which is what the player would otherwise show the user.
    """
    exe = ffmpeg_exe()
    source = tmp_path / "song.mkv"
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1",
         "-c:a", "libopus", str(source)],
        check=True,
    )
    status = _await_conversion("album", source, tmp_path / "cache", timeout=60)
    assert status.state == "failed"
    assert "no video track" in (status.detail or "")


@requires_ffmpeg
def test_an_anamorphic_dvd_rip_converts(tmp_path):
    """720x480 SAR 32:27 is 16:9 NTSC DVD. 720*32/27 = 853.33, and libx264
    refuses an odd width in yuv420p, so this failed on every retry."""
    exe = ffmpeg_exe()
    source = tmp_path / "dvd.mpg"
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         "testsrc=size=720x480:rate=10:duration=1", "-c:v", "mpeg2video",
         "-aspect", "16:9", str(source)],
        check=True,
    )
    status = _await_conversion("album", source, tmp_path / "cache", timeout=120)
    assert status.state == "ready", status.detail

    converted = TranscodeCache("album", root=tmp_path / "cache").get(source)
    probe = probe_streams(converted)
    assert probe.video_codec == "h264"


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------


def _prepare_until_done(client, url: str, timeout: float = 180.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        response = client.post(url)
        assert response.status_code == 200, response.text
        body = response.json()
        if body["state"] in ("ready", "failed", "unavailable"):
            return body
        assert time.monotonic() < deadline, f"never finished: {body}"
        time.sleep(0.05)


def test_prepare_video_rejects_a_still_image(client, mixed_album):
    """The same guard as /videos/: two routes, two allowlists, neither able to
    serve the other's file types."""
    response = client.post("/prepare_video/mixed_album/building1.jpeg")
    assert response.status_code == 403


def test_prepare_video_404s_for_a_file_outside_the_album(client, mixed_album):
    assert client.post("/prepare_video/mixed_album/../../etc/passwd").status_code == 404


def test_prepare_video_404s_on_a_nul_byte(client, mixed_album):
    """Path.resolve() raises ValueError on a NUL, which would otherwise escape
    as a 500 with a traceback."""
    assert client.post("/prepare_video/mixed_album/clip%00.mp4").status_code == 404


def test_prepare_video_404s_for_a_missing_file(client, mixed_album):
    assert client.post("/prepare_video/mixed_album/nope.mp4").status_code == 404


def test_transcoded_video_404s_before_anything_is_converted(client, mixed_album):
    response = client.get("/transcoded_video/mixed_album/clip.mp4")
    assert response.status_code == 404


def test_transcoded_video_rejects_a_still_image(client, mixed_album):
    """Guarded by the album resolution, not by the cache key alone — the cache
    is addressed by a digest of the source path, so serving straight from it
    would skip the access check."""
    assert client.get("/transcoded_video/mixed_album/building1.jpeg").status_code == 403


@requires_ffmpeg
def test_prepare_then_serve_round_trip(client, mixed_album):
    body = _prepare_until_done(client, "/prepare_video/mixed_album/clip.mp4")
    assert body["state"] == "ready", body
    # Only the converted copy is offered: the source bytes are exactly what
    # the browser could not play.
    assert body["url"] == "transcoded_video/mixed_album/clip.mp4"

    served = client.get(f"/{body['url']}")
    assert served.status_code == 200
    assert served.headers["content-type"] == "video/mp4"
    # Being able to seek is most of the reason this is a file and not a pipe.
    assert served.headers.get("accept-ranges") == "bytes"
    assert len(served.content) > 0


@requires_ffmpeg
def test_deleting_an_album_reclaims_its_conversions(client, tmp_path):
    """These are whole movies; the size-budget sweeper only runs when
    something new is converted, so an album deleted and never replaced would
    otherwise leave them behind indefinitely."""
    media_dir = tmp_path / "solo"
    media_dir.mkdir()
    video = media_dir / "clip.mp4"
    shutil.copy(media_fixture_path("clip.mp4"), video)

    index_path = media_dir / "photomap_index" / "embeddings.npz"
    _write_synthetic_index(index_path, [video], [{"photomap_video": dict(VIDEO_INFO)}])
    album = {
        "key": "solo_album",
        "name": "Solo",
        "image_paths": [media_dir.as_posix()],
        "index": index_path.as_posix(),
        "umap_eps": 0.1,
        "description": "",
        "encoder_spec": ENCODER_SPEC,
    }
    assert client.post("/add_album/", json=album).status_code == 201
    try:
        body = _prepare_until_done(client, "/prepare_video/solo_album/clip.mp4")
        assert body["state"] == "ready", body
        directory = TranscodeCache("solo_album").directory
        assert directory.is_dir()
    finally:
        client.delete("/delete_album/solo_album")
        VideoFrameCache("solo_album").clear()

    assert not directory.exists()
