#!/usr/bin/env python

import sys
import json
from PIL import Image

from photomap.backend.embeddings import Embeddings

for path in sys.argv[1:]:
    try:
        img = Image.open(path)
        metadata = Embeddings.extract_image_metadata(img)
        print(path)
        print(json.dumps(metadata, indent=4))
    except OSError as e:
        print(f"Can't open {path}: {str(e)}")
        continue
