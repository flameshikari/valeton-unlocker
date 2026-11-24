package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type cliOptions struct {
	help, version, headless bool
	host                    string
	port                    int
	portSpecified           bool
}

func parseCLI(args []string) (cliOptions, error) {
	var options cliOptions
	if len(args) > 0 {
		switch args[0] {
		case "help", "version", "serve":
			command := map[string]string{"help": "--help", "version": "--version", "serve": "--headless"}[args[0]]
			args = append([]string{command}, args[1:]...)
		}
	}
	flags := flag.NewFlagSet("valeton-unlocker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&options.help, "help", false, "Show this help")
	flags.BoolVar(&options.help, "h", false, "Show this help")
	flags.BoolVar(&options.version, "version", false, "Show version")
	flags.BoolVar(&options.version, "v", false, "Show version")
	flags.BoolVar(&options.headless, "headless", false, "Run only the HTTP server")
	flags.BoolVar(&options.headless, "s", false, "Run only the HTTP server")
	flags.StringVar(&options.host, "host", "127.0.0.1", "Address to listen on")
	flags.StringVar(&options.host, "H", "127.0.0.1", "Address to listen on")
	flags.IntVar(&options.port, "port", 8080, "Port to listen on")
	flags.IntVar(&options.port, "p", 8080, "Port to listen on")
	if err := flags.Parse(args); err != nil {
		return cliOptions{}, err
	}
	if flags.NArg() != 0 {
		return cliOptions{}, fmt.Errorf("unexpected argument: %s", flags.Arg(0))
	}
	if options.port < 0 || options.port > 65535 {
		return cliOptions{}, fmt.Errorf("--port must be between 0 and 65535")
	}
	if strings.TrimSpace(options.host) == "" {
		return cliOptions{}, fmt.Errorf("--host cannot be empty")
	}
	flags.Visit(func(option *flag.Flag) {
		if option.Name == "port" || option.Name == "p" {
			options.portSpecified = true
		}
	})
	return options, nil
}

type cliPalette struct{ name, version, heading, option, parameter, error, reset string }

func palette(w io.Writer) (cliPalette, func()) {
	_, force := os.LookupEnv("FORCE_COLOR")
	_, noColor := os.LookupEnv("NO_COLOR")
	colored, restore := false, func() {}
	if force || !noColor {
		if terminal, ok := w.(interface{ enableColor() (bool, func()) }); ok {
			colored, restore = terminal.enableColor()
		}
	}
	if !force && !colored {
		return cliPalette{}, restore
	}
	return cliPalette{
		name: "\x1b[1m\x1b[32m", version: "\x1b[90m", heading: "\x1b[1m\x1b[33m",
		option: "\x1b[36m", parameter: "\x1b[2m", error: "\x1b[31m", reset: "\x1b[0m",
	}, restore
}

func (s cliPalette) optionKey(key string) string {
	parts := strings.Split(key, " ")
	for i, part := range parts {
		if strings.HasPrefix(part, "-") {
			name := strings.TrimSuffix(part, ",")
			parts[i] = s.option + name + s.reset + strings.TrimPrefix(part, name)
		} else if part != "" {
			parts[i] = s.parameter + part + s.reset
		}
	}
	return strings.Join(parts, " ")
}

func writeHelp(w io.Writer) {
	style, restore := palette(w)
	defer restore()
	fmt.Fprintf(w, "%sValeton Unlocker%s %s%s%s - Pedal language utility\n\n", style.name, style.reset, style.version, version, style.reset)
	fmt.Fprintf(w, "%sUsage:%s %s [OPTIONS]\n", style.heading, style.reset, filepath.Base(os.Args[0]))
	options := []struct{ key, description string }{
		{"-h, --help", "Show this help"},
		{"-v, --version", "Show version"},
		{"-s, --headless", "Run only the HTTP server"},
		{"-H, --host ADDRESS", "Address to listen on (default: 127.0.0.1)"},
		{"-p, --port PORT", "Port to listen on (default: 8080)"},
	}
	width := 0
	for _, option := range options {
		width = max(width, len(option.key))
	}
	fmt.Fprintf(w, "\n%sOptions:%s\n", style.heading, style.reset)
	for _, option := range options {
		fmt.Fprintf(w, "  %s%s  %s\n", style.optionKey(option.key), strings.Repeat(" ", width-len(option.key)), option.description)
	}
	fmt.Fprintln(w, "\nWith no options, open the desktop window on Windows.")
	fmt.Fprintln(w, "Commands help, version, and serve are also accepted.")
}

func writeCLIError(w io.Writer, err error) {
	style, restore := palette(w)
	defer restore()
	fmt.Fprintf(w, "%sError:%s %v\nRun --help for usage.\n", style.error, style.reset, err)
}

func writeListening(w io.Writer, address string) {
	style, restore := palette(w)
	defer restore()
	fmt.Fprintf(w, "%sValeton Unlocker%s %s%s%s\n%sListening:%s %s%s%s\n", style.name, style.reset,
		style.version, version, style.reset, style.heading, style.reset, style.option, address, style.reset)
}
