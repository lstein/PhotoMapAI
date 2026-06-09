package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindExtractedPython(t *testing.T) {
	dir := t.TempDir()
	l := layout{pythonDir: dir}

	if _, ok := findExtractedPython(l); ok {
		t.Fatal("findExtractedPython found an interpreter in an empty dir")
	}

	// A bare minor-version junction name (no patch) must NOT match — only the
	// real, patch-versioned install directory should.
	if err := os.MkdirAll(filepath.Join(dir, "cpython-3.12-windows-x86_64-none"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, ok := findExtractedPython(l); ok {
		t.Fatal("findExtractedPython matched the patch-less junction directory")
	}

	// Simulate an extracted interpreter. Create both candidate layouts (Windows
	// python.exe at the root, Unix bin/python3) so the test is host-OS-agnostic.
	pdir := filepath.Join(dir, "cpython-3.12.13-windows-x86_64-none")
	if err := os.MkdirAll(filepath.Join(pdir, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, exe := range []string{filepath.Join(pdir, "python.exe"), filepath.Join(pdir, "bin", "python3")} {
		if err := os.WriteFile(exe, []byte("stub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, ok := findExtractedPython(l)
	if !ok {
		t.Fatal("findExtractedPython did not find the extracted interpreter")
	}
	if !strings.HasPrefix(got, pdir) {
		t.Errorf("findExtractedPython = %q, want a path under %q", got, pdir)
	}
}

func TestEnvOr(t *testing.T) {
	const key = "PHOTOMAP_TEST_ENVOR"
	t.Setenv(key, "")
	if got := envOr(key, "fallback"); got != "fallback" {
		t.Errorf("empty env = %q, want fallback", got)
	}
	t.Setenv(key, "9000")
	if got := envOr(key, "fallback"); got != "9000" {
		t.Errorf("set env = %q, want 9000", got)
	}
}

func TestIsUVBinary(t *testing.T) {
	cases := map[string]bool{
		"uv":                             true,
		"uv.exe":                         true,
		"uv-x86_64-unknown-linux-gnu/uv": true,
		"uvx":                            false,
		"uvx.exe":                        false,
		"README.md":                      false,
	}
	for name, want := range cases {
		if got := isUVBinary(name); got != want {
			t.Errorf("isUVBinary(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestMarkerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	l := layout{marker: filepath.Join(dir, ".installed")}

	if b := installedBackend(l); b != "" {
		t.Fatalf("fresh marker = %q, want empty", b)
	}
	if err := writeMarker(l, "auto"); err != nil {
		t.Fatal(err)
	}
	if b := installedBackend(l); b != "auto" {
		t.Fatalf("after write = %q, want %q", b, "auto")
	}
}

func TestUVEnvRedirectsState(t *testing.T) {
	l := layout{
		pythonDir: "/tmp/pm/python",
		toolDir:   "/tmp/pm/tools",
		toolBin:   "/tmp/pm/bin",
		cacheDir:  "/tmp/pm/cache",
	}
	got := map[string]string{}
	for _, kv := range l.uvEnv() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			got[k] = v
		}
	}
	// Tool + cache state must be redirected under the runtime root so nothing
	// leaks into the user's global uv dirs.
	want := map[string]string{
		"UV_TOOL_DIR":     l.toolDir,
		"UV_TOOL_BIN_DIR": l.toolBin,
		"UV_CACHE_DIR":    l.cacheDir,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("uvEnv()[%q] = %q, want %q", k, got[k], v)
		}
	}
	// uvEnv must NOT set UV_PYTHON_INSTALL_DIR: only ensurePython sets it, and the
	// `uv tool install` step must run without it so the explicit --python
	// interpreter is treated as external (no minor-version junction → no os 448).
	if v, set := got["UV_PYTHON_INSTALL_DIR"]; set {
		t.Errorf("uvEnv() set UV_PYTHON_INSTALL_DIR=%q, want it unset", v)
	}
}

// TestDownloadUVIntegration exercises the download + archive-extraction + exec
// path against the real uv release (~30 MB, no torch). Skipped with -short.
func TestDownloadUVIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("network integration test; run without -short")
	}
	dir := t.TempDir()
	l := layout{uvBin: filepath.Join(dir, "bin", exeName("uv"))}
	if err := os.MkdirAll(filepath.Dir(l.uvBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := downloadUV(l); err != nil {
		t.Fatalf("downloadUV: %v", err)
	}
	out, err := exec.Command(l.uvBin, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("running extracted uv: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "uv ") {
		t.Fatalf("unexpected uv --version output: %s", out)
	}
}
