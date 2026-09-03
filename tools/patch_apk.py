#!/usr/bin/env python3
"""
Valeton Suite APK patcher.

Hijacks one ARM64 conditional branch in `lib/arm64-v8a/libapp.so` so the
Flutter app stops force-switching its UI to Chinese when it sees a
Chinese-region pedal. The patch is byte-for-byte size-preserving so the
Dart AOT snapshot offsets stay intact.

Discovered by decompiling `GlobalModel.updateGlobalLanguage` with blutter:

    int  code = coverCharListToInt(pedalReportedLanguageBytes);
    String lang = (code == 1) ? "zh" : "en";   // <-- this branch
    staticState.currentLanguage = lang;        // drives the locale

We replace the `b.ne` (branch if not equal) with an unconditional `b`, so
the right-hand side is always reached and `lang` is always `"en"`.

After patching, the APK still needs to be re-signed. See `tools/sign_apk.sh`.
"""

from __future__ import annotations

import argparse
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

LIBAPP_PATH_CANDIDATES = (
    "lib/arm64-v8a/libapp.so",
    "lib/armeabi-v7a/libapp.so",
    "lib/x86_64/libapp.so",
    "lib/x86/libapp.so",
)


@dataclass(frozen=True)
class BinaryPatch:
    """A length-preserving byte replacement in libapp.so."""

    name: str
    description: str
    original: bytes
    replacement: bytes

    def __post_init__(self) -> None:
        if len(self.original) != len(self.replacement):
            raise ValueError(
                f"{self.name}: lengths differ ({len(self.original)} vs {len(self.replacement)})"
            )


# The whole show. 40 bytes of context guarantee uniqueness inside libapp.so;
# only 4 bytes actually change — the `b.ne` instruction becomes `b`.
FORCE_EN_BRANCH_V204 = BinaryPatch(
    name="force-en-branch-v2.0.4",
    description=(
        "Rewrite the ARM64 conditional branch in GlobalModel.updateGlobalLanguage"
        " (libapp.so offset 0x6c159c) so the language assignment always lands on"
        ' the `"en"` branch.'
    ),
    original=bytes.fromhex(
        "a2835ef861000094a1835ff820f000f8"
        "1f0400f181000054"
        "613b4091213c45f90300001461434091"
    ),
    replacement=bytes.fromhex(
        "a2835ef861000094a1835ff820f000f8"
        "1f0400f104000014"
        "613b4091213c45f90300001461434091"
    ),
)

FORCE_EN_BRANCH_V210 = BinaryPatch(
    name="force-en-branch-v2.1.0",
    description=(
        "Rewrite the ARM64 conditional branch in GlobalModel.updateGlobalLanguage"
        " (libapp.so offset 0x645ea4) so the language assignment always lands on"
        ' the `"en"` branch.'
    ),
    original=bytes.fromhex(
        "a2835ef860000094a1835ff820f000f8"
        "1f0400f181000054"
        "613b409121cc46f90300001461434091"
    ),
    replacement=bytes.fromhex(
        "a2835ef860000094a1835ff820f000f8"
        "1f0400f104000014"
        "613b409121cc46f90300001461434091"
    ),
)

FORCE_EN_BRANCH_BY_VERSION_CODE = {
    206: FORCE_EN_BRANCH_V204,
    214: FORCE_EN_BRANCH_V210,
}

# Optional diagnostic — replaces the original trigger toast with a marker
# you can read on screen to confirm that the patched .so is actually loaded.
# Same length as the original suffix.
DIAGNOSTIC_TOAST = BinaryPatch(
    name="diagnostic-toast",
    description=(
        "Replace the original auto-switch toast suffix with a recognisable"
        " marker. Off by default — turn it on with --diagnostic for a sanity"
        " check that the patched .so is being loaded."
    ),
    original=b" to match your pedal's system language.",
    replacement=b" -- english patch active: locale stays.",
)


def find_libapp(zf: zipfile.ZipFile) -> str:
    names = set(zf.namelist())
    for cand in LIBAPP_PATH_CANDIDATES:
        if cand in names:
            return cand
    raise SystemExit(
        f"libapp.so not found in APK (looked for {LIBAPP_PATH_CANDIDATES})"
    )


def apply(
    data: bytes, patches: list[BinaryPatch]
) -> tuple[bytes, list[tuple[str, int]]]:
    buf = bytearray(data)
    applied: list[tuple[str, int]] = []
    for p in patches:
        hits = []
        start = 0
        while True:
            idx = buf.find(p.original, start)
            if idx < 0:
                break
            hits.append(idx)
            start = idx + 1
        if len(hits) != 1:
            raise SystemExit(
                f"{p.name}: expected exactly 1 match in libapp.so, got {len(hits)}. "
                "Either this is a different app version, or it's already patched."
            )
        off = hits[0]
        buf[off : off + len(p.original)] = p.replacement
        applied.append((p.name, off))
    return bytes(buf), applied


def _read_length8(data: bytes, offset: int) -> tuple[int, int]:
    value = data[offset]
    offset += 1
    if value & 0x80:
        value = ((value & 0x7F) << 8) | data[offset]
        offset += 1
    return value, offset


def _read_length16(data: bytes, offset: int) -> tuple[int, int]:
    value = struct.unpack_from("<H", data, offset)[0]
    offset += 2
    if value & 0x8000:
        value = ((value & 0x7FFF) << 16) | struct.unpack_from("<H", data, offset)[0]
        offset += 2
    return value, offset


def _parse_string_pool(data: bytes, offset: int) -> list[str]:
    header_size = struct.unpack_from("<H", data, offset + 2)[0]
    string_count = struct.unpack_from("<I", data, offset + 8)[0]
    flags = struct.unpack_from("<I", data, offset + 16)[0]
    strings_start = struct.unpack_from("<I", data, offset + 20)[0]
    utf8 = bool(flags & 0x100)
    strings = []
    for index in range(string_count):
        relative = struct.unpack_from("<I", data, offset + header_size + 4 * index)[0]
        cursor = offset + strings_start + relative
        if utf8:
            _, cursor = _read_length8(data, cursor)
            byte_length, cursor = _read_length8(data, cursor)
            strings.append(data[cursor : cursor + byte_length].decode("utf-8"))
        else:
            char_length, cursor = _read_length16(data, cursor)
            strings.append(data[cursor : cursor + char_length * 2].decode("utf-16le"))
    return strings


def read_version_code(manifest: bytes) -> int:
    """Read android:versionCode from a compiled binary Android manifest."""
    if len(manifest) < 8 or struct.unpack_from("<H", manifest)[0] != 0x0003:
        raise SystemExit("AndroidManifest.xml is not a compiled binary XML file")

    strings: list[str] | None = None
    offset = 8
    while offset + 8 <= len(manifest):
        chunk_type, header_size, chunk_size = struct.unpack_from(
            "<HHI", manifest, offset
        )
        if chunk_size < header_size or offset + chunk_size > len(manifest):
            raise SystemExit("AndroidManifest.xml contains an invalid chunk")
        if chunk_type == 0x0001:
            strings = _parse_string_pool(manifest, offset)
        elif chunk_type == 0x0102 and strings is not None:
            extension = offset + 16
            element_name = strings[struct.unpack_from("<I", manifest, extension + 4)[0]]
            if element_name == "manifest":
                attribute_start, attribute_size, attribute_count = struct.unpack_from(
                    "<HHH", manifest, extension + 8
                )
                for index in range(attribute_count):
                    attribute = extension + attribute_start + index * attribute_size
                    name_index = struct.unpack_from("<I", manifest, attribute + 4)[0]
                    if strings[name_index] == "versionCode":
                        value_type = manifest[attribute + 15]
                        if value_type not in (0x10, 0x11):
                            raise SystemExit("android:versionCode is not an integer")
                        return struct.unpack_from("<I", manifest, attribute + 16)[0]
        offset += chunk_size
    raise SystemExit("android:versionCode not found in AndroidManifest.xml")


def repack(src: Path, dst: Path, libapp_path: str, libapp_bytes: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src, "r") as zsrc, zipfile.ZipFile(dst, "w") as zdst:
        for info in zsrc.infolist():
            if info.filename.startswith("META-INF/"):
                # Existing signature is invalidated by repacking; drop it.
                continue
            if info.filename == libapp_path:
                new_info = zipfile.ZipInfo(info.filename, info.date_time)
                new_info.compress_type = info.compress_type
                new_info.external_attr = info.external_attr
                zdst.writestr(new_info, libapp_bytes)
            else:
                zdst.writestr(info, zsrc.read(info.filename))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="patch_apk",
        description="Patch the Chinese auto-switch out of the Valeton Suite APK.",
    )
    parser.add_argument("-i", "--input", required=True, help="Source (unmodified) APK")
    parser.add_argument(
        "-o",
        "--output",
        help="Destination APK (default: <input>-patched.apk)",
    )
    parser.add_argument(
        "--diagnostic",
        action="store_true",
        help="Also rewrite the trigger toast text with a visible marker.",
    )
    parser.add_argument(
        "--version-code",
        type=int,
        help="Override the versionCode read from AndroidManifest.xml.",
    )
    args = parser.parse_args(argv)

    src = Path(args.input)
    if not src.exists():
        raise SystemExit(f"APK not found: {src}")

    with zipfile.ZipFile(src, "r") as zf:
        libapp_path = find_libapp(zf)
        libapp_bytes = zf.read(libapp_path)
        detected_version_code = read_version_code(zf.read("AndroidManifest.xml"))

    version_code = (
        args.version_code if args.version_code is not None else detected_version_code
    )
    try:
        force_en_patch = FORCE_EN_BRANCH_BY_VERSION_CODE[version_code]
    except KeyError:
        supported = ", ".join(map(str, FORCE_EN_BRANCH_BY_VERSION_CODE))
        raise SystemExit(
            f"Unsupported versionCode {version_code}; supported versionCodes: {supported}."
        ) from None

    patches = [force_en_patch]
    if args.diagnostic:
        patches.append(DIAGNOSTIC_TOAST)

    print(f"libapp.so in APK: {libapp_path} ({len(libapp_bytes):,} bytes)")
    print(f"APK versionCode: {detected_version_code}")
    if args.version_code is not None:
        print(f"Using overridden versionCode: {version_code}")
    print(f"Applying: {[p.name for p in patches]}")
    patched, applied = apply(libapp_bytes, patches)
    if len(patched) != len(libapp_bytes):
        raise SystemExit("internal error: libapp.so size changed")

    for name, off in applied:
        print(f"  {name}: patched at offset 0x{off:x}")

    dst = (
        Path(args.output)
        if args.output
        else src.with_name(f"{src.stem}-patched{src.suffix}")
    )
    repack(src, dst, libapp_path, patched)
    print(f"\nPatched APK: {dst}")
    print("Next: re-sign with `tools/sign_apk.sh` then `adb install -r`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
