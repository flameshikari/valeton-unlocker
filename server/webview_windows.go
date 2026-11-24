package main

import (
	"errors"
	"fmt"
	"net/url"
	"runtime"
	"strings"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

func defaultWebview() bool { return true }

func webviewAvailable() bool {
	version, err := webviewloader.GetInstalledVersion()
	return err == nil && version != ""
}

func openExternalURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return fmt.Errorf("invalid external URL: %q", raw)
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1" {
		return fmt.Errorf("local URL is not external: %q", raw)
	}
	return openSystemBrowser(raw)
}

func openSystemBrowser(raw string) error {
	operation, _ := windows.UTF16PtrFromString("open")
	target, err := windows.UTF16PtrFromString(raw)
	if err != nil {
		return err
	}
	shellExecute := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")
	result, _, callErr := shellExecute.Call(0, uintptr(unsafe.Pointer(operation)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("could not open browser (%d): %v", result, callErr)
	}
	return nil
}

func openWebview(url string) error {
	// WebView2's COM objects and window message loop must stay on one OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	window := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Valeton Unlocker",
			Width:  1100,
			Height: 760,
			IconId: 1,
			Center: true,
		},
	})
	if window == nil {
		return errors.New("could not open WebView2; install the Microsoft Edge WebView2 Runtime")
	}
	defer window.Destroy()
	if err := window.Bind("openExternalLink", openExternalURL); err != nil {
		return err
	}
	window.Init(`{
		const externalURL = raw => {
			try {
				const target = new URL(raw, location.href);
				return (target.protocol === "http:" || target.protocol === "https:") &&
					target.origin !== location.origin ? target.href : null;
			} catch { return null; }
		};
		const handleLink = event => {
			const anchor = event.target?.closest?.("a[href]");
			if (!anchor) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const target = !anchor.hasAttribute("download") && externalURL(anchor.href);
			if (target) openExternalLink(target);
		};
		addEventListener("click", handleLink, true);
		addEventListener("auxclick", event => {
			if (event.button === 1) handleLink(event);
		}, true);
		addEventListener("contextmenu", event => event.preventDefault(), true);
		addEventListener("dragstart", event => event.preventDefault(), true);
		addEventListener("dragover", event => event.preventDefault(), true);
		addEventListener("drop", event => event.preventDefault(), true);
		addEventListener("submit", event => event.preventDefault(), true);
		addEventListener("keydown", event => {
			const key = event.key.toLowerCase();
			const browserShortcut = (event.ctrlKey || event.metaKey) &&
				["f", "i", "j", "o", "p", "r", "s", "u", "+", "-", "0"].includes(key);
			if (key === "f12" || key === "f11" || key === "f5" || browserShortcut) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}, true);
		window.print = () => {};
		window.open = function(raw) {
			const target = externalURL(raw);
			if (target) openExternalLink(target);
			return null;
		};
	}`)
	window.Navigate(url)
	window.Run()
	return nil
}
