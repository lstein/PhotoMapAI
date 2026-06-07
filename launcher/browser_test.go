package main

import (
	"net"
	"testing"
	"time"
)

// When the server exits before becoming reachable, openWhenReady must return
// promptly via the done channel rather than waiting out serverReadyTimeout.
func TestOpenWhenReadyBailsOnServerExit(t *testing.T) {
	done := make(chan struct{})
	close(done)
	start := time.Now()
	openWhenReady("127.0.0.1", "59999", true, done) // nothing listening
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("did not bail promptly on server exit (took %s)", elapsed)
	}
}

// When the port is reachable, openWhenReady detects it quickly (noBrowser=true
// so no real browser is launched).
func TestOpenWhenReadyDetectsReachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	done := make(chan struct{})
	defer close(done)
	start := time.Now()
	openWhenReady("127.0.0.1", port, true, done)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("did not detect a reachable port quickly (took %s)", elapsed)
	}
}
