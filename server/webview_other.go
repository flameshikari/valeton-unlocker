//go:build !windows

package main

import "errors"

func openWebview(string) error {
	return errors.New("WebView2 is available only on Windows")
}

func defaultWebview() bool { return false }

func webviewAvailable() bool { return false }

func openSystemBrowser(string) error {
	return errors.New("automatic browser opening is available only on Windows")
}

func attachParentConsole() {}
