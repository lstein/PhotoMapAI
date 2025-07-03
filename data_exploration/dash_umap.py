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
from PIL import Image
from io import BytesIO
from sklearn.cluster import DBSCAN, KMeans
import hashlib
from cuml import UMAP
from cuml.cluster import DBSCAN

import dash
from dash import dcc, html, Input, Output, State
import plotly.express as px

# load embeddings and filenames
EMBEDDINGS_FILE = "/net/cubox/CineRAID/Archive/InvokeAI/embeddings.npz"
embeddings_file = sys.argv[1] if len(sys.argv) > 1 else EMBEDDINGS_FILE


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
    reducer = UMAP(n_components=2)
    umap_embeddings = reducer.fit_transform(clip_embeddings)
    np.save(umap_file, umap_embeddings)

# Fit DBSCAN on the 2D UMAP embeddings

# Build dataframe
df = pd.DataFrame(
    {
        "x": umap_embeddings[:, 0],  # type: ignore
        "y": umap_embeddings[:, 1],  # type: ignore
        "filename": image_paths,
    }
)

# kmeans = KMeans(n_clusters=20, random_state=0).fit(umap_embeddings)
# df["cluster"] = kmeans.labels_z

# Uncomment the following lines to use DBSCAN instead of KMeans
clustering = DBSCAN(eps=0.05, min_samples=5)
labels = clustering.fit_predict(umap_embeddings)
df["cluster"] = clustering.labels_

# === Build Dash App ===
app = dash.Dash(__name__)
server = app.server  # for deployment if needed

fig = px.scatter(
    df,
    x="x",
    y="y",
    color="cluster",
    custom_data=["filename"],
    opacity=0.6,
    # color_continuous_scale="Viridis"  # or any other scale you like
    color_discrete_sequence=px.colors.qualitative.Set1,
)
fig.update_traces(marker=dict(size=4))
fig.update_layout(height=800, title="CLIP Embeddings UMAP Explorer")

app.layout = html.Div(
    [
        html.Div(
            [
                dcc.Graph(
                    id="umap-plot",
                    style={"width": "85vw", "height": "90vh"},
                    config={"scrollZoom": True},
                    clear_on_unhover=True,
                ),
                html.Div(
                    [
                        html.Label("DBSCAN eps:"),
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
                            tooltip={"placement": "bottom", "always_visible": True},
                            vertical=True,
                            updatemode="drag",
                        ),
                        html.Label("DBSCAN min_samples:"),
                        dcc.Slider(
                            id="min-samples-slider",
                            min=1,
                            max=20,
                            step=1,
                            value=5,
                            marks={1: "1", 5: "5", 10: "10", 20: "20"},
                            tooltip={"placement": "bottom", "always_visible": True},
                            vertical=True,
                            updatemode="drag",
                        ),
                        html.Label("Highlight cluster:"),
                        dcc.Input(
                            id="highlight-cluster",
                            type="text",
                            placeholder="Enter cluster #",
                            debounce=True,
                            style={"width": "100px", "marginTop": "20px"},
                        ),
                    ],
                    style={
                        "display": "flex",
                        "flexDirection": "column",
                        "justifyContent": "center",
                        "alignItems": "center",
                        "height": "90vh",
                        "marginLeft": "20px",
                        "gap": "40px",
                    },
                ),
            ],
            style={
                "display": "flex",
                "flexDirection": "row",
                "alignItems": "flex-start",
            },
        ),
        html.Div(
            id="hover-image-container",
            style={"position": "absolute", "pointerEvents": "none", "zIndex": 1000},
            children=[],
        ),
        html.Div(
            id="modal",
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
                        "padding": "20px",
                        "borderRadius": "8px",
                        "boxShadow": "0 2px 8px rgba(0,0,0,0.3)",
                        "maxWidth": "90vw",
                        "maxHeight": "90vh",
                        "display": "flex",
                        "flexDirection": "column",
                        "alignItems": "center",
                    },
                    children=[
                        html.Img(
                            id="modal-image",
                            style={
                                "maxWidth": "600px",
                                "maxHeight": "80vh",
                                "marginBottom": "20px",
                            },
                        ),
                        html.Button("Close", id="close-modal", n_clicks=0),
                    ],
                )
            ],
        ),
    ]
)


@app.callback(
    Output("umap-plot", "figure"),
    Input("eps-slider", "value"),
    Input("min-samples-slider", "value"),
    Input("highlight-cluster", "value"),
)
def update_clusters(eps, min_samples, highlight_cluster):
    clustering = DBSCAN(eps=eps, min_samples=min_samples).fit(umap_embeddings)
    df["cluster_orig"] = clustering.labels_

    # Exclude noise (-1) from relabeling, but keep it as -1
    cluster_counts = (
        df[df["cluster_orig"] != -1]["cluster_orig"]
        .value_counts()
        .sort_values(ascending=False)
    )
    cluster_map = {old: new for new, old in enumerate(cluster_counts.index)}
    # Map noise to -1
    df["cluster"] = df["cluster_orig"].map(cluster_map).fillna(-1).astype(int)

    max_cluster = df["cluster"].max()
    try:
        highlight = (
            int(highlight_cluster) if highlight_cluster not in (None, "") else None
        )
    except Exception:
        highlight = None

    if highlight is not None and 0 <= highlight <= max_cluster:
        # Highlight selected cluster in red, others in semi-transparent grey
        color = df["cluster"].apply(
            lambda c: "red" if c == highlight else "rgba(200,200,200,0.4)"
        )
        fig = px.scatter(
            df,
            x="x",
            y="y",
            # color=color,
            custom_data=["filename"],
            opacity=0.8,
        )
        fig.update_traces(marker=dict(color=color))
        fig.update_layout(showlegend=False)
    else:
        # Default: color by cluster
        fig = px.scatter(
            df,
            x="x",
            y="y",
            color="cluster",
            custom_data=["filename"],
            opacity=0.6,
            color_discrete_sequence=px.colors.qualitative.Set1,
        )
    fig.update_traces(
        marker=dict(size=4), hovertemplate="<span></span>"
    )  # This disables the default hover box with x, y
    fig.update_layout(
        height=800,
        title=f"CLIP Embeddings UMAP Explorer (eps={eps}, min_samples={min_samples})",
    )
    return fig


# === Callback to display image thumbnail on hover ===
@app.callback(
    Output("hover-image-container", "children"),
    Input("umap-plot", "hoverData"),
)
def update_hover_image(hover_data):
    if hover_data is None:
        return ""
    point = hover_data["points"][0]
    filename = point["customdata"][0]
    cluster = point.get("marker.color", None)
    if cluster is None and "curveNumber" in point:
        idx = point["pointIndex"]
        cluster = str(df.iloc[idx]["cluster"])
    else:
        cluster = str(cluster)
    thumbnail = encode_image_to_base64(filename, size=(128, 128))
    x0, y0 = point["bbox"]["x0"], point["bbox"]["y0"]
    left = int(x0) + 10
    top = int(y0) + 10
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
                style={"width": "128px", "border": "1px solid #ccc"},
            ),
        ],
        style={
            "position": "fixed",
            "top": f"{top}px",
            "left": f"{left}px",
            "width": "128px",
            "zIndex": 1000,
            "pointerEvents": "none",
            "background": "none",
        },
    )
    return hover_div


@app.callback(
    Output("modal", "style"),
    Output("modal-image", "src"),
    Input("umap-plot", "clickData"),
    Input("close-modal", "n_clicks"),
    State("modal", "style"),
    prevent_initial_call=True,
)
def show_modal(clickData, close_clicks, modal_style):
    ctx = dash.callback_context
    if not ctx.triggered:
        raise dash.exceptions.PreventUpdate

    trigger = ctx.triggered[0]["prop_id"].split(".")[0]
    if trigger == "close-modal":
        # Hide modal
        style = modal_style.copy() if modal_style else {}
        style["display"] = "none"
        return style, ""
    elif trigger == "umap-plot" and clickData:
        filename = clickData["points"][0]["customdata"][0]
        img_src = encode_image_to_base64(filename, size=(600, 600))
        style = modal_style.copy() if modal_style else {}
        style["display"] = "flex"
        return style, img_src
    else:
        raise dash.exceptions.PreventUpdate


def encode_image_to_base64(path, size=(64, 64)):
    try:
        img = Image.open(path).convert("RGB")
        img.thumbnail(size)
        buffer = BytesIO()
        img.save(buffer, format="PNG")
        base64_img = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{base64_img}"
    except Exception as e:
        print(f"Failed to load image {path}: {e}")
        return "Image error"


# === Run the app ===
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8050)
