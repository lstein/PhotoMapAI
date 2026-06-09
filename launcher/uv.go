package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	// pinned interpreter — uv downloads a managed CPython of this version.
	pythonVersion = "3.12"

	// PyPI package to install. Left unpinned so `uv tool upgrade` can move users
	// forward; pin to e.g. "photomapai==1.2.3" here if you want first-run
	// reproducibility tied to a launcher release.
	pkgName = "photomapai"

	// Default PyTorch backend passed to `uv tool install --torch-backend`.
	// "auto" lets uv detect an NVIDIA GPU and install the matching CUDA wheels,
	// falling back to CPU when there's no GPU — so the common case needs no manual
	// choice and there's no CUDA index version to keep up to date. Override with
	// --cpu or --torch-backend (auto|cpu|cu130|cu129|…).
	defaultTorchBackend = "auto"

	uvLatestBase = "https://github.com/astral-sh/uv/releases/latest/download/"
)

// uvEnv returns the process environment with uv's tool and cache state redirected
// under the runtime root, so nothing leaks into the user's global uv dirs.
//
// It deliberately does NOT set UV_PYTHON_INSTALL_DIR. The managed-Python download
// is run by ensurePython, which sets that variable itself; the `uv tool install`
// step must run *without* it so that the explicit interpreter we pass via
// --python is treated as an external interpreter. If UV_PYTHON_INSTALL_DIR were
// set there, uv would treat that interpreter as managed and try to (re)create its
// minor-version directory junction — the exact step that fails with os error 448
// on Windows under OneDrive Files-On-Demand.
func (l layout) uvEnv() []string {
	env := os.Environ()
	env = append(env,
		"UV_TOOL_DIR="+l.toolDir,
		"UV_TOOL_BIN_DIR="+l.toolBin,
		"UV_CACHE_DIR="+l.cacheDir,
		// Don't let a managed-Python download be disabled by inherited config.
		"UV_PYTHON_DOWNLOADS=automatic",
	)
	return env
}

// runUV runs uv with the given arguments, streaming its output to our console.
func (l layout) runUV(args ...string) error {
	cmd := exec.Command(l.uvBin, args...)
	cmd.Env = l.uvEnv()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

// ensurePython makes a managed CPython available on disk and returns the path to
// its interpreter executable.
//
// It runs uv's managed-Python install (download + extract into l.pythonDir) but
// treats a nonzero exit as success *as long as a usable interpreter landed on
// disk*. The reason: on Windows with OneDrive Files-On-Demand, the final step
// where uv creates a "minor version" directory junction fails with os error 448
// ("untrusted mount point") even though the interpreter itself is fully extracted
// and runnable. We don't need that junction — install() points uv at the
// interpreter directly via --python — so a junction failure is harmless here. uv
// output is captured and only surfaced if we end up with no usable interpreter,
// to avoid alarming the user with a 448 we deliberately ignore.
func (l layout) ensurePython() (string, error) {
	var out bytes.Buffer
	cmd := exec.Command(l.uvBin, "python", "install", pythonVersion, "--no-bin")
	// Set UV_PYTHON_INSTALL_DIR only for this step (see uvEnv). --no-bin keeps uv
	// from dropping a python shim into the user's ~/.local/bin.
	cmd.Env = append(l.uvEnv(), "UV_PYTHON_INSTALL_DIR="+l.pythonDir)
	cmd.Stdout = &out
	cmd.Stderr = &out
	runErr := cmd.Run()

	if pyExe, ok := findExtractedPython(l); ok {
		return pyExe, nil
	}
	if runErr != nil {
		return "", fmt.Errorf("%w\n%s", runErr, strings.TrimSpace(out.String()))
	}
	return "", fmt.Errorf("Python %s was not found under %s after install", pythonVersion, l.pythonDir)
}

// findExtractedPython locates the interpreter inside an extracted managed-CPython
// directory under l.pythonDir (e.g. cpython-3.12.13-windows-x86_64-none),
// returning the path and whether one was found. The glob requires a patch
// component (`3.12.`), so it matches the real install directory and not uv's
// `cpython-3.12-…` minor-version junction.
func findExtractedPython(l layout) (string, bool) {
	dirs, _ := filepath.Glob(filepath.Join(l.pythonDir, "cpython-"+pythonVersion+".*"))
	for _, dir := range dirs {
		for _, exe := range []string{
			filepath.Join(dir, "python.exe"),     // Windows
			filepath.Join(dir, "bin", "python3"), // macOS / Linux
		} {
			if fileExists(exe) {
				return exe, true
			}
		}
	}
	return "", false
}

// ensureUV makes sure a usable uv binary exists at l.uvBin. It prefers an
// already-materialized copy, then the embedded binary (release builds), then a
// download. A uv that happens to be on PATH is deliberately NOT used: it may be
// too old to support flags we rely on (e.g. `--torch-backend`), and the whole
// point of bundling is to pin a uv version we've tested against.
func ensureUV(l layout) error {
	if fileExists(l.uvBin) {
		return nil
	}
	if len(embeddedUV) > 0 {
		fmt.Println("Setting up the package manager...")
		return writeExecutable(l.uvBin, embeddedUV)
	}
	fmt.Println("Downloading the package manager (uv)...")
	return downloadUV(l)
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func writeExecutable(dst string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, 0o755); err != nil {
		return err
	}
	return os.Chmod(dst, 0o755)
}

// uvAsset returns the uv release asset filename for the running platform and
// whether it is a zip (Windows) versus a tar.gz (Unix).
func uvAsset() (name string, isZip bool, err error) {
	var triple string
	switch runtime.GOOS {
	case "linux":
		switch runtime.GOARCH {
		case "amd64":
			triple = "x86_64-unknown-linux-gnu"
		case "arm64":
			triple = "aarch64-unknown-linux-gnu"
		}
	case "darwin":
		switch runtime.GOARCH {
		case "amd64":
			triple = "x86_64-apple-darwin"
		case "arm64":
			triple = "aarch64-apple-darwin"
		}
	case "windows":
		switch runtime.GOARCH {
		case "amd64":
			return "uv-x86_64-pc-windows-msvc.zip", true, nil
		case "arm64":
			return "uv-aarch64-pc-windows-msvc.zip", true, nil
		}
	}
	if triple == "" {
		return "", false, fmt.Errorf("unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	return "uv-" + triple + ".tar.gz", false, nil
}

func downloadUV(l layout) error {
	asset, isZip, err := uvAsset()
	if err != nil {
		return err
	}
	resp, err := http.Get(uvLatestBase + asset)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading uv: HTTP %d", resp.StatusCode)
	}
	if isZip {
		return extractUVFromZip(resp.Body, l.uvBin)
	}
	return extractUVFromTarGz(resp.Body, l.uvBin)
}

// isUVBinary reports whether an archive member is the uv executable itself.
func isUVBinary(name string) bool {
	base := path.Base(name)
	return base == "uv" || base == "uv.exe"
}

func extractUVFromTarGz(r io.Reader, dst string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeReg && isUVBinary(hdr.Name) {
			data, err := io.ReadAll(tr)
			if err != nil {
				return err
			}
			return writeExecutable(dst, data)
		}
	}
	return fmt.Errorf("uv binary not found in archive")
}

func extractUVFromZip(r io.Reader, dst string) error {
	// zip requires a ReaderAt; buffer the (small) archive into memory.
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	zr, err := zip.NewReader(asReaderAt(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		if isUVBinary(f.Name) {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			out, err := io.ReadAll(rc)
			if err != nil {
				return err
			}
			return writeExecutable(dst, out)
		}
	}
	return fmt.Errorf("uv binary not found in archive")
}

// asReaderAt adapts a byte slice to io.ReaderAt for archive/zip.
type byteReaderAt []byte

func (b byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func asReaderAt(data []byte) io.ReaderAt { return byteReaderAt(data) }

// installedBackend reads the marker file (the torch backend used for the current
// install), returning "" if photomapai isn't installed yet.
func installedBackend(l layout) string {
	data, err := os.ReadFile(l.marker)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func writeMarker(l layout, torchBackend string) error {
	return os.WriteFile(l.marker, []byte(torchBackend+"\n"), 0o644)
}

// warnIfXcodeToolsMissing gives macOS users a heads-up before uv runs for the
// first time. When uv builds the tool's virtualenv it has macOS rewrite the
// Python executable's library paths with `install_name_tool`; if the Xcode
// Command Line Tools aren't installed, macOS pops a dialog offering to install
// them. The tools are NOT actually needed — PhotoMapAI installs fine whether the
// user accepts or cancels — and there's no clean way to suppress the dialog, so
// we just warn, pause long enough to read it, and continue. No-op off macOS, or
// when the Command Line Tools are already present (then no dialog appears).
func warnIfXcodeToolsMissing() {
	if runtime.GOOS != "darwin" {
		return
	}
	// `xcode-select -p` exits non-zero when the Command Line Tools are absent.
	if err := exec.Command("xcode-select", "-p").Run(); err == nil {
		return
	}
	fmt.Println("\nMacOS will ask you to install the XCode Command Line Tools. Either cancel or accept this request -- it makes no difference.")
	time.Sleep(5 * time.Second)
}

// install runs the uv steps to put photomapai on disk with the requested torch
// backend. pkgSpec is the argument passed to `uv tool install` — usually the bare
// pkgName, or pkgName=="<version>" when --pkg-version pins a release (an explicit
// "==" lets uv resolve a pre-release the bare name would otherwise skip).
// reinstall forces uv to replace an existing install (used when switching backend,
// pinning a version, or recovering a broken install).
func install(l layout, pkgSpec, torchBackend string, reinstall bool) error {
	fmt.Printf("\nFirst-time setup: downloading Python and the PhotoMapAI libraries.\n")
	fmt.Printf("This is a multi-GB download and runs once; it can take several minutes.\n\n")

	warnIfXcodeToolsMissing()

	// Get a managed interpreter on disk. We pass its explicit path to
	// `uv tool install` below rather than `--python 3.12`, so uv never runs its
	// managed-install machinery for the tool venv — and therefore never tries to
	// create the minor-version junction that fails with os error 448 on Windows
	// under OneDrive Files-On-Demand. See ensurePython / uvEnv for the details.
	pyExe, err := l.ensurePython()
	if err != nil {
		return fmt.Errorf("installing Python: %w", err)
	}

	args := []string{
		"tool", "install", pkgSpec,
		"--python", pyExe,
		"--torch-backend", torchBackend,
	}
	if reinstall {
		args = append(args, "--reinstall")
	}
	if err := l.runUV(args...); err != nil {
		return fmt.Errorf("installing %s: %w", pkgSpec, err)
	}
	return writeMarker(l, torchBackend)
}

// uninstall removes the photomapai tool and the entire runtime root.
func uninstall(l layout) error {
	if fileExists(l.uvBin) {
		// Best effort; ignore errors since we're about to delete the tree anyway.
		_ = l.runUV("tool", "uninstall", pkgName)
	}
	fmt.Printf("Removing %s...\n", l.root)
	return os.RemoveAll(l.root)
}
