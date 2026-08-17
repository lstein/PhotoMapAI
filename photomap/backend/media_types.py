"""Central media-type taxonomy for PhotoMapAI.

Historically ``embeddings.SUPPORTED_EXTENSIONS`` was a single set doing two
unrelated jobs: deciding what the indexing directory walk picks up, *and*
acting as the arbitrary-file-read guard on the file-serving endpoints
(``/images/``, ``/image_by_name/``).  Those two jobs diverge as soon as videos
are indexable — a video must be walked but must not be servable through the
image routes — so the sets are named separately here:

``IMAGE_EXTENSIONS``
    Still images.  PIL can open every one of these.  This is what the
    image-serving guard allows, and it is what ``SUPPORTED_EXTENSIONS``
    remains an alias of, so no existing behavior moves.

``VIDEO_EXTENSIONS``
    Containers ffmpeg can decode a frame from.  ``imageio-ffmpeg`` exposes no
    list of its own, so this is curated.

``WEB_PLAYABLE_EXTENSIONS``
    The subset browsers can generally play in a ``<video>`` element.  This is
    a *hint* used to style the play badge, never a gate: playability also
    depends on the codec inside the container (an HEVC ``.mp4`` plays in
    Safari but not Firefox), so the player always attempts playback and falls
    back on the element's ``error`` event.

``INDEXABLE_EXTENSIONS``
    What the directory walk collects.  Everything PhotoMapAI can turn into an
    embedding.
"""

from pathlib import Path
from typing import Literal

MediaType = Literal["image", "video"]

IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".bmp",
        ".gif",
        ".webp",
        ".tiff",
        ".heif",
        ".heic",
    }
)

# Container -> MIME map, and the single source of truth for which containers
# are video at all: ``VIDEO_EXTENSIONS`` is derived from its keys below. Listing
# the suffixes twice invited the two sets drifting apart, with the subset test
# still passing.
#
# Deliberately NOT ``mimetypes.guess_type``.  Two ways that bites:
#   * ``.ogg`` maps to ``audio/ogg`` in the stdlib table (the extension is
#     genuinely ambiguous), so an Ogg *video* would be handed to <video> as
#     audio and render blank.
#   * On Windows ``guess_type`` consults the registry, so a stripped machine
#     can return ``None`` for ``.mp4``; Starlette then falls back to
#     ``text/plain``, which no browser will play.
#
# Deliberately absent: ``.ts``. It is an MPEG transport stream roughly never,
# and TypeScript constantly, and the indexing walk prunes only dot-directories
# plus a handful of names — an album pointed at a home directory would collect
# every .ts source file in every node_modules as a video and spawn ffmpeg on
# each. ``.m2ts``/``.mts`` cover AVCHD camcorders unambiguously.
VIDEO_MEDIA_TYPES: dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".ogg": "video/ogg",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".asf": "video/x-ms-asf",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".m2v": "video/mpeg",
    ".vob": "video/mpeg",
    ".m2ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
}

VIDEO_EXTENSIONS: frozenset[str] = frozenset(VIDEO_MEDIA_TYPES)

# Containers current browsers generally play in a <video> element.
#
# Ogg/Theora is deliberately NOT here despite ffmpeg decoding it happily:
# Chrome removed Theora in M123 (March 2024) and Firefox in 126, and Safari
# never supported it, so a play badge on a .ogv would promise something no
# current browser delivers.
#
# The conservative direction is the safe one. A container listed here that
# turns out not to play still lands on the player's <video> error handler,
# which names the format and offers a download; one omitted merely warns
# first and then plays anyway. Codec, not container, decides in the end — an
# HEVC .mp4 plays in Safari but not Firefox — which is why the player always
# attempts playback rather than trusting this set.
WEB_PLAYABLE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".mp4",
        ".m4v",
        ".mov",
        ".webm",
    }
)

INDEXABLE_EXTENSIONS: frozenset[str] = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

# Fallback for a suffix with no explicit mapping. Unreachable for anything in
# VIDEO_EXTENSIONS, since that set is now derived from VIDEO_MEDIA_TYPES' own
# keys; it exists only for callers that pass an arbitrary path. Deliberately
# not a video type: ``video_media_type`` does not validate its argument, so a
# caller handing it a non-video must not get something that looks playable.
DEFAULT_VIDEO_MEDIA_TYPE = "application/octet-stream"


def is_video(path: Path | str) -> bool:
    """True if ``path``'s suffix names a video container we can index."""
    return Path(path).suffix.lower() in VIDEO_EXTENSIONS


def is_image(path: Path | str) -> bool:
    """True if ``path``'s suffix names a still-image format PIL can open."""
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def media_type_for(path: Path | str) -> MediaType:
    """Classify an **already-admitted** album entry by suffix.

    Deriving media type from the filename — rather than storing it as a
    per-image column in the ``.npz`` — is what lets indexes written before
    video support was added report the right type with no migration and no
    legacy fallback branch.

    .. warning::
       This is **not** a membership test and must never be used as a serving
       guard. Everything that is not a known video container is reported as
       ``"image"``, including ``passwd`` and ``notes.txt`` — the point is that
       entries already in an index predate the video split and must keep
       classifying as images. Use :func:`is_image` to decide whether a path
       may be opened or served; that is what closes the ``add_album`` →
       ``/images/<key>/passwd`` arbitrary-read chain.
    """
    return "video" if is_video(path) else "image"


def is_web_playable(path: Path | str) -> bool:
    """True if browsers generally play this container. See
    :data:`WEB_PLAYABLE_EXTENSIONS`.

    Drives how the play badge is styled and whether the player explains
    up front. Not authoritative: the codec inside decides, so the player
    attempts playback either way and falls back on the element's own error.
    """
    return Path(path).suffix.lower() in WEB_PLAYABLE_EXTENSIONS


def video_media_type(path: Path | str) -> str:
    """MIME type to serve ``path`` with. See :data:`VIDEO_MEDIA_TYPES`.

    Does **not** validate that ``path`` is a video — an unknown suffix gets
    :data:`DEFAULT_VIDEO_MEDIA_TYPE`, which is deliberately not a video type.
    Callers must gate on :func:`is_video` first; this returning a string is
    not evidence that the file is servable.
    """
    return VIDEO_MEDIA_TYPES.get(Path(path).suffix.lower(), DEFAULT_VIDEO_MEDIA_TYPE)
