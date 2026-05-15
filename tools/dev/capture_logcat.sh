#!/usr/bin/env bash
# Capture Android logcat from the phone while you connect the pedal and
# the auto-switch happens — useful when porting the patch to a new app
# version, to see which Dart classes / constants are involved.
#
# Prerequisites:
#   - Phone has USB debugging enabled and is connected over USB.
#   - adb on PATH (or set ADB to a specific binary — handy on WSL with adb.exe).
#
# Usage:
#   ADB=adb.exe ./tools/dev/capture_logcat.sh logs/pedal-connect.log

set -euo pipefail

ADB="${ADB:-adb}"
PKG="${PKG:-com.sonicake.gp_5}"
OUT="${1:-logcat_$(date +%Y%m%d_%H%M%S).log}"

if ! command -v "$ADB" >/dev/null; then
    echo "ERROR: '$ADB' not found on PATH. Set ADB to the binary you want to use." >&2
    exit 1
fi

if ! "$ADB" devices | grep -qE '\bdevice$'; then
    echo "ERROR: no Android device authorised in adb." >&2
    echo "Run \`$ADB devices\` and unlock the phone / accept the debug prompt." >&2
    exit 1
fi

PID="$("$ADB" shell pidof "$PKG" 2>/dev/null || true)"
if [[ -z "$PID" ]]; then
    echo ">> $PKG is not running. Start the app on the phone first, then re-run." >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
echo ">> Capturing logcat for $PKG (pid $PID)"
echo ">> Output: $OUT"
echo ">> Connect the pedal NOW. Press Ctrl-C after the language toast appears."
echo

"$ADB" logcat -c
"$ADB" logcat --pid="$PID" -v threadtime | tee "$OUT"
