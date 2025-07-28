# UMAP Routes

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sklearn.cluster import DBSCAN
from ..constants import DEFAULT_ALBUM
from ..config import get_config_manager
from .album import get_embeddings_for_album

umap_router = APIRouter()
config_manager = get_config_manager()

@umap_router.get("/umap_data/", tags=["UMAP"])
async def get_umap_data(
    album: str = DEFAULT_ALBUM,
    cluster_eps: float = 0.07,
    cluster_min_samples: int = 10,
) -> JSONResponse:
    # Instantiate your Embeddings object (adjust path as needed)
    embeddings = get_embeddings_for_album(album)
    album_config = config_manager.get_album(album)
    cluster_eps = cluster_eps if cluster_eps is not None else album_config.umap_eps

    # Load cached UMAP embeddings (will compute/cache if missing)
    umap_embeddings = embeddings.umap_embeddings
    filenames = embeddings.open_cached_embeddings(embeddings.embeddings_path)[
        "filenames"
    ]

    # Cluster with DBSCAN 
    if umap_embeddings.shape[0] > 0:
        clustering = DBSCAN(eps=cluster_eps, min_samples=cluster_min_samples).fit(umap_embeddings)
        labels = clustering.labels_
    else:
        labels = np.array([])

    # Prepare data for frontend
    points = [
        {
            "x": float(x),
            "y": float(y),
            "filename": str(fname),
            "cluster": int(cluster),
        }
        for (x, y, fname, cluster) in zip(
            umap_embeddings[:, 0], umap_embeddings[:, 1], filenames, labels
        )
    ]
    return JSONResponse(points)
