"""Cluster auto-label endpoint.

Separate from `/umap_data` so the UMAP endpoint stays fast and unchanged.
The compute is wrapped in `asyncio.to_thread` because the first-time build
encodes the vocabulary through CLIP/SigLIP, which can take a few seconds.

Defaults for `cluster_eps` and `cluster_min_samples` mirror the umap router
exactly so cluster IDs returned here match cluster IDs returned by
`/umap_data` for the same query.
"""

import asyncio
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..cluster_eps import MIN_CLUSTER_EPS, resolve_album_cluster_eps
from ..cluster_labels import compute_image_label, get_or_build_cluster_labels
from .album import AlbumDep, EmbeddingsDep, album_umap_coords_async

cluster_labels_router = APIRouter()


@cluster_labels_router.get("/cluster_labels/{album_key}", tags=["UMAP"])
async def get_cluster_labels(
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
    top_k: int = 3,
) -> JSONResponse:
    """Return one short text label per DBSCAN cluster for an album's UMAP.

    Args:
        album_key: Album to label.
        cluster_eps: DBSCAN epsilon. Omit (or send ``None``) to use the
            album's persisted ``umap_eps``, or a value derived from its
            coordinates when that has never been set — the same resolution
            ``/umap_data`` uses, so cluster IDs align between the two
            endpoints.
        cluster_min_samples: DBSCAN min_samples. Same constraint.
        top_k: How many candidate phrases to return per cluster
            (the top one is shown, the rest are alternates).

    Returns:
        `{"labels": {"<cluster_id>": {"label": str, "alternates": [str, ...],
        "score": float}, ...}}`. Cluster `-1` (DBSCAN noise) is omitted.
    """
    # Resolve through the same helper ``routers/umap.py`` uses, against the
    # same coordinates, so ``/cluster_labels`` and ``/umap_data`` agree for
    # a given request. If they disagree the cluster IDs returned by the two
    # endpoints diverge and the hover-label feature breaks.
    # In a thread for the same reason the label build below is: deriving an
    # eps runs several DBSCAN fits, which is seconds of CPU on a large album
    # and would otherwise hold the event loop. Loading the coordinates is
    # awaited separately rather than passed as an argument here — an argument
    # is evaluated *before* the thread is spawned, and loading them can mean
    # refitting UMAP outright (see album_umap_coords).
    coords = await album_umap_coords_async(embeddings)
    cluster_eps = await asyncio.to_thread(
        resolve_album_cluster_eps,
        coords,
        Path(album_config.index).parent,
        cluster_eps,
        album_config.umap_eps,
        cluster_min_samples,
    )
    labels = await asyncio.to_thread(
        get_or_build_cluster_labels,
        embeddings,
        cluster_eps=cluster_eps,
        cluster_min_samples=cluster_min_samples,
        top_k=top_k,
    )
    # FastAPI will stringify the int cluster IDs in the JSON keys.
    return JSONResponse({"labels": labels})


@cluster_labels_router.get("/image_label/{album_key}/{index}", tags=["UMAP"])
async def get_image_label(
    album_key: str,
    index: int,
    embeddings: EmbeddingsDep,
    top_k: int = 3,
) -> JSONResponse:
    """Return one vocabulary label for a single image.

    The cluster's label (from `/cluster_labels`) describes the cluster's
    overall centroid, which can drift from any individual member when the
    cluster is heterogeneous. This endpoint scores the image's own embedding
    against the vocab so the metadata drawer can show what *that picture*
    looks like, independent of its cluster's aggregate label.

    Args:
        album_key: Album to score against.
        index: Sorted (frontend-facing) image index — same coordinate system
            as `/umap_data` and `/retrieve_image/{index}`.
        top_k: How many alternates to return.

    Returns:
        `{"label": str, "alternates": [str, ...], "score": float}` on success,
        or `{}` when no vocab is available or the index is out of bounds.
    """
    result = await asyncio.to_thread(
        compute_image_label, embeddings, index, top_k=top_k
    )
    return JSONResponse(result)
