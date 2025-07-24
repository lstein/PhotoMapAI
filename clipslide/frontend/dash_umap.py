#!/usr/bin/env python

"""
Plot an embeddings file as a umap.
"""

# umap_dash_app.py
import os
import sys
import base64
import numpy as np
import pandas as pd
from PIL import Image, ImageOps
from io import BytesIO
from sklearn.cluster import DBSCAN, KMeans
import hashlib
from umap import UMAP
from pathlib import Path
import time
from contextlib import contextmanager

import dash
from dash import dcc, html, Input, Output, State
import plotly.express as px
from clipslide.backend.embeddings import Embeddings

# load embeddings and filenames
EMBEDDINGS_FILE = "/net/cubox/CineRAID/Pictures/clipslide/embeddings.npz"
embeddings_file = sys.argv[1] if len(sys.argv) > 1 else EMBEDDINGS_FILE

PLOT_HEIGHT = 800
MAX_COLORED_CLUSTERS = 75  # Maximum number of clusters to color distinctly

embeddings = Embeddings(embeddings_path=Path(embeddings_file))

@contextmanager
def elapsed_timer(label="Elapsed"):
    start = time.time()
    yield
    end = time.time()
    print(f"{label}: {end - start:.2f} seconds")

# --- Generate a hash for the embeddings file path ---
def hash_filename(filename):
    return hashlib.sha256(filename.encode("utf-8")).hexdigest()[:16]


umap_file = f"umap_2d_{hash_filename(embeddings_file)}.npy"

data = np.load(embeddings_file, allow_pickle=True)
clip_embeddings = data["embeddings"]
image_paths = data["filenames"]

assert clip_embeddings.shape[0] == len(image_paths)

# Optionally: run UMAP if not already saved, or if shape mismatch
if os.path.exists(umap_file):
    umap_embeddings = np.load(umap_file)
    if umap_embeddings.shape[0] != len(image_paths):
        print("UMAP file does not match embeddings. Regenerating...")
        reducer = UMAP(n_components=2)
        umap_embeddings = reducer.fit_transform(clip_embeddings)
        np.save(umap_file, umap_embeddings)
else:
    print("Running UMAP...")
    with elapsed_timer("UMAP fit_transform time"):
        reducer = UMAP(n_components=2)
        umap_embeddings = reducer.fit_transform(clip_embeddings)
        np.save(umap_file, umap_embeddings)
    print("UMAP embeddings saved to", umap_file)

# Build dataframe
df = pd.DataFrame(
    {
        "x": umap_embeddings[:, 0],  # type: ignore
        "y": umap_embeddings[:, 1],  # type: ignore
        "filename": image_paths,
    }
)

# Uncomment the following lines to use DBSCAN instead of KMeans
print("Running DBSCAN clustering...")
clustering = DBSCAN(eps=0.05, min_samples=5)
labels = clustering.fit_predict(umap_embeddings)
df["cluster"] = clustering.labels_

# Combine several qualitative color sets for more distinct colors
custom_colors = (
    px.colors.qualitative.Alphabet
    + px.colors.qualitative.Set1
    + px.colors.qualitative.Set2
    + px.colors.qualitative.Set3
    + px.colors.qualitative.Pastel1
    + px.colors.qualitative.Pastel2
    + px.colors.qualitative.Dark2
    + px.colors.qualitative.Vivid
)

# Make sure you have at least MAX_COLORED_CLUSTERS colors
custom_colors = custom_colors * ((MAX_COLORED_CLUSTERS // len(custom_colors)) + 1)
custom_colors = custom_colors[: max(MAX_COLORED_CLUSTERS, df["cluster"].max() + 1)]

fig = px.scatter(
    df,
    x="x",
    y="y",
    color="cluster",
    custom_data=["filename"],
    opacity=0.6,
    color_discrete_sequence=custom_colors,
)
fig.update_traces(marker=dict(size=4), hovertemplate="<span></span>")
fig.update_layout(
    height=PLOT_HEIGHT,
    title="CLIP Embeddings UMAP Explorer",
    dragmode="pan",
)

###
# Components of the display
###

# The spinner overlay displayed during searches and other updates.
dcc_loading = dcc.Loading(
    id="umap-loading",
    overlay_style={
        "background": "rgba(255,255,255,0.5)",
        "visibility": "visible",
        "filter": "blur(2px)",
    },
    type="default",  # or "default", "dot", "cube"
    fullscreen=False,  # covers the whole app; set to False for just the graph area
    children=[
        dcc.Graph(
            id="umap-plot",
            style={"width": "85vw", "height": PLOT_HEIGHT},
            config={"scrollZoom": True},
            clear_on_unhover=True,
        )
    ],
)

# The search buttons and sliders
dcc_controls = html.Div(
    [
        html.Div(
            [
                html.Label("Highlight cluster:", style={"marginBottom": "8px"}),
                dcc.Input(
                    id="highlight-cluster-input",
                    type="number",
                    min=-1,
                    max=int(df["cluster"].max()),
                    step=1,
                    value=-1,
                    style={"width": "100px"},
                ),
                html.Div(
                    "Enter -1 to show all clusters.",
                    style={
                        "fontSize": "12px",
                        "color": "#888",
                        "marginTop": "4px",
                        "marginBottom": "16px",
                    },
                ),
                dcc.Input(
                    id="text-search-input",
                    type="text",
                    placeholder="Search images by text...",
                    style={"width": "180px", "marginRight": "8px"},
                    autoComplete="off",
                ),
                html.Button(
                    "Text Search",
                    id="text-search-btn",
                    n_clicks=0,
                    style={"marginTop": "8px"},
                ),
                # --- Add Reset Search button here ---
                html.Button(
                    "Reset Search",
                    id="reset-search-btn",
                    n_clicks=0,
                    style={
                        "marginTop": "16px",
                        "backgroundColor": "red",
                        "color": "white",
                        "fontWeight": "bold",
                        "fontSize": "1.0em",
                        "width": "160px",
                        "border": "none",
                        "borderRadius": "6px",
                        "padding": "10px",
                        "cursor": "pointer",
                        "boxShadow": "0 2px 6px rgba(0,0,0,0.15)",
                    },
                ),
                # --- End Reset Search button ---
                html.Div(
                    [
                        html.Div(
                            [
                                html.Label(
                                    "DBSCAN eps:",
                                    style={"marginBottom": "8px"},
                                ),
                                dcc.Slider(
                                    id="eps-slider",
                                    min=0.01,
                                    max=0.3,
                                    step=0.01,
                                    value=0.05,
                                    marks={
                                        0.001: "0.001",
                                        0.01: "0.01",
                                        0.05: "0.05",
                                        0.1: "0.1",
                                        0.2: "0.2",
                                        0.3: "0.3",
                                    },
                                    tooltip={
                                        "placement": "bottom",
                                        "always_visible": True,
                                    },
                                    vertical=True,
                                    updatemode="drag",
                                ),
                            ],
                            style={
                                "display": "flex",
                                "flexDirection": "column",
                                "alignItems": "flex-start",
                                "height": int(PLOT_HEIGHT / 2),
                                "marginRight": "10px",
                            },
                        ),
                        html.Div(
                            [
                                html.Label(
                                    "DBSCAN min_samples:",
                                    style={"marginBottom": "8px"},
                                ),
                                dcc.Slider(
                                    id="min-samples-slider",
                                    min=1,
                                    max=20,
                                    step=1,
                                    value=5,
                                    marks={
                                        1: "1",
                                        5: "5",
                                        10: "10",
                                        20: "20",
                                    },
                                    tooltip={
                                        "placement": "bottom",
                                        "always_visible": True,
                                    },
                                    vertical=True,
                                    updatemode="drag",
                                ),
                            ],
                            style={
                                "display": "flex",
                                "flexDirection": "column",
                                "alignItems": "flex-start",
                                "height": int(PLOT_HEIGHT / 2),
                                "marginLeft": "10px",
                            },
                        ),
                    ],
                    style={
                        "display": "flex",
                        "flexDirection": "row",
                        "justifyContent": "flex-start",
                        "alignItems": "flex-start",
                        "marginTop": "16px",
                    },
                ),
            ],
            style={
                "display": "flex",
                "flexDirection": "column",
                "alignItems": "flex-start",
                "marginRight": "10px",
            },
        ),
    ],
    id="controls-container",
)

# the hover image container
dcc_hover = html.Div(
    id="hover-image-container",
    style={"position": "absolute", "pointerEvents": "none", "zIndex": 1000},
    children=[],
)

# The modal dialogue for displaying full-size images
dcc_modal = html.Div(
    id="modal",
    n_clicks=0,
    style={
        "display": "none",
        "position": "fixed",
        "top": 0,
        "left": 0,
        "width": "100vw",
        "height": "100vh",
        "backgroundColor": "rgba(0,0,0,0.7)",
        "justifyContent": "center",
        "alignItems": "center",
        "zIndex": 2000,
    },
    children=[
        html.Div(
            id="modal-content",
            style={
                "background": "#fff",
                "padding": "30px",
                "borderRadius": "8px",
                "boxShadow": "0 2px 8px rgba(0,0,0,0.3)",
                "maxWidth": "90vw",
                "maxHeight": "90vh",
                "display": "flex",
                "flexDirection": "column",
                "alignItems": "center",
                "position": "relative",  # Needed for absolute positioning of close icon
            },
            children=[
                # "X" close icon in the upper right
                html.Button(
                    "×",
                    id="close-modal",
                    n_clicks=0,
                    style={
                        "position": "absolute",
                        "top": "8px",
                        "right": "8px",
                        "background": "none",
                        "border": "none",
                        "fontSize": "2rem",
                        "fontWeight": "bold",
                        "color": "#888",
                        "cursor": "pointer",
                        "zIndex": 10,
                        "lineHeight": "1",
                        "padding": "0",
                    },
                    title="Close",
                ),
                html.Img(
                    id="modal-image",
                    style={
                        "maxWidth": "600px",
                        "maxHeight": "80vh",
                        "marginBottom": "20px",
                    },
                ),
                html.Div(
                    children=[
                        html.Button(
                            "Find Similar",
                            id="find-similar-btn",
                            n_clicks=0,
                            style={"marginBottom": "10px"},
                        ),
                    ],
                    style={"flexDirection": "row"},
                ),
            ],
        )
    ],
)

# set the title of the app
app = dash.Dash(__name__)

# Here's the main layout of the app.
app.layout = html.Div(
    [
        html.Div(
            [
                dcc_loading,
                dcc_controls,
            ],
            id="main-container",
        ),
        dcc_hover,
        dcc_modal,
        dcc.Store(id="search-matches"),
        dcc.Store(id="modal-image-path"),
    ]
)


# --- Update the callback to use the slider value instead of the text input ---
@app.callback(
    Output("umap-plot", "figure"),
    Input("eps-slider", "value"),
    Input("min-samples-slider", "value"),
    Input("highlight-cluster-input", "value"),
    Input("search-matches", "data"),
)
def update_clusters(eps, min_samples, highlight_cluster, search_matches):
    clustering = DBSCAN(eps=eps, min_samples=min_samples).fit(umap_embeddings)
    df["cluster_orig"] = clustering.labels_
    cluster_counts = (
        df[df["cluster_orig"] != -1]["cluster_orig"]
        .value_counts()
        .sort_values(ascending=False)
    )
    cluster_map = {old: new for new, old in enumerate(cluster_counts.index)}
    df["cluster"] = df["cluster_orig"].map(cluster_map).fillna(-1).astype(int)
    max_cluster = df["cluster"].max()
    try:
        highlight = int(highlight_cluster)
    except Exception:
        highlight = -1

    # --- Highlight search matches if present ---
    if search_matches and len(search_matches) > 0:
        color = df["filename"].apply(
            lambda fname: "red" if fname in search_matches else "rgba(200,200,200,0.4)"
        )
        fig = px.scatter(
            df,
            x="x",
            y="y",
            custom_data=["filename"],
            opacity=0.9,
        )
        fig.update_traces(marker=dict(color=color))
        fig.update_layout(showlegend=False)
    elif highlight != -1 and 0 <= highlight <= max_cluster:
        color = df["cluster"].apply(
            lambda c: "red" if c == highlight else "rgba(200,200,200,0.4)"
        )
        fig = px.scatter(
            df,
            x="x",
            y="y",
            custom_data=["filename"],
            opacity=0.8,
        )
        fig.update_traces(marker=dict(color=color))
        fig.update_layout(showlegend=False)
    else:
        # Compute cluster sizes
        cluster_sizes = df["cluster"].value_counts()
        # Map cluster number to color (grey if small, else from palette)
        # Noise  clusters are colored grey as well
        color_map = {
            c: (
                "rgba(200,200,200,0.4)"
                if cluster_sizes[c] < MAX_COLORED_CLUSTERS or c == -1
                else custom_colors[c % len(custom_colors)]
            )
            for c in df["cluster"].unique()
        }
        color = df["cluster"].map(color_map)
        fig = px.scatter(
            df,
            x="x",
            y="y",
            custom_data=["filename"],
            opacity=0.6,
        )
        fig.update_traces(marker=dict(color=color))
        fig.update_layout(
            height=800,
            title=f"CLIP Embeddings UMAP Explorer (eps={eps}, min_samples={min_samples})",
            dragmode="pan",
        )

    # Zoom to include 98% of points
    x_min, x_max = np.percentile(df["x"], [1, 99])
    y_min, y_max = np.percentile(df["y"], [1, 99])
    fig.update_xaxes(range=[x_min, x_max])
    fig.update_yaxes(range=[y_min, y_max])

    return fig


# === Callback to display image thumbnail on hover ===
@app.callback(
    Output("hover-image-container", "children"),
    Input("umap-plot", "hoverData"),
)
def update_hover_image(hover_data):
    if hover_data is None:
        return "", False
    point = hover_data["points"][0]
    filename = point["customdata"][0]
    idx = point["pointIndex"]
    cluster = str(df.iloc[idx]["cluster"])
    if cluster == "-1":
        cluster = "Noise"
    thumbnail = encode_image_to_base64(filename, size=(250, 250))
    x0, y0 = point["bbox"]["x0"], point["bbox"]["y0"]
    left = int(x0) + 10
    top = int(y0) + 30
    hover_div = html.Div(
        [
            html.Div(
                f"Cluster: {cluster}",
                style={
                    "textAlign": "center",
                    "fontWeight": "bold",
                    "marginBottom": "4px",
                    "background": "white",
                    "borderRadius": "4px",
                    "padding": "2px 4px",
                },
            ),
            html.Img(
                src=thumbnail,
                style={"width": "250px", "border": "1px solid #ccc"},
            ),
        ],
        style={
            "position": "fixed",
            "top": f"{top}px",
            "left": f"{left}px",
            "width": "250px",
            "zIndex": 1000,
            "pointerEvents": "none",
            "background": "none",
        },
    )
    return hover_div


@app.callback(
    Output("modal", "style"),
    Output("modal-image", "src"),
    Output("modal-image-path", "data"),
    Input("umap-plot", "clickData"),
    Input("close-modal", "n_clicks"),
    Input("find-similar-btn", "n_clicks"),
    Input("modal", "n_clicks"),
    State("modal", "style"),
    prevent_initial_call=True,
)
def show_modal(
    clickData, close_clicks, find_similar_clicks, modal_bg_clicks, modal_style
):
    ctx = dash.callback_context
    if not ctx.triggered:
        raise dash.exceptions.PreventUpdate

    trigger = ctx.triggered[0]["prop_id"].split(".")[0]
    if trigger in ["close-modal", "find-similar-btn", "modal"]:
        # Hide modal
        style = modal_style.copy() if modal_style else {}
        style["display"] = "none"
        return style, "", ""
    elif trigger == "umap-plot" and clickData:
        filename = clickData["points"][0]["customdata"][0]
        img_src = encode_image_to_base64(filename, size=(600, 600))
        style = modal_style.copy() if modal_style else {}
        style["display"] = "flex"
        return style, img_src, filename
    else:
        raise dash.exceptions.PreventUpdate


def encode_image_to_base64(path, size=(64, 64)):
    try:
        img = Image.open(path).convert("RGB")
        img = ImageOps.exif_transpose(img)  # <-- Correct orientation using EXIF
        img.thumbnail(size)
        buffer = BytesIO()
        img.save(buffer, format="PNG")
        base64_img = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{base64_img}"
    except Exception as e:
        print(f"Failed to load image {path}: {e}")
        return "Image error"


@app.callback(
    Output("search-matches", "data"),
    Input("text-search-btn", "n_clicks"),
    Input("text-search-input", "n_submit"),
    Input("find-similar-btn", "n_clicks"),
    Input("reset-search-btn", "n_clicks"),  # <-- Add this line
    State("text-search-input", "value"),
    State("modal-image-path", "data"),
    prevent_initial_call=True,
)
def update_search_matches(
    text_btn, text_submit, find_similar_btn, reset_btn, text_query, image_path
):
    ctx = dash.callback_context
    if not ctx.triggered:
        raise dash.exceptions.PreventUpdate

    trigger = ctx.triggered[0]["prop_id"].split(".")[0]

    if trigger == "reset-search-btn":
        return []
    elif trigger in ["text-search-btn", "text-search-input"]:
        if not text_query:
            return []
        filenames, scores = embeddings.search_images_by_text(
            text_query, top_k=200
        )
        filenames = [f for f, s in zip(filenames, scores) if s > 0.2]
        return list(filenames)
    elif trigger == "find-similar-btn":
        if not image_path:
            return []
        filenames, scores = embeddings.search_images_by_similarity(
            Path(image_path), top_k=200
        )
        # Return only filenames that have a score above a threshold of 0.6
        filenames = [f for f, s in zip(filenames, scores) if s > 0.6]
        return list(filenames)
    else:
        raise dash.exceptions.PreventUpdate

def main():
    # Run the app
    print("Starting UMAP Dash app on port 8060...")
    app.run(debug=True, host="0.0.0.0", port=8060)
