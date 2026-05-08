#!/usr/bin/env python3
"""Benchmark indexing speed across the three encoder backends.

Usage:
    python benchmark_encoders.py /path/to/images [--specs SPEC1 SPEC2 ...] [--limit N]

For each encoder spec, this:
  1. Creates a temporary .npz index file
  2. Times an end-to-end indexing run (model load + encode + UMAP) on the
     given image directory
  3. Reports total seconds and throughput (images/sec)

Defaults to the three backends bundled with PhotoMapAI:
  openai-clip:ViT-B/32
  open-clip:ViT-L-14/dfn2b_s39b
  siglip:google/siglip2-large-patch16-256

The indexing pipeline includes UMAP construction, which is encoder-agnostic
but costs roughly the same wall-clock for each run, so it shifts every
backend's total by a similar constant.
"""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
import time
import traceback
from pathlib import Path

from photomap.backend.embeddings import Embeddings

DEFAULT_SPECS = [
    "openai-clip:ViT-B/32",
    "open-clip:ViT-L-14/dfn2b_s39b",
    "siglip:google/siglip2-large-patch16-256",
]


def _format_seconds(s: float) -> str:
    if s < 60:
        return f"{s:6.2f}s"
    m, sec = divmod(s, 60)
    return f"{int(m)}m{sec:05.2f}s"


def benchmark(
    spec: str,
    image_dir: Path,
    limit: int | None,
    batch_size: int,
    num_workers: int,
) -> dict:
    """Time a single encoder on the given image directory."""
    with tempfile.TemporaryDirectory(prefix="photomap_bench_") as td:
        npz_path = Path(td) / "bench.npz"
        emb = Embeddings(embeddings_path=npz_path, encoder_spec=spec)

        if limit is not None:
            image_paths = emb.get_image_files(image_dir)[:limit]
            if not image_paths:
                raise RuntimeError(f"No images found under {image_dir}")
            target = image_paths
        else:
            target = image_dir

        t0 = time.perf_counter()
        # create_index=False skips the redundant save+UMAP rebuild that
        # happens after _process_images_batch already builds one. We still
        # pay the in-batch UMAP cost, which is identical across backends.
        result = emb.create_index(
            target,
            create_index=False,
            batch_size=batch_size,
            num_workers=num_workers,
        )
        elapsed = time.perf_counter() - t0

        n_indexed = int(result.embeddings.shape[0])
        n_bad = len(result.bad_files)
        return {
            "spec": spec,
            "model_id": result.model_id,
            "embedding_dim": int(result.embedding_dim),
            "n_indexed": n_indexed,
            "n_bad": n_bad,
            "seconds": elapsed,
            "images_per_sec": (n_indexed / elapsed) if elapsed > 0 else 0.0,
            "batch_size": batch_size,
            "num_workers": num_workers,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image_dir", type=Path, help="Directory of images to index")
    parser.add_argument(
        "--specs",
        nargs="+",
        default=DEFAULT_SPECS,
        help="Encoder specs to benchmark (default: all three bundled backends)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap the number of images per run (useful for quick smoke tests)",
    )
    parser.add_argument(
        "--batch-size",
        "-b",
        type=int,
        nargs="+",
        default=[1],
        help=(
            "Batch size(s) to test per encoder. Pass multiple values to compare "
            "(e.g. --batch-size 1 8 32). Default 1 = one image per forward pass."
        ),
    )
    parser.add_argument(
        "--workers",
        "-w",
        type=int,
        nargs="+",
        default=[1],
        help=(
            "CPU loader thread count(s) to test per encoder. Pass multiple values "
            "to compare (e.g. --workers 1 4 8). Default 1 = serial loader."
        ),
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show full Embeddings logging during each run",
    )
    args = parser.parse_args()

    if not args.image_dir.is_dir():
        parser.error(f"{args.image_dir} is not a directory")

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.verbose:
        # HF libraries bump these to INFO on import; silence the per-load HTTP chatter.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("huggingface_hub").setLevel(logging.WARNING)

    if any(b < 1 for b in args.batch_size):
        parser.error("--batch-size values must be >= 1")
    if any(w < 1 for w in args.workers):
        parser.error("--workers values must be >= 1")

    print(f"Benchmarking on: {args.image_dir.resolve()}")
    if args.limit:
        print(f"Image cap per run: {args.limit}")
    print(
        f"Encoders: {len(args.specs)}  |  Batch sizes: {args.batch_size}  |  "
        f"Workers: {args.workers}"
    )
    print()

    results: list[dict] = []
    failures: list[tuple[str, int, int, str]] = []
    for spec in args.specs:
        for bs in args.batch_size:
            for nw in args.workers:
                print(f"--- {spec}  (batch={bs}, workers={nw}) ---", flush=True)
                try:
                    res = benchmark(spec, args.image_dir, args.limit, bs, nw)
                except Exception as e:
                    tb = (
                        traceback.format_exc()
                        if args.verbose
                        else f"{type(e).__name__}: {e}"
                    )
                    print(f"FAILED: {tb}\n", flush=True)
                    failures.append((spec, bs, nw, str(e)))
                    continue
                print(
                    f"  indexed {res['n_indexed']:>5d} images "
                    f"(skipped {res['n_bad']}) in {_format_seconds(res['seconds'])} "
                    f"-> {res['images_per_sec']:6.2f} img/s, dim={res['embedding_dim']}\n",
                    flush=True,
                )
                results.append(res)

    if not results:
        print("No successful runs.", file=sys.stderr)
        return 1

    print("=" * 92)
    print(
        f"{'spec':<44s} {'batch':>6s} {'workers':>8s} {'images':>7s} "
        f"{'time':>10s} {'img/s':>8s}"
    )
    print("-" * 92)
    for r in results:
        print(
            f"{r['spec']:<44s} {r['batch_size']:>6d} {r['num_workers']:>8d} "
            f"{r['n_indexed']:>7d} {_format_seconds(r['seconds']):>10s} "
            f"{r['images_per_sec']:>8.2f}"
        )

    # Per-spec speedup table vs the (smallest batch, smallest workers) run.
    by_spec: dict[str, list[dict]] = {}
    for r in results:
        by_spec.setdefault(r["spec"], []).append(r)
    if any(len(rs) > 1 for rs in by_spec.values()):
        print("-" * 92)
        print("Speedup vs (batch=1, workers=1) for each encoder:")
        for spec, rs in by_spec.items():
            base = min(rs, key=lambda r: (r["batch_size"], r["num_workers"]))
            for r in sorted(rs, key=lambda r: (r["batch_size"], r["num_workers"])):
                if r is base:
                    continue
                ratio = base["seconds"] / r["seconds"] if r["seconds"] else float("inf")
                print(
                    f"  {spec}: batch={r['batch_size']}, workers={r['num_workers']} "
                    f"is {ratio:.2f}x faster than batch={base['batch_size']}, "
                    f"workers={base['num_workers']}"
                )

    if failures:
        print()
        print("Failures:")
        for spec, bs, nw, msg in failures:
            print(f"  {spec} (batch={bs}, workers={nw}): {msg}")
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
