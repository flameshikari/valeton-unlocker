package main

import (
	"bytes"
	"testing"
)

func TestConsoleWriterLineEndings(t *testing.T) {
	var output bytes.Buffer
	writer := &consoleWriter{writer: &output}
	for _, chunk := range []string{"first\n", "second\r", "\n", "\n"} {
		if n, err := writer.Write([]byte(chunk)); n != len(chunk) || err != nil {
			t.Fatalf("write = %d, %v", n, err)
		}
	}
	if got, want := output.String(), "first\r\nsecond\r\n\r\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
