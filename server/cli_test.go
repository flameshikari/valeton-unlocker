package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCLIOptions(t *testing.T) {
	for _, args := range [][]string{{"-h"}, {"--help"}, {"help"}} {
		options, err := parseCLI(args)
		if err != nil || !options.help {
			t.Fatalf("help %q: %+v, %v", args, options, err)
		}
	}
	for _, args := range [][]string{{"-v"}, {"--version"}, {"version"}} {
		options, err := parseCLI(args)
		if err != nil || !options.version {
			t.Fatalf("version %q: %+v, %v", args, options, err)
		}
	}
	for _, args := range [][]string{{"-s", "-H", "0.0.0.0", "-p", "9000"}, {"--headless", "--host=0.0.0.0", "--port=9000"}, {"serve", "-H", "0.0.0.0", "-p", "9000"}} {
		options, err := parseCLI(args)
		if err != nil || !options.headless || options.host != "0.0.0.0" || options.port != 9000 || !options.portSpecified {
			t.Fatalf("serve %q: %+v, %v", args, options, err)
		}
	}
	for _, args := range [][]string{{"--port=-1"}, {"-p", "65536"}, {"--host="}, {"--unknown"}, {"--headless", "extra"}} {
		if _, err := parseCLI(args); err == nil {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
}

func TestCLIHelpAndColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	var plain bytes.Buffer
	writeHelp(&plain)
	for _, flag := range []string{"-h, --help", "-v, --version", "-s, --headless", "-H, --host ADDRESS", "-p, --port PORT"} {
		if !strings.Contains(plain.String(), flag) {
			t.Fatalf("missing %s in help", flag)
		}
	}
	if strings.Contains(plain.String(), "\x1b[") {
		t.Fatal("NO_COLOR output contains ANSI escapes")
	}
	t.Setenv("FORCE_COLOR", "1")
	var colored bytes.Buffer
	writeHelp(&colored)
	if !strings.Contains(colored.String(), "\x1b[1m\x1b[32mValeton Unlocker") || !strings.Contains(colored.String(), "\x1b[36m--host\x1b[0m") {
		t.Fatal("forced color is missing")
	}
}
