# UMAP Routes

import asyncio
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from sklearn.cluster import DBSCAN

from ..cluster_eps import MIN_CLUSTER_EPS, resolve_album_cluster_eps
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
    # Same bounds as the stored value: a query parameter the map cannot be
    # clustered with should be a 422 naming the field, not a 500 out of
    # sklearn. MIN_CLUSTER_EPS rather than "positive" because that is the
    # floor resolve_cluster_eps applies anyway — accepting anything under it
    # would cluster at one number while the caller was told another.
    cluster_eps: Annotated[float | None, Query(ge=MIN_CLUSTER_EPS, allow_inf_nan=False)] = None,
    cluster_min_samples: Annotated[int, Query(ge=1)] = 10,
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
        JSONResponse ``{"points": [...], "eps": float, "requested_eps": float | None}``.
        Each point carries x, y, index, cluster ID and media type. ``eps`` is
        the strength the points were actually clustered with;
        ``requested_eps`` is the number that was asked for (the query
        parameter, else the album's stored value), or ``None`` when the
        strength was derived. The two differ when the album is too large to
        cluster at the requested strength within the memory budget, and the
        UI has no other way to find that out.
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
    requested_eps = cluster_eps if cluster_eps is not None else album_config.umap_eps
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
    # The resolved eps goes back with the points because it can differ from
    # the requested one: the pair budget shrinks any value an album cannot
    # afford, typed or not, and that ceiling depends on the point cloud — the
    # client cannot predict it, so without this the Cluster Strength control
    # would go on showing a number the map was never clustered with.
    return JSONResponse({"points": points, "eps": float(cluster_eps), "requested_eps": requested_eps})
