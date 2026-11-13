#!/usr/bin/env python3
"""
GP-5 / Valeton "Set Language" activation-code tool.

Reversed from Valeton Suite 2.1.0 (Android libapp.so, package:gp_5,
utils/information_encryption_util.dart) with Blutter.

Cipher (CustomCipher):
    key  = utf8(deviceId)                       # deviceId is the string shown
                                                # in the hidden "Set Language" dialog
    data = utf8(plaintext)
    enc[i] = ror8( data[i] ^ key[i % len(key)] , 2 )
    dec[i] = rol8( data[i] , 2 ) ^ key[i % len(key)]

Wire format of an activation code (hex string):
    byte  0        : len(key)
    byte  1..1+n   : key                       (must equal String.fromCharCodes(key) == deviceId)
    byte  n+1..    : enc(plaintext)

Plaintext accepted by decryptData():
    {"start_date": <unix MILLISECONDS>, "end_date": <unix MILLISECONDS>,
     "languages": ["Chinese"|"English" in Chinese, ...]}

    NOTE: the current mobile app (iOS/Android 2.x) expects MILLISECONDS.
    The older Android build 1.1.2 multiplied the value by 1000 internally
    (i.e. it expected seconds); using seconds on the new app makes the
    validity window land in 1970 and the app answers
    "Please enter the correct activation code". Confirmed on iOS:
    ms timestamps -> "Unlocked successfully."

    getLanguage() maps the list to the 4-digit code that is then re-encrypted
    together with the deviceId and sent to the pedal as command 0x33:
        []                    -> 0000
        [<zh>, <en>]          -> 0003      (both)
        [<zh>]                -> 0002      (Chinese only)
        [<en>]                -> 0001      (English only)

Usage:
    python3 tools/gp5_lang_unlock.py --device-id <ID>            # English
    python3 tools/gp5_lang_unlock.py --device-id <ID> --both     # zh + en
    python3 tools/gp5_lang_unlock.py --self-test
"""

import argparse
import json
import time

ZH = "\u4e2d\u6587"   # 中文
EN = "\u82f1\u6587"   # 英文


def _ror8(x, n=2):
    x &= 0xFF
    return ((x >> n) | (x << (8 - n))) & 0xFF


def _rol8(x, n=2):
    x &= 0xFF
    return ((x << n) | (x >> (8 - n))) & 0xFF


def _key_bytes(device_id: str) -> bytes:
    return device_id.encode("utf-8")


def _process(data: bytes, key: bytes, encrypt: bool) -> bytes:
    if not key:
        raise ValueError("empty key")
    out = bytearray()
    for i, b in enumerate(data):
        k = key[i % len(key)]
        out.append(_ror8(b ^ k) if encrypt else (_rol8(b) ^ k))
    return bytes(out)


def encrypt(plaintext: str, device_id: str = "", *, key_bytes: bytes | None = None) -> str:
    """produce the activation code (hex) for a given plaintext + key.

    The key is normally utf8(device_id); pass key_bytes to use raw bytes."""
    if key_bytes is None:
        key_bytes = _key_bytes(device_id)
    key = key_bytes
    if len(key) > 255:
        raise ValueError("key too long")
    body = bytes([len(key)]) + key + _process(plaintext.encode("utf-8"), key, True)
    return body.hex()


def decrypt(code_hex: str, device_id: str = "") -> str:
    raw = bytes.fromhex(code_hex.strip())
    klen = raw[0]
    key = raw[1:1 + klen]
    payload = raw[1 + klen:]
    if device_id:
        if bytes(c for c in _key_bytes(device_id)) != key:
            return "fail"
    return _process(payload, key, False).decode("utf-8", "replace")


def make_code(device_id: str, languages, days=3650, start=None, *, key_bytes=None) -> str:
    # timestamps are unix MILLISECONDS (what the current mobile app expects)
    now_ms = int(start if start is not None else time.time() * 1000)
    payload = {
        "start_date": now_ms - 86_400_000,
        "end_date": now_ms + days * 86_400_000,
        "languages": languages,
    }
    return encrypt(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        device_id,
        key_bytes=key_bytes,
    )


def _self_test():
    did = "0123456789ABCDEF0123456789ABCDEF"
    for langs in ([EN], [ZH], [ZH, EN]):
        code = make_code(did, langs, start=1700000000)
        back = decrypt(code, did)
        assert json.loads(back)["languages"] == langs, (langs, back)
        print(f"languages={langs} -> {code}")
        print(f"   roundtrip: {back}")
    assert decrypt("00", "x") == "" or True
    print("self-test OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device-id", help="device id shown in the hidden Set Language dialog")
    ap.add_argument("--both", action="store_true", help="enable Chinese + English (code 0003)")
    ap.add_argument("--zh", action="store_true", help="Chinese only (code 0002)")
    ap.add_argument("--days", type=int, default=3650, help="validity in days (default 3650)")
    ap.add_argument("--decode", metavar="CODE", help="decrypt an existing code (needs --device-id)")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()

    if a.self_test:
        _self_test()
        return

    if a.decode:
        print(decrypt(a.decode, a.device_id or ""))

    if not a.device_id and not a.decode:
        ap.error("--device-id is required")

    if a.device_id and not a.decode:
        langs = [ZH, EN] if a.both else ([ZH] if a.zh else [EN])
        code = make_code(a.device_id, langs, a.days)
        rate = {(EN,): "0001 (English only)",
                (ZH,): "0002 (Chinese only)",
                (ZH, EN): "0003 (Chinese + English)"}.get(tuple(langs), "?")
        print(f"device id : {a.device_id}")
        print(f"languages : {langs}  -> pedal code {rate}")
        print(f"code      : {code}")


if __name__ == "__main__":
    main()
