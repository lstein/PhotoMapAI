"""
backend.metadata.exif

Format EXIF metadata for images, including human-readable tags.
Returns an HTML representation of the EXIF data.
"""

from logging import getLogger
from pathlib import Path
from typing import Optional, Tuple

import requests

from .slide_summary import SlideSummary

logger = getLogger(__name__)


def format_exif_metadata(
    slide_data: SlideSummary, metadata: dict, locationiq_api_key: Optional[str] = None
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
    html = """
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
            map_html = f'<div style="font-size:0.9em; color:#888; font-style:italic;">Map unavailable ({error_msg})</div>'
        else:
            map_html = '<div style="font-size:0.9em; color:#888; font-style:italic;">Map unavailable (no API key)</div>'

        html += f"""
        <div class='gps-info' style="min-width:180px; max-width:220px; margin:0; padding:0; text-align:left; vertical-align:top;">
            <div style="font-weight: bold; margin-bottom: 4px;">📍 Location</div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; font-size: 0.98em; margin-bottom: 6px;">
                    <a href="{google_maps_link}" target="_blank" style="color: white; text-decoration: none"
                       onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'" style="text-align: left;">{coord_str}</a>
            </div>
            {map_html}
        </div>
        """
    else:
        # Still need a left column for alignment, even if empty
        html += "<div class='gps-info' style='min-width:0px;'></div>"

    # Right column: EXIF table
    html += "<div style='flex:1;'><table class='exif-table'>"

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

    # Add priority fields first
    for field, display_name in priority_fields.items():
        if field in metadata:
            value = _format_field_value(field, metadata[field])
            html += f"<tr><th>{display_name}</th><td>{value}</td></tr>"

    html += "</table></div></div>"  # Close right column and flex container

    slide_data.description = html
    return slide_data


def _format_field_value(field_name: str, value) -> str:
    """Format specific EXIF field values for better readability."""

    if value is None:
        return "N/A"

    # Handle specific field formatting
    if field_name == "ExposureTime":
        if isinstance(value, (int, float)) and value < 1:
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
    """Get place name from LocationIQ API.

    Returns:
        str: Place name if successful
        None: If API key is invalid or request fails
    """
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
            logger.warning(f"LocationIQ API key is invalid (401 Unauthorized)")
            return (None, "unauthorized")
        elif response.status_code == 403:
            # Forbidden - API key might be expired or quota exceeded
            logger.warning(
                f"LocationIQ API access forbidden (403) - check API key and quota"
            )
            return (None, "access forbidden")
        elif response.status_code == 429:
            # Too Many Requests - rate limit exceeded
            logger.warning(
                f"LocationIQ API rate limit exceeded (429 Too Many Requests)"
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
