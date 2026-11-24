package main

import (
	"log"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// GUI startup stays detached. CLI arguments reuse the caller's console while
// keeping redirected pipes intact, following OmniSSHAgent's console handling.
func attachParentConsole() {
	if len(os.Args) <= 1 || os.Args[1] == backgroundArgument || usableStandardStream(os.Stdout) || usableStandardStream(os.Stderr) || launchedByWSL() {
		return
	}
	if attached, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole").Call(^uintptr(0)); attached == 0 {
		return
	}
	for _, stream := range []struct {
		id   uint32
		file **os.File
	}{{windows.STD_OUTPUT_HANDLE, &os.Stdout}, {windows.STD_ERROR_HANDLE, &os.Stderr}} {
		if usableStandardStream(*stream.file) {
			continue
		}
		if handle, err := windows.GetStdHandle(stream.id); err == nil && handle != 0 && handle != windows.InvalidHandle {
			if _, err := windows.GetFileType(handle); err == nil {
				*stream.file = os.NewFile(uintptr(handle), "console")
				continue
			}
		}
		if file, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			*stream.file = file
		}
	}
	log.SetOutput(os.Stderr)
}

func usableStandardStream(file *os.File) bool {
	if file == nil {
		return false
	}
	handle := windows.Handle(file.Fd())
	if handle == 0 || handle == windows.InvalidHandle {
		return false
	}
	_, err := windows.GetFileType(handle)
	return err == nil
}

func launchedByWSL() bool {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	var parent uint32
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if entry.ProcessID == windows.GetCurrentProcessId() {
			parent = entry.ParentProcessID
			break
		}
	}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if parent != 0 && entry.ProcessID == parent {
			switch strings.ToLower(windows.UTF16ToString(entry.ExeFile[:])) {
			case "wsl.exe", "wslhost.exe", "wslrelay.exe":
				return true
			}
			break
		}
	}
	return false
}
