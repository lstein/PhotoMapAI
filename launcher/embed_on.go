//go:build embed_uv

package main

import _ "embed"

// embeddedUV is the uv binary for the target platform, baked into the launcher
// at build time. CI downloads the matching uv release into assets/uv-bin
// (assets/uv-bin.exe on Windows is copied to this same name) before building
// with `-tags embed_uv`. Bundling keeps uv inside the code-signing boundary and
// removes a network dependency from the most fragile (first-run) step.
//
//go:embed assets/uv-bin
var embeddedUV []byte
