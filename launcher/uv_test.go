package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

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
