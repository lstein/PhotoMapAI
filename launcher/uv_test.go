package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWithRetrySucceedsAfterTransientFailures(t *testing.T) {
	calls, backoffs := 0, 0
	err := withRetry(3, func(int) { backoffs++ }, func() error {
		calls++
		if calls < 3 {
			return errors.New("transient 448")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withRetry = %v, want nil after recovering", err)
	}
	if calls != 3 {
		t.Errorf("fn called %d times, want 3", calls)
	}
	if backoffs != 2 {
		t.Errorf("backoff called %d times, want 2 (between the 3 tries)", backoffs)
	}
}

func TestWithRetryReturnsLastErrorWhenExhausted(t *testing.T) {
	calls := 0
	want := errors.New("persistent failure")
	err := withRetry(3, func(int) {}, func() error {
		calls++
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("withRetry = %v, want %v", err, want)
	}
	if calls != 3 {
		t.Errorf("fn called %d times, want 3", calls)
	}
}

func TestWithRetryStopsOnFirstSuccess(t *testing.T) {
	calls := 0
	err := withRetry(3, func(int) { t.Error("backoff should not be called on immediate success") }, func() error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatalf("withRetry = %v, want nil", err)
	}
	if calls != 1 {
		t.Errorf("fn called %d times, want 1", calls)
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

func TestUVEnvForcesManagedPython(t *testing.T) {
	l := layout{
		pythonDir: "/tmp/pm/python",
		toolDir:   "/tmp/pm/tools",
		toolBin:   "/tmp/pm/bin",
		cacheDir:  "/tmp/pm/cache",
	}
	want := map[string]string{
		"UV_PYTHON_INSTALL_DIR": l.pythonDir,
		"UV_TOOL_DIR":           l.toolDir,
		"UV_TOOL_BIN_DIR":       l.toolBin,
		"UV_CACHE_DIR":          l.cacheDir,
		// only-managed keeps uv off the non-relocatable macOS framework Python,
		// which would otherwise trigger the Xcode install_name_tool prompt.
		"UV_PYTHON_PREFERENCE": "only-managed",
	}
	got := map[string]string{}
	for _, kv := range l.uvEnv() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			got[k] = v
		}
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("uvEnv()[%q] = %q, want %q", k, got[k], v)
		}
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
