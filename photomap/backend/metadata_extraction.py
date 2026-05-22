"""
metadata_extraction.py

Handles extraction of metadata from various image sources including:
- InvokeAI metadata
- Stable Diffusion metadata
- EXIF data (including GPS coordinates)
"""

import json
import logging
from typing import Any

from PIL import ExifTags, Image

logger = logging.getLogger(__name__)


def _normalize_text_chunk(value: Any) -> str:
    """Coerce a PIL ``img.info[...]`` value to a JSON-parseable string.

    Pillow returns different shapes for the three PNG text-chunk types:

    * ``tEXt`` — ``str``
    * ``zTXt`` — ``str`` (decompressed) in recent Pillow, ``bytes`` historically
    * ``iTXt`` — a ``(text, lang, translated_keyword)`` tuple in some versions,
      ``str`` in others

    Without normalization, an ``iTXt`` chunk hands ``json.loads`` a tuple
    (TypeError on the next line) and a ``zTXt`` bytes payload works but
    masks the underlying type drift. Funnel everything through this helper
    so the JSON parse sees a clean ``str``.
    """
    if isinstance(value, tuple):
        # iTXt: the actual text is the first element; subsequent entries
        # are lang and translated_keyword which we don't need.
        value = value[0] if value else ""
    if isinstance(value, bytes | bytearray):
        value = bytes(value).decode("utf-8", errors="replace")
    return str(value)


class MetadataExtractor:
    """Handles extraction of metadata from images."""

    @staticmethod
    def extract_image_metadata(pil_image: Image.Image) -> dict[str, Any]:
        """
        Extract metadata from an image in order of preference.

        Args:
            pil_image: PIL Image object

        Returns:
            dict: Extracted metadata or empty dict if none found
        """

        def _json_from_chunk(key: str):
            return lambda img: json.loads(_normalize_text_chunk(img.info[key]))

        # Define metadata extraction strategies in order of preference
        metadata_extractors = [
            ("invokeai_metadata", _json_from_chunk("invokeai_metadata")),
            ("Sd-metadata", _json_from_chunk("Sd-metadata")),
            ("sd-metadata", _json_from_chunk("sd-metadata")),
            ("exif", ExifExtractor.extract_exif_metadata),
        ]

        for key, extractor in metadata_extractors:
            if key in pil_image.info:
                try:
                    return extractor(pil_image)
                except Exception as e:
                    logger.warning("Failed to parse %s metadata: %s", key, e)
                    continue

        return {}  # No metadata available


class ExifExtractor:
    """Handles EXIF data extraction and processing."""

    @staticmethod
    def extract_exif_metadata(pil_image: Image.Image) -> dict[str, Any]:
        """Extract and format EXIF metadata from an image."""
        exif_data = pil_image.getexif()
        exif_dict = {}

        # First get the base exif tags
        for k, v in exif_data.items():
            tag_name = ExifTags.TAGS.get(k, f"UnknownTag_{k}")
            if isinstance(v, bytes):
                try:
                    v = v.decode('utf-8', errors='ignore')
                except Exception:
                    continue
            if type(v) in [str, int, float, bool]:
                exif_dict[tag_name] = v

        # Now get the tags in ExifTags.IFD with special GPS handling
        for ifd_id in ExifTags.IFD:
            try:
                ifd = exif_data.get_ifd(ifd_id)
                if not ifd:
                    continue

                if ifd_id == ExifTags.IFD.GPSInfo:
                    # Special handling for GPS data
                    gps_data = GPSExtractor.extract_gps_data(ifd)
                    exif_dict.update(gps_data)
                else:
                    # Handle other IFDs normally
                    for k, v in ifd.items():
                        tag_name = ExifTags.TAGS.get(k, f"Unknown_{ifd_id.name}_{k}")
                        if isinstance(v, bytes):
                            try:
                                v = v.decode('utf-8', errors='ignore')
                            except Exception:
                                continue
                        if type(v) in [str, int, float, bool]:
                            exif_dict[tag_name] = v

            except (KeyError, OSError, AttributeError):
                continue
            except Exception as e:
                logger.warning("Unexpected error reading IFD %s: %s", ifd_id.name, e)
                continue

        return exif_dict


class GPSExtractor:
    """Handles GPS coordinate extraction and conversion."""

    @staticmethod
    def extract_gps_data(gps_ifd) -> dict[str, Any]:
        """Extract and convert GPS data to decimal degrees."""
        gps_dict = {}

        try:
            # Get GPS tags with proper names
            for k, v in gps_ifd.items():
                tag_name = ExifTags.GPSTAGS.get(k, f"GPSTag_{k}")
                gps_dict[tag_name] = v

            # Convert GPS coordinates to decimal degrees if available
            lat = gps_dict.get('GPSLatitude')
            lat_ref = gps_dict.get('GPSLatitudeRef')
            lon = gps_dict.get('GPSLongitude')
            lon_ref = gps_dict.get('GPSLongitudeRef')

            if lat and lat_ref:
                decimal_lat = GPSExtractor._convert_gps_coord(lat, lat_ref)
                if decimal_lat is not None:
                    gps_dict['GPSLatitudeDecimal'] = decimal_lat

            if lon and lon_ref:
                decimal_lon = GPSExtractor._convert_gps_coord(lon, lon_ref)
                if decimal_lon is not None:
                    gps_dict['GPSLongitudeDecimal'] = decimal_lon

            # Filter out non-serializable values
            filtered_gps = {}
            for key, value in gps_dict.items():
                if type(value) in [str, int, float, bool]:
                    filtered_gps[key] = value

            return filtered_gps

        except Exception as e:
            logger.warning("Failed to extract GPS data: %s", e)
            return {}

    @staticmethod
    def _convert_gps_coord(coord_tuple, ref) -> float | None:
        """Convert GPS coordinate from degrees/minutes/seconds to decimal degrees."""
        try:
            if not coord_tuple or len(coord_tuple) != 3:
                return None

            degrees, minutes, seconds = coord_tuple

            # Convert to float if they're fractions
            if hasattr(degrees, 'numerator'):
                degrees = float(degrees.numerator) / float(degrees.denominator)
            if hasattr(minutes, 'numerator'):
                minutes = float(minutes.numerator) / float(minutes.denominator)
            if hasattr(seconds, 'numerator'):
                seconds = float(seconds.numerator) / float(seconds.denominator)

            decimal = float(degrees) + float(minutes)/60 + float(seconds)/3600

            # Apply reference direction
            if ref in ['S', 'W']:
                decimal = -decimal

            return decimal

        except Exception as e:
            logger.warning("Failed to convert GPS coordinate %r: %s", coord_tuple, e)
            return None
