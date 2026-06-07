//go:build !embed_uv

package main

// embeddedUV is empty in normal builds. `go build ./...` works without any
// vendored binary, and the launcher falls back to a uv on PATH or a download.
// Release builds pass `-tags embed_uv` after CI drops the real binary into
// assets/ (see embed_on.go and launcher/README.md).
var embeddedUV []byte
