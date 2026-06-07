package main

import (
	"os"
	"path/filepath"
	"runtime"
)

// appName is the per-user directory name for all launcher-managed state.
const appName = "PhotoMapAI"

// layout describes every path the launcher cares about. Everything lives under a
// single runtime root so that "uninstall" is a single directory removal.
type layout struct {
	root      string // <dataDir>/PhotoMapAI/runtime
	uvBin     string // the uv executable itself
	pythonDir string // UV_PYTHON_INSTALL_DIR (managed CPython)
	toolDir   string // UV_TOOL_DIR (the photomapai tool venv)
	toolBin   string // UV_TOOL_BIN_DIR (start_photomap entry point lands here)
	cacheDir  string // UV_CACHE_DIR (kept inside root so it's cleaned on uninstall)
	marker    string // records that install completed and which torch backend
}

// dataDir returns the per-user data directory, following each platform's
// convention (mirrors what the Python app does with platformdirs):
//
//	Windows  %LOCALAPPDATA%
//	macOS    ~/Library/Application Support
//	Linux    $XDG_DATA_HOME or ~/.local/share
func dataDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return d, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "AppData", "Local"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support"), nil
	default: // linux and friends
		if d := os.Getenv("XDG_DATA_HOME"); d != "" {
			return d, nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share"), nil
	}
}

func exeName(base string) string {
	if runtime.GOOS == "windows" {
		return base + ".exe"
	}
	return base
}

func newLayout() (layout, error) {
	data, err := dataDir()
	if err != nil {
		return layout{}, err
	}
	root := filepath.Join(data, appName, "runtime")
	return layout{
		root:      root,
		uvBin:     filepath.Join(root, "bin", exeName("uv")),
		pythonDir: filepath.Join(root, "python"),
		toolDir:   filepath.Join(root, "tools"),
		toolBin:   filepath.Join(root, "toolbin"),
		cacheDir:  filepath.Join(root, "cache"),
		marker:    filepath.Join(root, ".installed"),
	}, nil
}

// mkdirs creates every directory the launcher writes into.
func (l layout) mkdirs() error {
	for _, d := range []string{
		filepath.Dir(l.uvBin), l.pythonDir, l.toolDir, l.toolBin, l.cacheDir,
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// startPhotomap is the path to the installed server entry point.
func (l layout) startPhotomap() string {
	return filepath.Join(l.toolBin, exeName("start_photomap"))
}
