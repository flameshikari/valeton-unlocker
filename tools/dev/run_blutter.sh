#!/usr/bin/env bash
# Decompile a Flutter libapp.so with blutter inside Docker.
# First run takes 20-40 minutes (Dart SDK download + build); subsequent
# runs reuse the named docker volume `valeton_blutter_cache`.
#
# Usage (from repo root):
#   unzip -o "Valeton Suite V2.0.X.apk" -d apk_unpacked
#   ./tools/dev/run_blutter.sh                       # defaults below
#   ./tools/dev/run_blutter.sh path/to/lib/arm64-v8a out_dir
#
# Env knobs:
#   IMG       docker image name (default: valeton-blutter:latest)
#   CACHE_VOL named volume for Dart SDK + build artefacts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB_DIR_REL="${1:-apk_unpacked/lib/arm64-v8a}"
OUT_DIR_REL="${2:-blutter_out}"
IMG="${IMG:-valeton-blutter:latest}"
CACHE_VOL="${CACHE_VOL:-valeton_blutter_cache}"

if [[ ! -d "$REPO_ROOT/$LIB_DIR_REL" ]]; then
    echo "ERROR: $REPO_ROOT/$LIB_DIR_REL not found." >&2
    echo "  Unzip your APK first, e.g.:" >&2
    echo "    unzip -o your.apk -d apk_unpacked" >&2
    exit 1
fi

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo ">> Building blutter image (one-time, ~5 min)"
    docker build -t "$IMG" -f "$REPO_ROOT/tools/dev/Dockerfile.blutter" "$REPO_ROOT/tools/dev"
fi

# Make sure the cache volume is owned by the invoking user.
docker run --rm -v "$CACHE_VOL:/cache" alpine \
    chown -R "$(id -u):$(id -g)" /cache >/dev/null

mkdir -p "$REPO_ROOT/$OUT_DIR_REL"

echo ">> Running blutter — first run downloads Dart SDK and builds the analyzer (~30 min)."
echo ">> Output: $REPO_ROOT/$OUT_DIR_REL"

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/work" \
    -v "$CACHE_VOL:/opt/blutter_cache" \
    -w /opt/blutter \
    "$IMG" \
    bash -lc "
        set -e
        for d in dartsdk build bin packages; do
            mkdir -p /opt/blutter_cache/\$d
            rm -rf /opt/blutter/\$d
            ln -s /opt/blutter_cache/\$d /opt/blutter/\$d
        done
        python3 blutter.py /work/$LIB_DIR_REL /work/$OUT_DIR_REL
    "

echo
echo ">> Done. Interesting files:"
echo "     $OUT_DIR_REL/pp.txt          # all Dart objects in the object pool"
echo "     $OUT_DIR_REL/asm/*.dart      # per-class assembly with Dart symbols"
echo "     $OUT_DIR_REL/blutter_frida.js"
