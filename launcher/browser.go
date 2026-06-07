package main

import (
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"time"
)

// How long to wait for the server to start accepting connections before telling
// the user to open it manually. A cold first start on Windows can take minutes
// (Windows Defender scans the freshly written torch DLLs on first import), so
// this is generous; in the normal case the browser opens the moment the port is
// reachable, well before the cap, and `done` aborts the wait if the server dies.
const serverReadyTimeout = 5 * time.Minute

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

// openWhenReady waits until host:port accepts a connection, then opens the
// browser (or just prints the URL when noBrowser). It returns early if `done`
// is closed — i.e. the server process exited before it ever came up — so a
// crashed server doesn't leave us waiting out the whole timeout.
func openWhenReady(host, port string, noBrowser bool, done <-chan struct{}) {
	addr := net.JoinHostPort(host, port)
	url := fmt.Sprintf("http://%s:%s", host, port)
	deadline := time.Now().Add(serverReadyTimeout)

	for time.Now().Before(deadline) {
		select {
		case <-done:
			return // server exited before becoming reachable
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			_ = conn.Close()
			if noBrowser {
				fmt.Printf("\nPhotoMapAI is running. Open %s in your browser.\n", url)
				return
			}
			fmt.Printf("\nPhotoMapAI is running. Opening %s ...\n", url)
			if err := openBrowser(url); err != nil {
				fmt.Printf("Could not open a browser automatically. Open %s manually.\n", url)
			}
			return
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("\nThe server is taking longer than usual to start. Once it's ready, open %s in your browser.\n", url)
}
