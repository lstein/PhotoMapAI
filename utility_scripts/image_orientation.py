#!/usr/bin/env python

import sys
from PIL import Image, ExifTags

img = Image.open(sys.argv[1])

# Get the EXIF data
exif = img._getexif()
if exif is not None:
    # Find the orientation tag code
    for tag, value in exif.items():
        tag_name = ExifTags.TAGS.get(tag, tag)
        if tag_name == "Orientation":
            print(f"EXIF Orientation: {value}")
else:
    print("No EXIF data found.")
