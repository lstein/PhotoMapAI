"""Lightweight console-script launcher for ``start_photomap``.

Importing :mod:`photomap.backend.photomap_server` pulls in FastAPI, the routers
and (transitively) CLIP/torch, which can take 10-30s. Because the console-script
entry point has to import its target module before calling it, a banner printed
inside ``photomap_server.main`` only appears after that whole import finishes,
leaving the terminal silent during startup.

This module deliberately imports nothing heavy at module scope so the banner is
printed immediately, then defers the expensive import until inside ``main``.
"""

import sys


def main() -> None:
    print("PhotoMapAI server initializing…", file=sys.stderr, flush=True)
    from photomap.backend.photomap_server import main as _serve

    _serve()
