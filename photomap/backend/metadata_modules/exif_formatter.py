"""
backend.metadata.exif

Format EXIF metadata for images, including human-readable tags.
Returns an HTML representation of the EXIF data.
"""

import html
import threading
from collections import OrderedDict
from logging import getLogger

import requests

from .slide_summary import SlideSummary

logger = getLogger(__name__)


# ---------------------------------------------------------------------------
# Reverse-geocode cache for LocationIQ
# ---------------------------------------------------------------------------
#
# ``format_exif_metadata`` runs on every image render — typically dozens of
# times per second while the user scrolls through a folder. Each call here
# previously fired a network round-trip to LocationIQ, blocking the
# rendering thread for up to ~500 ms on success and the full 5-second
# request timeout on transient failures. Adjacent photos at the same place
# issued duplicate requests because nothing remembered the prior answer.
#
# The cache funnels lookups through ``get_locationiq_place_name`` and is
# keyed by ``(rounded_lat, rounded_lon, api_key)``:
#
#   * **Coordinate rounding**: four decimal places is roughly ~11 m of
#     precision — finer than any neighborhood / city / display_name string
#     LocationIQ returns at the zoom levels we use. A folder of photos taken
#     at one place therefore resolves to a single lookup.
#
#   * **API key in the key tuple**: changing the key through the settings
#     UI is self-invalidating. Old entries become unreachable and evict
#     naturally from the LRU.
#
#   * **LRU eviction at 4096 entries**: keeps memory bounded on long-running
#     servers — well above the unique-place count even for a heavily
#     travelled photo library.
#
# Successes *and* failures are cached. Caching failures avoids hammering
# the API when an entire folder is rendered with a bad key (401) or while
# rate-limited (429). Operators who fix the key go through
# ``set_locationiq_api_key`` (which already calls ``reload_config``) and
# the new key tuple naturally bypasses the stale entries.

_LOCATIONIQ_COORD_DECIMALS = 4
_LOCATIONIQ_CACHE_MAX = 4096
_locationiq_cache: OrderedDict[tuple, tuple] = OrderedDict()
_locationiq_cache_lock = threading.Lock()


def _locationiq_cache_key(lat: float, lon: float, api_key: str) -> tuple:
    """Build the cache key — rounded coords plus the API-key string."""
    return (
        round(lat, _LOCATIONIQ_COORD_DECIMALS),
        round(lon, _LOCATIONIQ_COORD_DECIMALS),
        api_key,
    )


def _locationiq_cache_get(key: tuple) -> tuple | None:
    with _locationiq_cache_lock:
        val = _locationiq_cache.get(key)
        if val is not None:
            _locationiq_cache.move_to_end(key)
        return val


def _locationiq_cache_put(key: tuple, value: tuple) -> None:
    with _locationiq_cache_lock:
        _locationiq_cache[key] = value
        _locationiq_cache.move_to_end(key)
        while len(_locationiq_cache) > _LOCATIONIQ_CACHE_MAX:
            _locationiq_cache.popitem(last=False)


def _esc(value: object) -> str:
    """Escape ``value`` for safe interpolation into HTML.

    EXIF and LocationIQ payloads are not trusted — every value crossing into
    the rendered drawer table must pass through here.
    """
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


def format_exif_metadata(
    slide_data: SlideSummary, metadata: dict, locationiq_api_key: str | None = None
) -> SlideSummary:
    """
    Format EXIF metadata dictionary into an HTML string.

    Args:
        slide_data (SlideSummary): Slide data to update
        metadata (dict): Metadata dictionary containing EXIF attributes.
        locationiq_api_key (Optional[str]): LocationIQ API key for map services

    Returns:
        SlideSummary: structured metadata appropriate for an image with EXIF data.
    """
    if not metadata:
        slide_data.description = "<i>No EXIF metadata available.</i>"
        return slide_data

    # Extract GPS coordinates if available
    gps_lat = metadata.get("GPSLatitudeDecimal")
    gps_lon = metadata.get("GPSLongitudeDecimal")

    # Build HTML table
    html_doc = """
    <div class='exif-metadata' style="display: flex; align-items: flex-start; gap: 18px; margin: 0; padding: 0;">
    """

    # Left column: GPS/location info (if available)
    error_msg = ""
    if gps_lat is not None and gps_lon is not None:
        google_maps_link = f"https://www.google.com/maps?q={gps_lat},{gps_lon}"

        coord_str = ""
        api_key_valid = False

        if locationiq_api_key:  # Only try if API key is provided
            (coord_str, error_msg) = get_locationiq_place_name(
                gps_lat, gps_lon, locationiq_api_key
            )
            # Check if the API key worked
            api_key_valid = coord_str is not None

        coord_str = coord_str if coord_str else f"{gps_lat:.6f}, {gps_lon:.6f}"

        # Only show static map if API key is available AND valid
        if locationiq_api_key and api_key_valid:
            static_map_url = _get_static_map_url(gps_lat, gps_lon, locationiq_api_key)
            map_html = f"""
            <div style="font-size:0.98em; margin:0; padding:0; text-align:left;">
                <a href="{google_maps_link}" target="_blank" style="display:block; margin:0; padding:0; color: white; text-decoration: none;">
                    <img src="{static_map_url}" alt="Static Map"
                         style="width:160px; height:120px; border:1.5px solid #bbb; border-radius:6px; margin:0; box-shadow:1px 1px 4px #ccc; display:block;">
                </a>
            </div>
            """
        elif locationiq_api_key and not api_key_valid:
            map_html = f'<div style="font-size:0.9em; color:#888; font-style:italic;">Map unavailable ({_esc(error_msg)})</div>'
        else:
            map_html = '<div style="font-size:0.9em; color:#888; font-style:italic;">Map unavailable (no API key)</div>'

        html_doc += f"""
        <div class='gps-info' style="min-width:180px; max-width:220px; margin:0; padding:0; text-align:left; vertical-align:top;">
            <div style="font-weight: bold; margin-bottom: 4px;">📍 Location</div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; font-size: 0.98em; margin-bottom: 6px;">
                    <a href="{google_maps_link}" target="_blank" style="color: white; text-decoration: none"
                       onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'" style="text-align: left;">{_esc(coord_str)}</a>
            </div>
            {map_html}
        </div>
        """
    else:
        # Still need a left column for alignment, even if empty
        html_doc += "<div class='gps-info' style='min-width:0px;'></div>"

    # Right column: EXIF table
    html_doc += "<div style='flex:1;'><table class='exif-table'>"

    # Prioritize important fields
    priority_fields = {
        "DateTime": "Date/Time",
        "Make": "Camera Make",
        "Model": "Camera Model",
        "Software": "Software",
        "FNumber": "Aperture",
        "ExposureTime": "Shutter Speed",
        "ISOSpeedRatings": "ISO",
        "FocalLength": "Focal Length",
        "Flash": "Flash",
        "WhiteBalance": "White Balance",
        "ImageWidth": "Width",
        "ImageLength": "Height",
        "GPSLatitudeDecimal": "GPS Latitude",
        "GPSLongitudeDecimal": "GPS Longitude",
        "GPSAltitude": "GPS Altitude",
        "GPSTimeStamp": "GPS Time",
    }

    # Add priority fields first. display_name comes from the hardcoded
    # priority_fields dict above, so it's already trusted; value comes from
    # the image's EXIF and must be escaped.
    for field, display_name in priority_fields.items():
        if field in metadata:
            value = _format_field_value(field, metadata[field])
            html_doc += f"<tr><th>{display_name}</th><td>{_esc(value)}</td></tr>"

    html_doc += "</table></div></div>"  # Close right column and flex container

    slide_data.description = html_doc
    return slide_data


def _format_field_value(field_name: str, value) -> str:
    """Format specific EXIF field values for better readability."""

    if value is None:
        return "N/A"

    # Handle specific field formatting
    if field_name == "ExposureTime":
        if isinstance(value, int | float) and value < 1:
            return f"1/{int(1/value)}s"
        return f"{value}s"

    elif field_name == "FNumber":
        return f"f/{value}"

    elif field_name == "FocalLength":
        return f"{value}mm"

    elif field_name in ["GPSLatitudeDecimal", "GPSLongitudeDecimal"]:
        return f"{value:.6f}°"

    elif field_name == "GPSAltitude":
        return f"{value}m"

    elif field_name == "Flash":
        # Flash values are bit flags, provide readable interpretation
        flash_modes = {
            0: "No Flash",
            1: "Flash Fired",
            5: "Flash Fired, Return not detected",
            7: "Flash Fired, Return detected",
            9: "Flash Fired, Compulsory Flash Mode",
            13: "Flash Fired, Compulsory Flash Mode, Return not detected",
            15: "Flash Fired, Compulsory Flash Mode, Return detected",
            16: "No Flash, Compulsory Flash Suppression",
            24: "No Flash, Auto",
            25: "Flash Fired, Auto",
            29: "Flash Fired, Auto, Return not detected",
            31: "Flash Fired, Auto, Return detected",
            32: "No Flash Available",
        }
        return flash_modes.get(value, f"Flash Mode {value}")

    elif field_name == "WhiteBalance":
        wb_modes = {0: "Auto", 1: "Manual"}
        return wb_modes.get(value, f"Mode {value}")

    elif field_name in ["ImageWidth", "ImageLength"]:
        return f"{value} pixels"

    # Default formatting for other fields
    if isinstance(value, float):
        return f"{value:.2f}"

    return str(value)


def _get_static_map_url(latitude, longitude, api_key, width=200, height=150, zoom=8):
    return (
        f"https://maps.locationiq.com/v3/staticmap"
        f"?key={api_key}"
        f"&center={latitude},{longitude}"
        f"&zoom={zoom}"
        f"&size={width}x{height}"
        f"&markers=icon:small-red-cutout|{latitude},{longitude}"
    )


def get_locationiq_place_name(latitude, longitude, api_key):
    """Reverse-geocode a coordinate to a place name via LocationIQ.

    Cached at ~11 m resolution (four decimal places of latitude /
    longitude), keyed by the supplied API key. Adjacent photos taken at
    the same place therefore share a single network round-trip; changing
    the API key bypasses old entries automatically.

    Returns:
        tuple[str | None, str]: ``(place_name, status_message)``.
        ``place_name`` is ``None`` on every non-200 response or transport
        failure; ``status_message`` is ``"ok"`` on success and a short
        diagnostic string otherwise.
    """
    key = _locationiq_cache_key(latitude, longitude, api_key)
    cached = _locationiq_cache_get(key)
    if cached is not None:
        return cached

    result = _fetch_locationiq_place_name(latitude, longitude, api_key)
    _locationiq_cache_put(key, result)
    return result


def _fetch_locationiq_place_name(latitude, longitude, api_key):
    """Issue the actual reverse-geocode request. Used by
    :func:`get_locationiq_place_name`; not intended to be called directly
    by anything else — bypasses the LRU cache."""
    url = "https://us1.locationiq.com/v1/reverse"
    params = {"key": api_key, "lat": latitude, "lon": longitude, "format": "json"}
    headers = {"User-Agent": "ClipSlide/1.0 (Image Slideshow Application)"}

    try:
        response = requests.get(url, params=params, headers=headers, timeout=5)

        if response.status_code == 200:
            data = response.json()
            return (data.get("display_name"), "ok")
        elif response.status_code == 401:
            # Unauthorized - invalid API key
            logger.warning("LocationIQ API key is invalid (401 Unauthorized)")
            return (None, "unauthorized")
        elif response.status_code == 403:
            # Forbidden - API key might be expired or quota exceeded
            logger.warning(
                "LocationIQ API access forbidden (403) - check API key and quota"
            )
            return (None, "access forbidden")
        elif response.status_code == 429:
            # Too Many Requests - rate limit exceeded
            logger.warning(
                "LocationIQ API rate limit exceeded (429 Too Many Requests)"
            )
            return (None, "rate limit exceeded")
        else:
            logger.warning(
                f"LocationIQ reverse geocoding failed with status {response.status_code}"
            )
            return (None, f"Error {response.status_code}")

    except requests.exceptions.Timeout:
        logger.warning("LocationIQ reverse geocoding timed out")
        return (None, "timeout while fetching")
    except requests.exceptions.RequestException as e:
        logger.warning(f"LocationIQ reverse geocoding failed: {e}")
        return (None, f"fetch error {e}")
    except Exception as e:
        logger.warning(f"LocationIQ reverse geocoding failed: {e}")
        return (None, f"misc error {e}")
