#!/usr/bin/env python3
"""
Valeton Unlocker command-line tool.

Reads and changes the language of supported Valeton pedals over USB MIDI on
Windows. It can also generate, decode, and validate Valeton Suite activation
codes offline on any operating system. Only the Python standard library is used.

Tested with:
    Device       Valeton GP-5
    Firmware     V1.0.6
    USB          Windows WinMM MIDI
    Offline      Python 3.12 on Linux (code generation, decoding, self-test)

The USB implementation sends exactly what the mobile Valeton Suite sends after
a successful "Set Language" activation (reversed from Android 2.1.0 with Blutter):

    0x32  requestDeviceUUid   [0x12, 0x32]                        (read)
    0x10  requestGlobalData   [0x12, 0x10]                        (read)
    0x33  PresetModel::sendLanguage
          [0x11, 0x33] + u32le(len(blob)) + blob                 (write)
          blob = generateEncryptedData(deviceId + code, key=deviceId)
               = [len(key)] + key + CustomCipher.encrypt(deviceId + code)
          code: 0001 English, 0002 Chinese, 0003 both

Wire framing (5868USB.dll / HtDevice): the payload is cut into 19-byte chunks,
each chunk is [crc8, chunk_count, chunk_index, chunk_len, *chunk] with
CRC-8 poly 0x07 init 0 over the buffer (crc slot zeroed), every byte split into
two nibbles (hi first) and wrapped in F0 .. F7.

The pedal acks every frame with payload 14 08 xx; 00 = accepted. Multi-frame writes
must wait for the ack before sending the next frame (like HtDevice does): frames
sent back to back get dropped and acked with 01.
The Device ID reply (0x32) is [12 32] + u16le(n) + [len(key)] + key + enc,
decrypted with the random key the pedal puts in front.
The global data reply (0x10) is [12 10] + TLV records [u16le key][u16le len][value]:
    0x0101 firmware version (4 bytes, 06 00 01 01 = V1.0.6)
    0x0201 language (1 = Chinese, anything else = English, GlobalModel::updateGlobalLanguage)

Before writing, the tool checks the port is a GP-5, the Device ID looks right,
the global data parses, the firmware is a tested one and the language is not
already the requested one; after writing it checks every frame was acked and
re-reads the language. --force skips the firmware / already-set checks only.

Only 0x32, 0x10 (reads) and 0x33 are ever sent. Do NOT add other selectors
without checking what they do first (0x3f, for example, is a factory reset).

Usage (Windows Python):
    python tools/valeton_unlocker.py              # show Device ID, firmware, language
    python tools/valeton_unlocker.py --en         # English   (0001)
    python tools/valeton_unlocker.py --zh         # Chinese   (0002)
    python tools/valeton_unlocker.py --both       # both      (0003)
    python tools/valeton_unlocker.py --en --dry-run

Offline activation-code tools (work on any OS):
    python tools/valeton_unlocker.py --make-code <DEVICE_ID> --en
    python tools/valeton_unlocker.py --make-code <DEVICE_ID> --both --days 3650
    python tools/valeton_unlocker.py --decode-code <HEX_CODE> [--device-id <DEVICE_ID>]
    python tools/valeton_unlocker.py --self-test
"""

import argparse
import collections
import ctypes
import datetime
import json
import re
import struct
import sys
import time

LANG_CODES = {"en": "0001", "zh": "0002", "both": "0003"}
# the only (flag, selector) pairs this tool may send
ALLOWED = {b"\x12\x32", b"\x12\x10", b"\x11\x33"}
MODEL_PORT = re.compile(r"(^|\W)GP-5$")        # GP-5 only, not GP-50 / GP-150
TESTED_FIRMWARE = {"1.0.6"}
KEY_FIRMWARE, KEY_LANGUAGE = 0x0101, 0x0201
ZH = "\u4e2d\u6587"  # 中文, as expected by the mobile application
EN = "\u82f1\u6587"  # 英文


# ---------------------------------------------------------------- protocol

def ror8(value: int, bits=2) -> int:
    value &= 0xFF
    return ((value >> bits) | (value << (8 - bits))) & 0xFF


def rol8(value: int, bits=2) -> int:
    value &= 0xFF
    return ((value << bits) | (value >> (8 - bits))) & 0xFF


def crypt(data: bytes, key: bytes, encrypt: bool) -> bytes:
    """Valeton CustomCipher: rotate-right when encrypting, rotate-left when decrypting."""
    if not key:
        raise ValueError("empty encryption key")
    return bytes(
        ror8(value ^ key[i % len(key)]) if encrypt
        else rol8(value) ^ key[i % len(key)]
        for i, value in enumerate(data)
    )


def validate_device_id(device_id: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F]{16,64}", device_id or ""):
        raise ValueError("Device ID must contain 16 to 64 hexadecimal characters")
    return device_id


def activation_encrypt(plaintext: str, device_id: str) -> str:
    """Encode plaintext in the activation-code format used by Valeton Suite."""
    key = validate_device_id(device_id).encode("utf-8")
    if len(key) > 255:
        raise ValueError("Device ID is too long")
    return (bytes([len(key)]) + key + crypt(plaintext.encode("utf-8"), key, True)).hex()


def activation_decrypt(code_hex: str, expected_device_id=None):
    """Return (embedded Device ID, plaintext) after strict activation-code validation."""
    try:
        raw = bytes.fromhex("".join(code_hex.split()))
    except ValueError as exc:
        raise ValueError("activation code is not valid hexadecimal") from exc
    if not raw:
        raise ValueError("activation code is empty")
    key_length = raw[0]
    if not key_length or len(raw) <= key_length:
        raise ValueError("activation code is truncated")
    key = raw[1:1 + key_length]
    try:
        embedded_id = key.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("activation code contains a non-text Device ID") from exc
    if expected_device_id and key != validate_device_id(expected_device_id).encode("utf-8"):
        raise ValueError("activation code belongs to a different Device ID")
    try:
        plaintext = crypt(raw[1 + key_length:], key, False).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("activation code payload is not valid UTF-8") from exc
    return embedded_id, plaintext


def make_activation_code(device_id: str, languages, days=3650, start_ms=None) -> str:
    if days <= 0:
        raise ValueError("validity must be at least one day")
    now_ms = int(time.time() * 1000 if start_ms is None else start_ms)
    payload = {
        "start_date": now_ms - 86_400_000,
        "end_date": now_ms + days * 86_400_000,
        "languages": languages,
    }
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return activation_encrypt(plaintext, device_id)


def activation_details(code_hex: str, expected_device_id=None):
    embedded_id, plaintext = activation_decrypt(code_hex, expected_device_id)
    try:
        payload = json.loads(plaintext)
    except json.JSONDecodeError as exc:
        raise ValueError("activation payload is not valid JSON") from exc
    required = {"start_date", "end_date", "languages"}
    if not isinstance(payload, dict) or not required <= payload.keys():
        raise ValueError("activation payload has missing fields")
    if not isinstance(payload["start_date"], int) or not isinstance(payload["end_date"], int):
        raise ValueError("activation timestamps are not integers")
    if not isinstance(payload["languages"], list):
        raise ValueError("activation languages are not a list")
    return embedded_id, payload


def format_time(timestamp_ms: int) -> str:
    try:
        value = datetime.datetime.fromtimestamp(timestamp_ms / 1000, datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return f"invalid ({timestamp_ms})"
    return value.isoformat().replace("+00:00", "Z")

def crc8(buf):
    c = 0
    for b in buf:
        c ^= b
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c


def frames(payload: bytes):
    chunks = [payload[i:i + 19] for i in range(0, len(payload), 19)]
    out = []
    for i, chunk in enumerate(chunks):
        buf = [0, len(chunks), i, len(chunk), *chunk]
        buf[0] = crc8(buf)
        out.append(bytes([0xF0] + [n for b in buf for n in (b >> 4, b & 0x0F)] + [0xF7]))
    return out


def unwire(msg: bytes):
    """F0 nibbles F7 -> [crc, count, index, len, *chunk], or None if malformed"""
    if len(msg) < 10 or msg[0] != 0xF0 or msg[-1] != 0xF7 or len(msg) % 2:
        return None
    body = msg[1:-1]
    buf = bytes((body[i] << 4) | body[i + 1] for i in range(0, len(body), 2))
    if crc8(b"\0" + buf[1:]) != buf[0] or len(buf) < 4 + buf[3]:
        return None
    return buf


def replies(msgs):
    """reassemble multi-frame replies -> list of complete payloads (frames must arrive in order)"""
    out, cur = [], None
    for m in msgs:
        count, idx = m[1], m[2]
        if idx == 0:
            cur = [count, 0, bytearray()]
        elif cur is None or idx != cur[1] or count != cur[0]:
            cur = None                      # gap or foreign frame: drop this reply
            continue
        cur[1] = idx + 1
        cur[2] += m[4:4 + m[3]]
        if cur[1] == cur[0]:
            out.append(bytes(cur[2]))
            cur = None
    return out


def decode_device_id(payload: bytes) -> str:
    n = struct.unpack_from("<H", payload, 2)[0]
    blob = payload[4:4 + n]
    klen = blob[0]
    key, enc = blob[1:1 + klen], blob[1 + klen:]
    if not key:
        raise ValueError("Device ID reply contains an empty key")
    return bytes(rol8(b) ^ key[i % klen] for i, b in enumerate(enc)).decode("ascii")


def language_payload(device_id: str, code: str) -> bytes:
    key = device_id.encode()
    blob = bytes([len(key)]) + key + crypt((device_id + code).encode(), key, True)
    return bytes([0x11, 0x33]) + struct.pack("<I", len(blob)) + blob


def parse_globals(payload: bytes) -> dict:
    """[12 10] + [u16le key][u16le len][value]... -> {key: value}; raises on malformed data"""
    data, i, out = payload[2:], 0, {}
    while i < len(data):
        if i + 4 > len(data):
            raise ValueError("truncated global data")
        key, n = struct.unpack_from("<HH", data, i)
        if i + 4 + n > len(data):
            raise ValueError(f"truncated value for key {key:#06x}")
        out[key] = data[i + 4:i + 4 + n]
        i += 4 + n
    return out


def firmware_version(value: bytes) -> str:
    # 06 00 01 01 -> 1.0.6 (what Valeton Suite shows as V1.0.6)
    return f"{value[2]}.{value[1]}.{value[0]}"


def language_name(value: bytes) -> str:
    # GlobalModel::updateGlobalLanguage: 1 -> "zh", anything else -> "en"
    return "zh" if int.from_bytes(value, "little") == 1 else "en"


# ---------------------------------------------------------------- WinMM

class MIDIHDR(ctypes.Structure):
    pass


MIDIHDR._fields_ = [
    ("lpData", ctypes.c_void_p), ("dwBufferLength", ctypes.c_uint32),
    ("dwBytesRecorded", ctypes.c_uint32), ("dwUser", ctypes.c_size_t),
    ("dwFlags", ctypes.c_uint32), ("lpNext", ctypes.POINTER(MIDIHDR)),
    ("reserved", ctypes.c_size_t), ("dwOffset", ctypes.c_uint32),
    ("dwReserved", ctypes.c_size_t * 8),
]


class MIDIINCAPSW(ctypes.Structure):
    _fields_ = [("wMid", ctypes.c_uint16), ("wPid", ctypes.c_uint16),
                ("vDriverVersion", ctypes.c_uint32), ("szPname", ctypes.c_wchar * 32),
                ("dwSupport", ctypes.c_uint32)]


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [("wMid", ctypes.c_uint16), ("wPid", ctypes.c_uint16),
                ("vDriverVersion", ctypes.c_uint32), ("szPname", ctypes.c_wchar * 32),
                ("wTechnology", ctypes.c_uint16), ("wVoices", ctypes.c_uint16),
                ("wNotes", ctypes.c_uint16), ("wChannelMask", ctypes.c_uint16),
                ("dwSupport", ctypes.c_uint32)]


MHDR_DONE = 1
HDR = ctypes.sizeof(MIDIHDR)


class Pedal:
    """SysEx in/out on the GP-5 USB-MIDI port; polling, no callbacks."""

    def __init__(self, nbuf=64, bufsize=4096):
        self.mm = mm = ctypes.WinDLL("winmm")
        ins = []
        for i in range(mm.midiInGetNumDevs()):
            caps = MIDIINCAPSW()
            mm.midiInGetDevCapsW(ctypes.c_size_t(i), ctypes.byref(caps), ctypes.sizeof(caps))
            ins.append(caps.szPname)
        outs = []
        for i in range(mm.midiOutGetNumDevs()):
            caps = MIDIOUTCAPSW()
            mm.midiOutGetDevCapsW(ctypes.c_size_t(i), ctypes.byref(caps), ctypes.sizeof(caps))
            outs.append(caps.szPname)
        pick = lambda names: next((i for i, n in enumerate(names) if MODEL_PORT.search(n.strip())), None)
        iid, oid = pick(ins), pick(outs)
        if iid is None or oid is None:
            sys.exit(f"no GP-5 MIDI port found (in: {ins}, out: {outs})")
        self.name = ins[iid]
        self.hin, self.hout = ctypes.c_void_p(), ctypes.c_void_p()
        if mm.midiInOpen(ctypes.byref(self.hin), iid, None, None, 0):
            sys.exit("midiInOpen failed")
        if mm.midiOutOpen(ctypes.byref(self.hout), oid, None, None, 0):
            sys.exit("midiOutOpen failed")
        # WinMM fills input buffers in the order they were queued; keep that order so
        # multi-frame replies come back in arrival order
        self.bufs = collections.deque()
        for _ in range(nbuf):
            data = ctypes.create_string_buffer(bufsize)
            hdr = MIDIHDR(lpData=ctypes.cast(data, ctypes.c_void_p), dwBufferLength=bufsize)
            mm.midiInPrepareHeader(self.hin, ctypes.byref(hdr), HDR)
            mm.midiInAddBuffer(self.hin, ctypes.byref(hdr), HDR)
            self.bufs.append((hdr, data))
        mm.midiInStart(self.hin)

    def send(self, data: bytes):
        mm = self.mm
        buf = ctypes.create_string_buffer(data, len(data))
        hdr = MIDIHDR(lpData=ctypes.cast(buf, ctypes.c_void_p), dwBufferLength=len(data))
        mm.midiOutPrepareHeader(self.hout, ctypes.byref(hdr), HDR)
        if mm.midiOutLongMsg(self.hout, ctypes.byref(hdr), HDR):
            sys.exit("midiOutLongMsg failed")
        deadline = time.time() + 2
        while not hdr.dwFlags & MHDR_DONE and time.time() < deadline:
            time.sleep(0.001)
        mm.midiOutUnprepareHeader(self.hout, ctypes.byref(hdr), HDR)

    def poll(self, seconds, until=None):
        """collect SysEx for `seconds`, or until `until(frame)` is true for a received frame"""
        mm, got, deadline = self.mm, [], time.time() + seconds
        while time.time() < deadline:
            hdr, data = self.bufs[0]
            if not hdr.dwFlags & MHDR_DONE:
                time.sleep(0.002)
                continue
            self.bufs.popleft()
            msg = data.raw[:hdr.dwBytesRecorded]
            mm.midiInUnprepareHeader(self.hin, ctypes.byref(hdr), HDR)
            hdr.dwFlags = hdr.dwBytesRecorded = 0
            mm.midiInPrepareHeader(self.hin, ctypes.byref(hdr), HDR)
            mm.midiInAddBuffer(self.hin, ctypes.byref(hdr), HDR)
            self.bufs.append((hdr, data))
            if msg:
                got.append(msg)
                if until and (b := unwire(msg)) and until(b):
                    break
        return got

    def request(self, payload: bytes, wait=1.5):
        if payload[:2] not in ALLOWED:
            raise ValueError(f"refusing to send unverified command {payload[:2].hex()}")
        for f in frames(payload):
            self.send(f)
        return [b for b in map(unwire, self.poll(wait)) if b]

    def write(self, payload: bytes, ack_timeout=1.5):
        """send frame by frame, each only after the pedal acked the previous one with 14 08 00
        (HtDevice does the same: receiveAckData -> readyNextMessage; frames sent back to back
        get dropped and acked with 01). Returns the ack statuses, None for a missing ack."""
        if payload[:2] not in ALLOWED:
            raise ValueError(f"refusing to send unverified command {payload[:2].hex()}")
        is_ack = lambda b: b[4:6] == b"\x14\x08"
        statuses = []
        for f in frames(payload):
            self.send(f)
            acks = [b for b in map(unwire, self.poll(ack_timeout, until=is_ack)) if b and is_ack(b)]
            statuses.append(acks[0][6] if acks else None)
            if statuses[-1] != 0:
                break
        return statuses

    def close(self):
        mm = self.mm
        mm.midiInStop(self.hin)
        mm.midiInReset(self.hin)
        for hdr, _ in self.bufs:
            mm.midiInUnprepareHeader(self.hin, ctypes.byref(hdr), HDR)
        mm.midiInClose(self.hin)
        mm.midiOutClose(self.hout)


def read_reply(pedal: Pedal, sel: int) -> bytes:
    # other apps (Valeton Suite) may share the port, so pick our reply by selector;
    # reads are safe to repeat when a reply gets lost
    for _ in range(3):
        for payload in replies(pedal.request(bytes([0x12, sel]), wait=2)):
            if payload[:2] == bytes([0x12, sel]):
                return payload
    sys.exit(f"no reply from the pedal to {sel:#04x}")


def read_device_id(pedal: Pedal) -> str:
    did = decode_device_id(read_reply(pedal, 0x32))
    if not re.fullmatch(r"[0-9a-f]{16}", did):
        sys.exit(f"unexpected Device ID {did!r}")
    return did


def read_state(pedal: Pedal):
    """-> (firmware, language) from global data; exits if it doesn't look like a GP-5"""
    try:
        g = parse_globals(read_reply(pedal, 0x10))
    except ValueError as e:
        sys.exit(f"global data does not parse ({e}), refusing to continue")
    if len(g.get(KEY_FIRMWARE, b"")) != 4 or len(g.get(KEY_LANGUAGE, b"")) < 1:
        sys.exit(f"global data has no firmware/language keys ({sorted(map(hex, g))}), refusing to continue")
    return firmware_version(g[KEY_FIRMWARE]), language_name(g[KEY_LANGUAGE])


def self_test():
    device_id = "0123456789ABCDEF"
    for languages in ([EN], [ZH], [ZH, EN]):
        code = make_activation_code(device_id, languages, days=30, start_ms=1_700_000_000_000)
        embedded_id, payload = activation_details(code, device_id)
        assert embedded_id == device_id
        assert payload["languages"] == languages
        assert activation_encrypt(activation_decrypt(code)[1], device_id) == code

    payload = b"\x12\x10" + bytes(range(64))
    wired = frames(payload)
    decoded = [unwire(frame) for frame in wired]
    assert all(decoded)
    assert replies(decoded) == [payload]
    assert all(unwire(bytes(frame)) is not None for frame in wired)
    print("self-test OK")


def selected_language(args):
    return "zh" if args.zh else "both" if args.both else "en"


def run_offline(args, parser):
    if args.self_test:
        self_test()
        return True
    if args.make_code:
        language = selected_language(args)
        languages = [ZH] if language == "zh" else [ZH, EN] if language == "both" else [EN]
        try:
            code = make_activation_code(args.make_code, languages, args.days or 3650, args.start_ms)
            _, payload = activation_details(code, args.make_code)
        except ValueError as exc:
            parser.error(str(exc))
        print(f"device id : {args.make_code}")
        print(f"languages : {language} ({LANG_CODES[language]})")
        print(f"valid from: {format_time(payload['start_date'])}")
        print(f"valid to  : {format_time(payload['end_date'])}")
        print(f"code      : {code}")
        return True
    if args.decode_code:
        try:
            embedded_id, payload = activation_details(args.decode_code, args.device_id)
        except ValueError as exc:
            parser.error(str(exc))
        known = {EN: "English", ZH: "Chinese"}
        names = [known.get(value, repr(value)) for value in payload["languages"]]
        now_ms = int(time.time() * 1000)
        state = "not yet valid" if now_ms < payload["start_date"] else \
            "expired" if now_ms > payload["end_date"] else "valid now"
        print(f"device id : {embedded_id}")
        print(f"languages : {', '.join(names) or 'none'}")
        print(f"valid from: {format_time(payload['start_date'])}")
        print(f"valid to  : {format_time(payload['end_date'])}")
        print(f"status    : {state}")
        print("payload   : " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--en", action="store_true", help="English only (0001)")
    g.add_argument("--zh", action="store_true", help="Chinese only (0002)")
    g.add_argument("--both", action="store_true", help="Chinese + English (0003)")
    offline = ap.add_mutually_exclusive_group()
    offline.add_argument("--make-code", metavar="DEVICE_ID", help="generate a mobile-app activation code (no pedal needed)")
    offline.add_argument("--decode-code", metavar="HEX", help="decode and validate an activation code (no pedal needed)")
    offline.add_argument("--self-test", action="store_true", help="test cipher, activation codes and protocol framing")
    ap.add_argument("--device-id", help="expected Device ID when using --decode-code")
    ap.add_argument("--days", type=int, help="activation-code validity in days (default: 3650)")
    ap.add_argument("--start-ms", type=int, help="activation-code start reference as Unix milliseconds")
    ap.add_argument("--dry-run", action="store_true", help="run the checks and print the frames, send nothing")
    ap.add_argument("--force", action="store_true", help="send even on untested firmware or if the language is already set")
    a = ap.parse_args()

    language_selected = a.en or a.zh or a.both
    usb_options = a.dry_run or a.force
    timed_options = a.days is not None or a.start_ms is not None
    if a.make_code:
        if a.device_id:
            ap.error("--device-id is only used with --decode-code")
        if usb_options:
            ap.error("--dry-run and --force cannot be used with --make-code")
    elif a.decode_code:
        if language_selected:
            ap.error("language options cannot be used with --decode-code")
        if timed_options or usb_options:
            ap.error("--days, --start-ms, --dry-run, and --force cannot be used with --decode-code")
    elif a.self_test:
        if language_selected or a.device_id or timed_options or usb_options:
            ap.error("--self-test cannot be combined with other operation options")
    else:
        if a.device_id:
            ap.error("--device-id is only used with --decode-code")
        if timed_options:
            ap.error("--days and --start-ms are only used with --make-code")
        if usb_options and not language_selected:
            ap.error("--dry-run and --force require --en, --zh, or --both")

    if run_offline(a, ap):
        return

    pedal = Pedal()
    try:
        did = read_device_id(pedal)
        firmware, current = read_state(pedal)
        print(f"port      : {pedal.name}")
        print(f"device id : {did}")
        print(f"firmware  : V{firmware}")
        print(f"language  : {current}")
        lang = "en" if a.en else "zh" if a.zh else "both" if a.both else None
        if not lang:
            return
        if firmware not in TESTED_FIRMWARE and not a.force:
            sys.exit(f"firmware V{firmware} was not tested (tested: {sorted(TESTED_FIRMWARE)}); use --force to send anyway")
        if lang == current and not a.force:
            print(f"language is already {lang}, nothing to do (--force to send anyway)")
            return
        payload = language_payload(did, LANG_CODES[lang])
        print(f"set       : {lang} ({LANG_CODES[lang]})")
        for f in frames(payload):
            print(f"frame     : {f.hex()}")
        if a.dry_run:
            return
        status = pedal.write(payload)
        print(f"acks      : {status}")
        if len(status) != len(frames(payload)) or any(s != 0 for s in status):
            sys.exit("pedal did not accept the command")
        # the pedal applies the language a moment after acking, so re-read a few times
        for _ in range(6):
            time.sleep(1)
            _, after = read_state(pedal)
            if lang == "both" or after == lang:
                break
        print(f"language  : {current} -> {after}")
        if lang != "both" and after != lang:
            sys.exit("acked, but the pedal still reports the old language")
        print("done")
    finally:
        pedal.close()


if __name__ == "__main__":
    main()
