package main

import (
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// Windows consoles, including ConPTY, need CRLF for stable cursor positioning.
// Redirected pipes and files keep their original bytes.
func consoleOutput(file *os.File) io.Writer {
	var mode uint32
	if windows.GetConsoleMode(windows.Handle(file.Fd()), &mode) != nil {
		return file
	}
	return &consoleWriter{writer: file}
}

type consoleWriter struct {
	writer     io.Writer
	previousCR bool
}

func (w *consoleWriter) enableColor() (bool, func()) {
	file, ok := w.writer.(*os.File)
	if !ok {
		return false, func() {}
	}
	handle := windows.Handle(file.Fd())
	var mode uint32
	if windows.GetConsoleMode(handle, &mode) != nil {
		return false, func() {}
	}
	colored := mode | windows.ENABLE_PROCESSED_OUTPUT | windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING
	if colored != mode {
		if windows.SetConsoleMode(handle, colored) != nil {
			return false, func() {}
		}
		return true, func() { _ = windows.SetConsoleMode(handle, mode) }
	}
	return true, func() {}
}

func (w *consoleWriter) Write(p []byte) (int, error) {
	encoded := make([]byte, 0, len(p))
	previousCR := w.previousCR
	for _, b := range p {
		if b == '\n' && !previousCR {
			encoded = append(encoded, '\r')
		}
		encoded = append(encoded, b)
		previousCR = b == '\r'
	}
	n, err := w.writer.Write(encoded)
	if n == len(encoded) {
		w.previousCR = previousCR
		return len(p), err
	}
	if err == nil {
		err = io.ErrShortWrite
	}
	consumed := 0
	for _, b := range p {
		size := 1
		if b == '\n' && !w.previousCR {
			size++
		}
		if n < size {
			break
		}
		n -= size
		consumed++
		w.previousCR = b == '\r'
	}
	return consumed, err
}
