"""
metadata_extraction.py

Handles extraction of metadata from various image sources including:
- InvokeAI metadata
- Stable Diffusion metadata  
- EXIF data (including GPS coordinates)
"""

import json
from typing import Optional, Dict, Any
from PIL import Image, ExifTags


class MetadataExtractor:
    """Handles extraction of metadata from images."""
    
    @staticmethod
    def extract_image_metadata(pil_image: Image.Image) -> Dict[str, Any]:
        """
        Extract metadata from an image in order of preference.
        
        Args:
            pil_image: PIL Image object
            
        Returns:
            dict: Extracted metadata or empty dict if none found
        """
        # Define metadata extraction strategies in order of preference
        metadata_extractors = [
            ("invokeai_metadata", lambda img: json.loads(img.info["invokeai_metadata"])),
            ("Sd-metadata", lambda img: json.loads(img.info["Sd-metadata"])),
            ("sd-metadata", lambda img: json.loads(img.info["sd-metadata"])),
            ("exif", ExifExtractor.extract_exif_metadata),
        ]
        
        for key, extractor in metadata_extractors:
            if key in pil_image.info:
                try:
                    return extractor(pil_image)
                except (json.JSONDecodeError, Exception) as e:
                    print(f"Warning: Failed to parse {key} metadata: {e}")
                    continue
        
        return {}  # No metadata available


class ExifExtractor:
    """Handles EXIF data extraction and processing."""
    
    @staticmethod
    def extract_exif_metadata(pil_image: Image.Image) -> Dict[str, Any]:
        """Extract and format EXIF metadata from an image."""
        exif_data = pil_image.getexif()
        exif_dict = {}
        
        # First get the base exif tags
        for k, v in exif_data.items():
            tag_name = ExifTags.TAGS.get(k, f"UnknownTag_{k}")
            if isinstance(v, bytes):
                try:
                    v = v.decode('utf-8', errors='ignore')
                except:
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
                            except:
                                continue
                        if type(v) in [str, int, float, bool]:
                            exif_dict[tag_name] = v
                            
            except (KeyError, OSError, AttributeError):
                continue
            except Exception as e:
                print(f"Warning: Unexpected error reading IFD {ifd_id.name}: {e}")
                continue
                
        return exif_dict


class GPSExtractor:
    """Handles GPS coordinate extraction and conversion."""
    
    @staticmethod
    def extract_gps_data(gps_ifd) -> Dict[str, Any]:
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
            print(f"Warning: Failed to extract GPS data: {e}")
            return {}

    @staticmethod 
    def _convert_gps_coord(coord_tuple, ref) -> Optional[float]:
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
            print(f"Warning: Failed to convert GPS coordinate {coord_tuple}: {e}")
            return None