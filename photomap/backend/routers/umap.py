# UMAP Routes

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sklearn.cluster import DBSCAN

from ..config import get_config_manager
from ..constants import DEFAULT_ALBUM
from .album import get_embeddings_for_album

umap_router = APIRouter()
config_manager = get_config_manager()


@umap_router.get("/umap_data/{album_key}", tags=["UMAP"])
async def get_umap_data(
    album_key: str,
    cluster_eps: float = 0.07,
    cluster_min_samples: int = 10,
) -> JSONResponse:
    # Instantiate your Embeddings object (adjust path as needed)
    embeddings = get_embeddings_for_album(album_key)
    album_config = config_manager.get_album(album_key)
    cluster_eps = cluster_eps if cluster_eps is not None else album_config.umap_eps

    # Load cached UMAP embeddings (will compute/cache if missing)
    umap_embeddings = embeddings.umap_embeddings
    embeddings = embeddings.open_cached_embeddings(embeddings.embeddings_path)
    filenames = embeddings["filenames"]
    filename_map = embeddings["filename_map"]

    # Cluster with DBSCAN
    if umap_embeddings.shape[0] > 0:
        clustering = DBSCAN(eps=cluster_eps, min_samples=cluster_min_samples).fit(
            umap_embeddings
        )
        labels = clustering.labels_
    else:
        labels = np.array([])

    # Prepare data for frontend
    points = [
        {
            "x": float(x),
            "y": float(y),
            "index": int(
                filename_map[filenames[idx]]
            ),  # map from unsorted to sorted indices
            "cluster": int(cluster),
        }
        for idx, (x, y, cluster) in enumerate(
            zip(umap_embeddings[:, 0], umap_embeddings[:, 1], labels)
        )
    ]
    return JSONResponse(points)
