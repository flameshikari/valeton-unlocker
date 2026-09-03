#!/usr/bin/env bash
# Sign a patched APK inside the mobiledevops/android-sdk-image container.
# No host install required beyond Docker.
#
# Usage (from repo root):
#   ./tools/sign_apk.sh path/to/patched.apk
#
# Output goes next to the input with a `-signed` suffix. A one-off
# `debug.keystore` is generated alongside the script on the first run and
# reused thereafter. Set KEYSTORE, KEY_ALIAS, KEY_PASS, and optionally
# KEY_KEY_PASS to sign with an existing keystore.

set -euo pipefail

IN="${1:-}"
if [[ -z "$IN" || ! -f "$IN" ]]; then
    echo "usage: $0 <path/to/unsigned.apk>" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="mobiledevops/android-sdk-image"
BT="${BUILD_TOOLS:-/opt/android-sdk-linux/build-tools/35.0.1}"
CUSTOM_KEYSTORE=0
if [[ -n "${KEYSTORE:-}" ]]; then
    CUSTOM_KEYSTORE=1
fi
KEYSTORE_REL="${KEYSTORE:-.keys/debug.keystore}"
KEY_ALIAS="${KEY_ALIAS:-valetonpatch}"
KEY_PASS="${KEY_PASS:-android}"
KEY_KEY_PASS="${KEY_KEY_PASS:-$KEY_PASS}"

case "$KEYSTORE_REL" in
    /*|../*|*/../*|*/..)
        echo "ERROR: KEYSTORE must be a path inside the repository." >&2
        exit 1
        ;;
esac

# Make the input path repo-relative for the container bind mount.
ABS_IN="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")"
case "$ABS_IN" in
    "$REPO_ROOT"/*) REL_IN="${ABS_IN#"$REPO_ROOT"/}";;
    *)
        echo "ERROR: input APK must live inside the repository root ($REPO_ROOT)." >&2
        exit 1
        ;;
esac

BASE="${REL_IN##*/}"
STEM="${BASE%.*}"
case "$REL_IN" in
    */*) OUT_REL="${REL_IN%/*}/${STEM}-signed.apk";;
    *)   OUT_REL="${STEM}-signed.apk";;
esac

mkdir -p "$(dirname "$REPO_ROOT/$KEYSTORE_REL")"

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/work" \
    -w /work \
    -e SIGN_BT="$BT" \
    -e SIGN_IN="$REL_IN" \
    -e SIGN_OUT="$OUT_REL" \
    -e SIGN_KEYSTORE="$KEYSTORE_REL" \
    -e SIGN_KEY_ALIAS="$KEY_ALIAS" \
    -e SIGN_KEY_PASS="$KEY_PASS" \
    -e SIGN_KEY_KEY_PASS="$KEY_KEY_PASS" \
    -e SIGN_CUSTOM_KEYSTORE="$CUSTOM_KEYSTORE" \
    "$IMG" \
    bash -c '
        set -euo pipefail
        if [[ ! -f "$SIGN_KEYSTORE" && "$SIGN_CUSTOM_KEYSTORE" == 1 ]]; then
            echo "ERROR: custom keystore not found: $SIGN_KEYSTORE" >&2
            exit 1
        fi
        if [[ ! -f "$SIGN_KEYSTORE" ]]; then
            echo ">> generating keystore at $SIGN_KEYSTORE"
            keytool -genkeypair -v \
                -keystore "$SIGN_KEYSTORE" \
                -storepass "$SIGN_KEY_PASS" -keypass "$SIGN_KEY_KEY_PASS" \
                -alias "$SIGN_KEY_ALIAS" \
                -keyalg RSA -keysize 2048 -validity 10000 \
                -dname "CN=Valeton Patch, OU=Local, O=Local, L=Local, ST=Local, C=ZZ"
        fi

        TMP_ALIGNED="$(mktemp --suffix=.apk)"
        trap '\''rm -f "$TMP_ALIGNED"'\'' EXIT
        echo ">> zipalign"
        "$SIGN_BT/zipalign" -p -f 4 "$SIGN_IN" "$TMP_ALIGNED"

        echo ">> apksigner sign"
        "$SIGN_BT/apksigner" sign \
            --ks "$SIGN_KEYSTORE" \
            --ks-pass "pass:$SIGN_KEY_PASS" \
            --key-pass "pass:$SIGN_KEY_KEY_PASS" \
            --ks-key-alias "$SIGN_KEY_ALIAS" \
            --out "$SIGN_OUT" \
            "$TMP_ALIGNED"

        echo ">> apksigner verify"
        "$SIGN_BT/apksigner" verify --verbose "$SIGN_OUT" | tail -8
    '

echo
echo "Signed APK -> $REPO_ROOT/$OUT_REL"
