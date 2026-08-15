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

VIDEO_EXTENSIONS: frozenset[str] = frozenset(
    {
        # Generally web-playable containers
        ".mp4",
        ".m4v",
        ".mov",
        ".webm",
        ".ogv",
        ".ogg",
        # Index-only containers: ffmpeg decodes them, browsers do not play them
        ".mkv",
        ".avi",
        ".wmv",
        ".flv",
        ".asf",
        ".mpg",
        ".mpeg",
        ".m2v",
        ".vob",
        # Camcorder transport streams
        ".ts",
        ".m2ts",
        ".mts",
        # Phone
        ".3gp",
        ".3g2",
    }
)

WEB_PLAYABLE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".mp4",
        ".m4v",
        ".mov",
        ".webm",
        ".ogv",
        ".ogg",
    }
)

INDEXABLE_EXTENSIONS: frozenset[str] = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

# Explicit container -> MIME map.
#
# Deliberately NOT ``mimetypes.guess_type``.  Two ways that bites:
#   * ``.ogg`` maps to ``audio/ogg`` in the stdlib table (the extension is
#     genuinely ambiguous), so an Ogg *video* would be handed to <video> as
#     audio and render blank.
#   * On Windows ``guess_type`` consults the registry, so a stripped machine
#     can return ``None`` for ``.mp4``; Starlette then falls back to
#     ``text/plain``, which no browser will play.
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
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".3gp": "video/3gpp",
    ".3g2": "video/3gpp2",
}

# Fallback for a video suffix with no explicit mapping. Should be unreachable
# (a test asserts VIDEO_EXTENSIONS and VIDEO_MEDIA_TYPES agree), but a generic
# video type still beats Starlette's text/plain default.
DEFAULT_VIDEO_MEDIA_TYPE = "application/octet-stream"


def is_video(path: Path | str) -> bool:
    """True if ``path``'s suffix names a video container we can index."""
    return Path(path).suffix.lower() in VIDEO_EXTENSIONS


def is_image(path: Path | str) -> bool:
    """True if ``path``'s suffix names a still-image format PIL can open."""
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def media_type_for(path: Path | str) -> MediaType:
    """Classify ``path`` by suffix.

    Deriving media type from the filename — rather than storing it as a
    per-image column in the ``.npz`` — is what lets indexes written before
    video support was added report the right type with no migration and no
    legacy fallback branch.  Anything that is not a known video container is
    reported as an image, matching the pre-video behavior of every caller.
    """
    return "video" if is_video(path) else "image"


def is_web_playable(path: Path | str) -> bool:
    """True if browsers can *generally* play this container.

    A hint for badge styling only — the real answer depends on the codec
    inside, so the player attempts playback regardless and handles failure.
    """
    return Path(path).suffix.lower() in WEB_PLAYABLE_EXTENSIONS


def video_media_type(path: Path | str) -> str:
    """MIME type to serve ``path`` with. See :data:`VIDEO_MEDIA_TYPES`."""
    return VIDEO_MEDIA_TYPES.get(Path(path).suffix.lower(), DEFAULT_VIDEO_MEDIA_TYPE)
