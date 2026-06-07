// Command photomap is the PhotoMapAI desktop launcher.
//
// On first run it uses a bundled (or downloaded) uv to install a managed CPython
// and the photomapai package into a per-user runtime directory, streaming
// progress to the console. On every run it starts the server and opens the
// browser once the server is accepting connections.
//
// Flags:
//
//	--gpu         install / switch to the CUDA (NVIDIA) torch build, then run
//	--cpu         install / switch to the CPU torch build, then run
//	--reinstall   force a clean reinstall, then run
//	--uninstall   remove the photomapai install and all runtime files, then exit
//	--no-browser  start the server but don't open a browser
//	--version     print the launcher version and exit
//
// Anything after a "--" separator is passed straight through to start_photomap,
// e.g. `photomap -- --album-locked vacation`. The server port/host come from the
// PHOTOMAP_PORT / PHOTOMAP_HOST environment variables (the launcher reads them
// too, so its readiness check and the browser it opens stay in sync).
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"sync/atomic"
	"syscall"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

const (
	defaultServerHost = "127.0.0.1"
	defaultServerPort = "8050"
)

// envOr returns the environment value for key, or def when unset/empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var (
		gpu          = flag.Bool("gpu", false, "re-detect and use an NVIDIA GPU if available")
		cpu          = flag.Bool("cpu", false, "force the CPU-only build")
		torchBackend = flag.String("torch-backend", "", "advanced: uv torch backend (auto|cpu|cu130|cu129|…)")
		reinstall    = flag.Bool("reinstall", false, "force a clean reinstall before running")
		doUninst     = flag.Bool("uninstall", false, "remove PhotoMapAI and all runtime files")
		noBrowser    = flag.Bool("no-browser", false, "do not open a web browser on startup")
		showVer      = flag.Bool("version", false, "print the launcher version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("PhotoMapAI launcher %s\n", version)
		return
	}

	// Anything after "--" is forwarded verbatim to start_photomap.
	serverArgs := flag.Args()

	if err := run(*gpu, *cpu, *torchBackend, *reinstall, *doUninst, *noBrowser, serverArgs); err != nil {
		fmt.Fprintf(os.Stderr, "\nError: %v\n", err)
		pause()
		os.Exit(1)
	}
}

func run(gpu, cpu bool, torchBackend string, reinstall, doUninst, noBrowser bool, serverArgs []string) error {
	l, err := newLayout()
	if err != nil {
		return err
	}
	if err := l.mkdirs(); err != nil {
		return err
	}

	if doUninst {
		return uninstall(l)
	}

	if err := ensureUV(l); err != nil {
		return fmt.Errorf("setting up uv: %w", err)
	}

	// Decide the torch backend and whether (re)install is needed.
	current := installedBackend(l)
	target := current
	switch {
	case torchBackend != "":
		target = torchBackend // explicit advanced override
	case gpu:
		target = "auto" // re-detect; uv picks CUDA when a GPU is present
	case cpu:
		target = "cpu"
	case current == "":
		target = defaultTorchBackend // first run: auto-detect GPU, else CPU
	}

	needInstall := reinstall || current == "" || target != current
	if needInstall {
		force := reinstall || (current != "" && target != current)
		if err := install(l, target, force); err != nil {
			return err
		}
		fmt.Println("\nSetup complete.")
	}

	return launchServer(l, noBrowser, serverArgs)
}

// launchServer starts the server (with --no-browser so the launcher owns the
// browser open), opens the browser when it's ready, and forwards Ctrl+C.
func launchServer(l layout, noBrowser bool, serverArgs []string) error {
	bin := l.startPhotomap()
	if !fileExists(bin) {
		return fmt.Errorf("start_photomap not found at %s; try --reinstall", bin)
	}

	cmd := exec.Command(bin, serverArgs...)
	// Run from a neutral directory: the server re-spawns itself with
	// `python -m photomap...`, which puts the current directory first on sys.path.
	// If the launcher were started from a folder containing a `photomap/` package
	// (e.g. a source checkout), that stray copy would shadow the installed one.
	cmd.Dir = l.root
	// Suppress the server's own browser-opening via env rather than a CLI flag, so
	// the launcher works with any photomapai version: older releases have no
	// auto-open and ignore it, newer releases honor it. The launcher opens the
	// browser itself once the port is accepting connections.
	cmd.Env = append(os.Environ(), "PHOTOMAP_NO_BROWSER=1")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting server: %w", err)
	}

	// Read host/port from the same env the server uses, so the readiness poll and
	// the browser we open match where the server actually binds. A wildcard bind
	// is browsed via loopback.
	host := envOr("PHOTOMAP_HOST", defaultServerHost)
	port := envOr("PHOTOMAP_PORT", defaultServerPort)
	if host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	// Open the browser once the server is reachable; closed when it exits so the
	// poller stops immediately if the server crashes instead of waiting it out.
	serverExited := make(chan struct{})
	go openWhenReady(host, port, noBrowser, serverExited)

	// Forward interrupts to the server so Ctrl+C shuts it down cleanly. A shutdown
	// we initiated is not an error, so we don't want to show the error/pause path.
	var shuttingDown atomic.Bool
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigc
		shuttingDown.Store(true)
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}()

	err := cmd.Wait()
	close(serverExited)
	if shuttingDown.Load() {
		return nil
	}
	return err
}

// pause keeps the console window open on error so the user can read the message.
func pause() {
	fmt.Print("\nPress Enter to close...")
	fmt.Scanln()
}
