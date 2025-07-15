#!/usr/bin/env python

'''
Plot an embeddings file as a umap.
'''

import numpy as np
import pandas as pd
import umap
import plotly.express as px
from PIL import Image
from io import BytesIO
import base64
import os
import sys

EMBEDDINGS_FILE = '/net/cubox/CineRAID/Archive/InvokeAI/embeddings.npz'
embeddings_file = sys.argv[1] if len(sys.argv) > 1 else EMBEDDINGS_FILE

data = np.load(embeddings_file, allow_pickle=True)
clip_embeddings = data['embeddings']
image_paths = data['filenames']

assert len(image_paths) == clip_embeddings.shape[0]

print("Running UMAP...")
reducer = umap.UMAP(n_components=2, random_state=42)
embedding_2d = reducer.fit_transform(clip_embeddings)

def encode_image_to_base64(path, size=(64, 64)):
    try:
        img = Image.open(path).convert("RGB")
        img.thumbnail(size)
        buffer = BytesIO()
        img.save(buffer, format="PNG")
        base64_img = base64.b64encode(buffer.getvalue()).decode()
        return f'<img src="data:image/png;base64,{base64_img}">'
    except Exception as e:
        print(f"Failed to load image {path}: {e}")
        return "Image error"

print("Encoding thumbnails...")
thumbnail_htmls = [encode_image_to_base64(path) for path in image_paths]

print("Building dataframe...")
df = pd.DataFrame({
    "x": embedding_2d[:, 0],
    "y": embedding_2d[:, 1],
    "path": image_paths,
    "thumbnail": thumbnail_htmls
})

print("Plotting umap...")
fig = px.scatter(
    df,
    x="x",
    y="y",
    hover_name="path",
    hover_data={"thumbnail": True, "x": False, "y": False}
)

# Customize marker size and hover style
fig.update_traces(marker=dict(size=4, opacity=0.7))
fig.update_layout(
    hoverlabel=dict(bgcolor="white"),
    title="CLIP Embeddings UMAP with Thumbnails",
    width=1000,
    height=800
)

fig.show()
