"""Cluster auto-label endpoint.

Separate from `/umap_data` so the UMAP endpoint stays fast and unchanged.
The compute is wrapped in `asyncio.to_thread` because the first-time build
encodes the vocabulary through CLIP/SigLIP, which can take a few seconds.

Defaults for `cluster_eps` and `cluster_min_samples` mirror the umap router
exactly so cluster IDs returned here match cluster IDs returned by
`/umap_data` for the same query.
"""

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..cluster_labels import get_or_build_cluster_labels
from .album import get_embeddings_for_album

cluster_labels_router = APIRouter()


@cluster_labels_router.get("/cluster_labels/{album_key}", tags=["UMAP"])
async def get_cluster_labels(
    album_key: str,
    cluster_eps: float = 0.07,
    cluster_min_samples: int = 10,
    top_k: int = 3,
) -> JSONResponse:
    """Return one short text label per DBSCAN cluster for an album's UMAP.

    Args:
        album_key: Album to label.
        cluster_eps: DBSCAN epsilon. Must match the value passed to
            `/umap_data` for cluster IDs to align.
        cluster_min_samples: DBSCAN min_samples. Same constraint.
        top_k: How many candidate phrases to return per cluster
            (the top one is shown, the rest are alternates).

    Returns:
        `{"labels": {"<cluster_id>": {"label": str, "alternates": [str, ...],
        "score": float}, ...}}`. Cluster `-1` (DBSCAN noise) is omitted.
    """
    embeddings = get_embeddings_for_album(album_key)
    labels = await asyncio.to_thread(
        get_or_build_cluster_labels,
        embeddings,
        cluster_eps=cluster_eps,
        cluster_min_samples=cluster_min_samples,
        top_k=top_k,
    )
    # FastAPI will stringify the int cluster IDs in the JSON keys.
    return JSONResponse({"labels": labels})
