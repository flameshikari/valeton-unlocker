#!/usr/bin/env bash
# Sign a patched APK inside the mobiledevops/android-sdk-image container.
# No host install required beyond Docker.
#
# Usage (from repo root):
#   ./tools/sign_apk.sh path/to/patched.apk
#
# Output goes next to the input with a `-signed` suffix. A one-off
# `debug.keystore` is generated alongside the script on the first run and
# reused thereafter.

set -euo pipefail

IN="${1:-}"
if [[ -z "$IN" || ! -f "$IN" ]]; then
    echo "usage: $0 <path/to/unsigned.apk>" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="mobiledevops/android-sdk-image"
BT="/opt/android-sdk-linux/build-tools/34.0.0"
KEYSTORE_REL="${KEYSTORE:-.keys/debug.keystore}"
KEY_ALIAS="${KEY_ALIAS:-valetonpatch}"
KEY_PASS="${KEY_PASS:-android}"

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
    "$IMG" \
    bash -c "
        set -e
        if [[ ! -f '$KEYSTORE_REL' ]]; then
            echo '>> generating keystore at $KEYSTORE_REL'
            keytool -genkeypair -v \
                -keystore '$KEYSTORE_REL' \
                -storepass $KEY_PASS -keypass $KEY_PASS \
                -alias $KEY_ALIAS \
                -keyalg RSA -keysize 2048 -validity 10000 \
                -dname 'CN=Valeton Patch, OU=Local, O=Local, L=Local, ST=Local, C=ZZ'
        fi

        TMP_ALIGNED=\"\$(mktemp --suffix=.apk)\"
        echo '>> zipalign'
        $BT/zipalign -p -f 4 '$REL_IN' \"\$TMP_ALIGNED\"

        echo '>> apksigner sign'
        $BT/apksigner sign \
            --ks '$KEYSTORE_REL' \
            --ks-pass pass:$KEY_PASS \
            --key-pass pass:$KEY_PASS \
            --ks-key-alias $KEY_ALIAS \
            --out '$OUT_REL' \
            \"\$TMP_ALIGNED\"

        echo '>> apksigner verify'
        $BT/apksigner verify --verbose '$OUT_REL' | tail -8
        rm -f \"\$TMP_ALIGNED\"
    "

echo
echo "Signed APK -> $REPO_ROOT/$OUT_REL"
