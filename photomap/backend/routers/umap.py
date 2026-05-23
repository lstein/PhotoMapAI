# UMAP Routes

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sklearn.cluster import DBSCAN

from ..config import get_config_manager
from .album import AlbumDep, EmbeddingsDep

umap_router = APIRouter()
config_manager = get_config_manager()


@umap_router.get("/umap_data/{album_key}", tags=["UMAP"])
async def get_umap_data(
    album_key: str,
    album_config: AlbumDep,
    embeddings: EmbeddingsDep,
    cluster_eps: float | None = None,
    cluster_min_samples: int = 10,
) -> JSONResponse:
    """
    Get UMAP coordinates for all images in an album.

    Args:
        album_key: The key of the album to retrieve data for.
        cluster_eps: Epsilon parameter for DBSCAN clustering. Omit (or send
            ``None``) to use the album's persisted ``umap_eps`` from YAML.
        cluster_min_samples: Min samples parameter for DBSCAN clustering.

    Returns:
        JSONResponse containing a list of points with x, y, index, and cluster ID.
    """
    # When the caller doesn't override eps, fall back to the album's
    # persisted ``umap_eps``. This used to be dead code: the parameter
    # defaulted to ``0.07``, so ``cluster_eps is not None`` was always
    # true and ``album_config.umap_eps`` was silently ignored. The
    # corresponding parameter on ``/cluster_labels`` is kept in lockstep
    # so the two endpoints resolve identical eps values for the same
    # request — otherwise the cluster IDs they return would disagree
    # and the hover-label feature would break.
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
            zip(umap_embeddings[:, 0], umap_embeddings[:, 1], labels, strict=False)
        )
    ]
    return JSONResponse(points)
