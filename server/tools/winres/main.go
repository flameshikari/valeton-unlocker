// Generate the Windows icon, version metadata, and console manifest.
package main

import (
	"fmt"
	"os"
	"regexp"
	"strconv"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

var releasePattern = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$`)

func resources(iconPath, manifestPath, release string) (*winres.ResourceSet, error) {
	parts := releasePattern.FindStringSubmatch(release)
	if parts == nil {
		return nil, fmt.Errorf("invalid release version: %q", release)
	}
	var numbers [4]uint16
	for i := 0; i < 3; i++ {
		value, err := strconv.ParseUint(parts[i+1], 10, 16)
		if err != nil {
			return nil, fmt.Errorf("invalid Windows version: %w", err)
		}
		numbers[i] = uint16(value)
	}
	iconFile, err := os.Open(iconPath)
	if err != nil {
		return nil, err
	}
	defer iconFile.Close()
	icon, err := winres.LoadICO(iconFile)
	if err != nil {
		return nil, err
	}
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	resourceSet := &winres.ResourceSet{}
	if err := resourceSet.SetIcon(winres.ID(1), icon); err != nil {
		return nil, err
	}
	info := version.Info{FileVersion: numbers, ProductVersion: numbers, Type: version.App}
	for key, value := range map[string]string{
		version.ProductName:      "Valeton Unlocker",
		version.FileDescription:  "Valeton Unlocker",
		version.CompanyName:      "flameshikari",
		version.InternalName:     "valeton-unlocker",
		version.OriginalFilename: "valeton-unlocker.exe",
		version.FileVersion:      release,
		version.ProductVersion:   release,
		version.Comments:         "https://github.com/flameshikari/valeton-unlocker",
		version.LegalCopyright:   "© 2026 flameshikari",
	} {
		if err := info.Set(version.LangDefault, key, value); err != nil {
			return nil, err
		}
	}
	resourceSet.SetVersionInfo(info)
	if err := resourceSet.Set(winres.RT_MANIFEST, winres.ID(1), winres.LCIDDefault, manifest); err != nil {
		return nil, err
	}
	return resourceSet, nil
}

func generate(iconPath, manifestPath, release, arch, output string) error {
	if arch != "amd64" && arch != "arm64" {
		return fmt.Errorf("unsupported architecture: %s", arch)
	}
	resourceSet, err := resources(iconPath, manifestPath, release)
	if err != nil {
		return err
	}
	file, err := os.Create(output)
	if err != nil {
		return err
	}
	if err := resourceSet.WriteObject(file, winres.Arch(arch)); err != nil {
		file.Close()
		os.Remove(output)
		return err
	}
	return file.Close()
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: winres ICON.ico MANIFEST.xml VERSION ARCH OUTPUT.syso")
		os.Exit(2)
	}
	if err := generate(os.Args[1], os.Args[2], os.Args[3], os.Args[4], os.Args[5]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
