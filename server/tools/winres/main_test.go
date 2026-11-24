package main

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func testIcon(t *testing.T) string {
	t.Helper()
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 16, 16))); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 22)
	binary.LittleEndian.PutUint16(data[2:], 1)
	binary.LittleEndian.PutUint16(data[4:], 1)
	data[6], data[7] = 16, 16
	binary.LittleEndian.PutUint16(data[10:], 1)
	binary.LittleEndian.PutUint16(data[12:], 32)
	binary.LittleEndian.PutUint32(data[14:], uint32(picture.Len()))
	binary.LittleEndian.PutUint32(data[18:], 22)
	path := filepath.Join(t.TempDir(), "favicon.ico")
	if err := os.WriteFile(path, append(data, picture.Bytes()...), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWindowsResources(t *testing.T) {
	icon := testIcon(t)
	manifestPath := filepath.Join("..", "..", "app.manifest")
	resourceSet, err := resources(icon, manifestPath, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resourceSet.GetIcon(winres.ID(1)); err != nil {
		t.Fatal(err)
	}
	info, err := version.FromBytes(resourceSet.Get(winres.RT_VERSION, winres.ID(1), version.LangDefault))
	if err != nil {
		t.Fatal(err)
	}
	if info.FileVersion != [4]uint16{1, 0, 0, 0} || info.ProductVersion != info.FileVersion {
		t.Fatal("wrong numeric version")
	}
	table := *info.Table()[version.LangDefault]
	for key, want := range map[string]string{
		version.ProductName:      "Valeton Unlocker",
		version.FileDescription:  "Valeton Unlocker",
		version.CompanyName:      "flameshikari",
		version.InternalName:     "valeton-unlocker",
		version.OriginalFilename: "valeton-unlocker.exe",
		version.FileVersion:      "1.0.0",
		version.ProductVersion:   "1.0.0",
		version.Comments:         "https://github.com/flameshikari/valeton-unlocker",
	} {
		if table[key] != want {
			t.Fatalf("metadata %s = %q, want %q", key, table[key], want)
		}
	}
	manifest := string(resourceSet.Get(winres.RT_MANIFEST, winres.ID(1), winres.LCIDDefault))
	if !strings.Contains(manifest, ">detached</consoleAllocationPolicy>") {
		t.Fatal("Windows 24H2 console policy is missing")
	}
	for arch, machine := range map[string]uint16{"amd64": pe.IMAGE_FILE_MACHINE_AMD64, "arm64": pe.IMAGE_FILE_MACHINE_ARM64} {
		output := filepath.Join(t.TempDir(), "resources.syso")
		if err := generate(icon, manifestPath, "1.0.0", arch, output); err != nil {
			t.Fatal(err)
		}
		file, err := pe.Open(output)
		if err != nil {
			t.Fatal(err)
		}
		if file.Machine != machine {
			t.Fatalf("%s: wrong COFF architecture", arch)
		}
		file.Close()
	}
	for _, invalid := range []string{"dev", "1.0", "65536.0.0"} {
		if _, err := resources(icon, manifestPath, invalid); err == nil {
			t.Fatalf("accepted invalid release %q", invalid)
		}
	}
}
