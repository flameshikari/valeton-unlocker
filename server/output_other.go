//go:build !windows

package main

import (
	"io"
	"os"

	"golang.org/x/term"
)

func consoleOutput(file *os.File) io.Writer {
	if term.IsTerminal(int(file.Fd())) {
		return terminalWriter{file}
	}
	return file
}

type terminalWriter struct{ io.Writer }

func (terminalWriter) enableColor() (bool, func()) { return true, func() {} }
