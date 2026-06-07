package main

import (
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"time"
)

// openBrowser opens url in the user's default browser, per platform.
func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// waitForServer blocks until host:port accepts a TCP connection or timeout elapses.
func waitForServer(host, port string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	addr := net.JoinHostPort(host, port)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

// openWhenReady waits for the server, then opens the browser. Intended to run in
// a goroutine while the server process is supervised in the foreground.
func openWhenReady(host, port string, noBrowser bool) {
	if !waitForServer(host, port, 60*time.Second) {
		fmt.Println("Server did not become ready in time; open it manually once it starts.")
		return
	}
	url := fmt.Sprintf("http://%s:%s", host, port)
	if noBrowser {
		fmt.Printf("\nPhotoMapAI is running. Open %s in your browser.\n", url)
		return
	}
	fmt.Printf("\nPhotoMapAI is running. Opening %s ...\n", url)
	if err := openBrowser(url); err != nil {
		fmt.Printf("Could not open a browser automatically. Open %s manually.\n", url)
	}
}
