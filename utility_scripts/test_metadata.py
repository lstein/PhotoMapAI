'''
Test metadata formatting.
'''

from pathlib import Path
from photomap.backend.embeddings import Embeddings

EMBEDDINGS = '/net/cubox/CineRAID/Archive/InvokeAI/2023/1/embeddings.npz'

embeddings = Embeddings(embeddings_path=Path(EMBEDDINGS))

path = None

for slide in embeddings.iterate_images():
    print(f"Image: {slide.filepath}")
    print(f"Metadata: {slide.description}")
    print()
