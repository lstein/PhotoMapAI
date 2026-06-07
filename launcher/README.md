# PhotoMapAI desktop launcher

A small native launcher (Go) that gives non-technical users a single signed
double-click install. On first run it uses [uv](https://docs.astral.sh/uv/) to
install a managed CPython and the `photomapai` package into a per-user runtime
directory, streaming progress to the console. On every run it starts the server
and opens the browser once it's accepting connections.

The launcher deliberately does **not** bundle PyTorch — that multi-GB stack is
fetched by uv at first run. This keeps the signed/notarized artifact tiny.

## What it manages, and where

Everything lives under one runtime root so uninstall is a single delete:

| OS      | Runtime root                                              |
|---------|----------------------------------------------------------|
| Windows | `%LOCALAPPDATA%\PhotoMapAI\runtime`                       |
| macOS   | `~/Library/Application Support/PhotoMapAI/runtime`        |
| Linux   | `$XDG_DATA_HOME/PhotoMapAI/runtime` (`~/.local/share/…`)  |

The existing app **config** directory (`photomap`, via platformdirs) is left
untouched, so albums carry over for existing users.

## Flags

```
--gpu              re-detect and use an NVIDIA GPU if available, then run
--cpu              force the CPU-only build, then run
--torch-backend X  advanced: uv torch backend (auto|cpu|cu130|cu129|…)
--reinstall        force a clean reinstall, then run
--uninstall        remove the install and all runtime files, then exit
--no-browser       start the server but don't open a browser
--version          print the launcher version and exit
```

First run with no flags uses `uv tool install --torch-backend auto`: uv detects
an NVIDIA GPU and installs the matching CUDA wheels, falling back to CPU when
there's no GPU — so the common case needs no choice and there's no CUDA index
version to maintain. `--cpu` forces CPU (e.g. to avoid a flaky driver); `--gpu`
re-detects after adding a GPU; `--torch-backend` pins a specific backend.

### Passing options to the server

The launcher inherits the environment, so the server's env vars work as usual:

```
PHOTOMAP_PORT=9000 photomap        # run on a different port
PHOTOMAP_HOST=0.0.0.0 photomap     # bind all interfaces (LAN access)
PHOTOMAP_CONFIG=/path/config.yaml photomap
```

The launcher reads `PHOTOMAP_PORT` / `PHOTOMAP_HOST` itself too, so its readiness
check and the browser it opens follow the server. For other server flags, put
them after a `--` separator:

```
photomap -- --album-locked vacation
```

### Where things live

- **Config / albums:** the app's normal config dir (unchanged by the launcher):
  `~/.config/photomap/config.yaml` (Linux), `~/Library/Application
  Support/photomap/config.yaml` (macOS), `%APPDATA%\photomap\photomap\config.yaml`
  (Windows). Override with `PHOTOMAP_CONFIG`.
- **Runtime** (managed Python, venv, uv cache): see the table above; removed by
  `--uninstall`.

## Building

Plain build (no embedded uv — falls back to a uv on `PATH`, else downloads one
at first run). Good for local development:

```bash
cd launcher
go build -o photomap .
go test ./...            # add -short to skip the network integration test
```

Release build with uv embedded (what CI does). Fetch the matching uv release
binary into `assets/uv-bin` first, then build with the `embed_uv` tag:

```bash
# example for the host platform; CI does this per OS/arch
curl -L -o /tmp/uv.tar.gz \
  https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz
tar -xzf /tmp/uv.tar.gz --strip-components=1 -C assets   # yields assets/uv
mv assets/uv assets/uv-bin                               # assets/uv-bin(.exe on Windows)

go build -tags embed_uv -ldflags "-X main.version=$VERSION" -o photomap .
```

`assets/` is gitignored except this note — the uv binary is never committed.

## Maintenance notes

- **torch backend:** the launcher passes `--torch-backend auto`; uv selects the
  CPU/CUDA wheels per machine, so there's no CUDA index version to track. Requires
  a uv new enough to support `--torch-backend` on `uv tool install` (uv ≥ 0.8;
  verified on 0.11.x).
- **uv version:** the embedded uv is whatever CI fetched (`latest`). Pin the URL
  to a specific uv release tag if you want reproducible builds.
- **Package pin:** `pkgName` in `uv.go` is unpinned (`photomapai`), so users get
  the latest on install and via `uv tool upgrade`. Pin to `photomapai==X.Y.Z`
  for first-run reproducibility tied to a launcher release.
