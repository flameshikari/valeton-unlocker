# Valeton Suite English Patch

Stops the **Valeton Suite Android app** from force-switching its UI to
Chinese when it connects to a Chinese-region pedal. Four bytes change in
`lib/arm64-v8a/libapp.so`, the rest of the snapshot is bit-identical.

> **Tested on**: Valeton Suite **V2.0.4** for Android, GP-5 BLE pedal.
> Other versions may need fresh byte signatures — see
> [_For developers_](#for-developers) below.

## Disclaimer

The re-signed APK is not endorsed by Valeton / Sonicake. The original APK
is not distributed in this repository — grab it yourself from [Valeton](https://www.valeton.net/software/#138-170-wpfd-android).

## Option A — Patch via GitHub Actions

If you forked this repo on GitHub:

1. Open **[Actions → Patch APK](../../actions/workflows/patch.yml) → Run workflow**.
2. Paste a direct download URL of the original Valeton Suite APK, or of
   the ZIP archive containing it and run it.
3. Wait ~1 minute, download the `valeton-suite-patched` artifact, install:
   ```bash
   adb uninstall com.sonicake.gp_5
   adb install patched-signed.apk
   ```

The APK is signed with a throw-away debug key — Android will warn that
the signing certificate differs from the Play Store version, which is
normal for self-signed builds.

## Option B — Patch Locally

Requirements: Python 3.9+ (no third-party packages), Docker (for
re-signing without polluting the host), and `adb`.

```bash
python3 tools/patch_apk.py \
    -i "Valeton Suite V2.0.4 for Android.apk" \
    -o patched.apk

./tools/sign_apk.sh patched.apk

adb uninstall com.sonicake.gp_5
adb install patched-signed.apk
```

Connect the pedal — the app stays in English.

## How It Works

The Valeton Suite Flutter app reads a language code from the pedal during
the BLE handshake and runs roughly this code (recovered from
`lib/arm64-v8a/libapp.so` with [blutter](https://github.com/worawit/blutter)):

```dart
int code = coverCharListToInt(pedalReportedLanguageBytes);
String lang = (code == 1) ? "zh" : "en";    // <-- this branch
staticState.currentLanguage = lang;          // drives the locale
```

The patcher rewrites the single ARM64 conditional branch at `libapp.so`
offset `0x6c159c`: `b.ne` becomes `b`, so the right-hand side is taken
unconditionally and `lang` is always `"en"`. Four bytes change.

## Repository Layout

```
.
├── tools/
│   ├── patch_apk.py               # libapp.so patcher
│   ├── sign_apk.sh                # zipalign + apksigner in Docker
│   └── dev/                       # research / extension tools
│       ├── Dockerfile.blutter
│       ├── run_blutter.sh         # decompile libapp.so with blutter
│       └── capture_logcat.sh      # capture Flutter logs at connect time
└── .github/workflows/
    └── patch.yml              # workflow_dispatch: URL → patched APK artefact
```

The repo never stores APKs, keystores, or any other binary inputs / outputs.

## For Developers

If Valeton ships a new Suite version and the byte signature in
`patch_apk.py` no longer matches, regenerate it:

```bash
# 1. Unzip the APK locally:
unzip -o "Valeton Suite V2.0.X.apk" -d apk_unpacked

# 2. Decompile lib/arm64-v8a/libapp.so. The first run downloads the
# matching Dart SDK and builds blutter (~30 min, cached afterwards).
./tools/dev/run_blutter.sh

# 3. Open blutter_out/asm/gp_5/model/global_model.dart and find the new
# offset of the `cmp x0, #1 ; b.ne ...` pair inside
# updateGlobalLanguage. Update the byte signature in tools/patch_apk.py.
```

To capture what the app does on the wire at connect time:

```bash
./tools/dev/capture_logcat.sh logs/pedal-connect.log
# now connect the pedal; Ctrl-C once you see the toast
```
