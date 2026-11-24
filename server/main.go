package main

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

// The frontend build copies its self-contained HTML here before go build.
//
//go:embed public/index.html
var indexHTML []byte

var version = "1.0.0"

const backgroundArgument = "--internal-background"

func handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexHTML))
	})
}

func main() {
	attachParentConsole()
	args := os.Args[1:]
	background := len(args) > 0 && args[0] == backgroundArgument
	if background {
		args = args[1:]
	}
	stdout, stderr := consoleOutput(os.Stdout), consoleOutput(os.Stderr)
	options, err := parseCLI(args)
	if err != nil {
		writeCLIError(stderr, err)
		os.Exit(2)
	}
	if options.help {
		writeHelp(stdout)
		return
	}
	if options.version {
		fmt.Fprintln(stdout, "valeton-unlocker", version)
		return
	}
	log.SetOutput(stderr)
	wantsGUI := defaultWebview() && !options.headless
	if wantsGUI && !background {
		if err := launchBackground(args); err != nil {
			log.Fatal(err)
		}
		return
	}
	showWebview := wantsGUI && webviewAvailable()
	listenPort := options.port
	if wantsGUI {
		if !options.portSpecified {
			listenPort = 0 // Let the OS choose a free port for the desktop window.
		}
	}
	addr := net.JoinHostPort(options.host, strconv.Itoa(listenPort))
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	if !wantsGUI {
		writeListening(stdout, fmt.Sprintf("http://%s", listener.Addr()))
	}
	server := &http.Server{Handler: handler(), ReadHeaderTimeout: 5 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/", listener.Addr().(*net.TCPAddr).Port)
	if showWebview {
		go func() {
			if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
				log.Printf("HTTP server: %v", err)
			}
		}()
		windowErr := openWebview(url)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Print(err)
		}
		if windowErr != nil {
			log.Fatal(windowErr)
		}
		return
	}
	if wantsGUI {
		log.Print("WebView2 Runtime is unavailable; opening the system browser")
		if err := openSystemBrowser(url); err != nil {
			log.Fatal(err)
		}
	}
	log.Fatal(server.Serve(listener))
}
