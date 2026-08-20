# UMAP Routes

import asyncio
from pathlib import Path

import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sklearn.cluster import DBSCAN

from ..cluster_eps import resolve_album_cluster_eps
from ..config import get_config_manager
from ..media_types import media_type_for
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
            ``None``) to use the album's persisted ``umap_eps``, or — when
            that has never been set — a value derived from the album's own
            coordinates.
        cluster_min_samples: Min samples parameter for DBSCAN clustering.

    Returns:
        JSONResponse containing a list of points with x, y, index, and cluster ID.
    """
    # Load cached UMAP embeddings (will compute/cache if missing). Threaded
    # because "compute if missing" is a full UMAP fit, which is minutes on a
    # large album: the map is fetched in parallel with /cluster_labels, so
    # leaving this one on the event loop would stall the server no matter what
    # the other endpoint does.
    umap_embeddings = await asyncio.to_thread(lambda: embeddings.umap_embeddings)

    # Resolve eps against the coordinates: query parameter, else the album's
    # persisted value, else derived. ``/cluster_labels`` resolves through the
    # same helper for the same request — if the two disagree, the cluster ids
    # they return refer to different clusterings and the hover labels attach
    # to the wrong blobs.
    # Threaded: deriving an eps runs several DBSCAN fits, seconds of CPU on a
    # large album, and this endpoint is fetched while the map is opening.
    cluster_eps = await asyncio.to_thread(
        resolve_album_cluster_eps,
        umap_embeddings,
        Path(album_config.index).parent,
        cluster_eps,
        album_config.umap_eps,
        cluster_min_samples,
    )

    # Threaded for the same reason as the coordinates above: on a cache miss
    # this is a full np.load of the index, metadata unpickling included.
    embeddings = await embeddings.load_cached_embeddings()
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
            # Lets the map filter images/videos without a round-trip per
            # point. Derived from the suffix, which is already in hand here,
            # so indexes predating video support report "image" throughout
            # with no migration.
            "media": media_type_for(Path(str(filenames[idx]))),
        }
        for idx, (x, y, cluster) in enumerate(
            zip(umap_embeddings[:, 0], umap_embeddings[:, 1], labels, strict=False)
        )
    ]
    return JSONResponse(points)
