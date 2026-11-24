package main

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// The CUI subsystem lets shells wait for CLI commands. The detached child
// keeps the default desktop launch free of a terminal window on every Windows
// release, including those before the 24H2 manifest policy.
func launchBackground(args []string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	child := exec.Command(executable, append([]string{backgroundArgument}, args...)...)
	child.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS}
	if err := child.Start(); err != nil {
		return err
	}
	windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow").Call(uintptr(child.Process.Pid))
	return child.Process.Release()
}
