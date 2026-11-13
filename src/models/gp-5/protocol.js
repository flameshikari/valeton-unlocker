// ---- GP-5 protocol (reversed from Valeton Suite 2.1.0; see tools/gp5_usb_unlock.py) ----
// Only these (flag, selector) pairs are ever sent:
//   12 32 = read Device ID, 12 10 = read global data, 11 33 = set language.
// Never add others without checking what they do (0x3f is a factory reset).
const ALLOWED = new Set(["1232", "1210", "1133"]);
const KEY_FIRMWARE = 0x0101, KEY_LANGUAGE = 0x0201;

function crc8(buf) {
  let c = 0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

function frames(payload) {
  const out = [];
  const count = Math.ceil(payload.length / 19);
  for (let i = 0; i < count; i++) {
    const chunk = payload.slice(i * 19, i * 19 + 19);
    const buf = [0, count, i, chunk.length, ...chunk];
    buf[0] = crc8(buf);
    out.push([0xf0, ...buf.flatMap(b => [b >> 4, b & 0x0f]), 0xf7]);
  }
  return out;
}

// F0 nibbles F7 -> [crc, count, index, len, ...chunk], or null
function unwire(msg) {
  if (msg.length < 10 || msg[0] !== 0xf0 || msg[msg.length - 1] !== 0xf7 || msg.length % 2) return null;
  const buf = [];
  for (let i = 1; i < msg.length - 1; i += 2) buf.push((msg[i] << 4) | msg[i + 1]);
  if (crc8([0, ...buf.slice(1)]) !== buf[0] || buf.length < 4 + buf[3]) return null;
  return buf;
}

// reassemble multi-frame replies -> complete payloads only (frames must arrive in order)
function replies(msgs) {
  const out = [];
  let cur = null;
  for (const m of msgs) {
    const count = m[1], idx = m[2];
    if (idx === 0) cur = { count, next: 0, data: [] };
    else if (!cur || idx !== cur.next || count !== cur.count) { cur = null; continue; }
    cur.next = idx + 1;
    cur.data.push(...m.slice(4, 4 + m[3]));
    if (cur.next === cur.count) { out.push(cur.data); cur = null; }
  }
  return out;
}

const rol2 = x => ((x << 2) | (x >> 6)) & 0xff;
const ror2 = x => ((x >> 2) | (x << 6)) & 0xff;
const ascii = s => Array.from(s, ch => ch.charCodeAt(0));

// reply to 12 32: [12 32] + u16le(n) + [len(key)] + key + enc; dec[i] = rol2(enc[i]) ^ key[i]
function decodeDeviceId(payload) {
  const n = payload[2] | (payload[3] << 8);
  const blob = payload.slice(4, 4 + n);
  const klen = blob[0];
  const key = blob.slice(1, 1 + klen);
  const enc = blob.slice(1 + klen);
  return String.fromCharCode(...enc.map((b, i) => rol2(b) ^ key[i % klen]));
}

// PresetModel::sendLanguage(generateEncryptedData(deviceId + code, deviceId))
// -> [11 33] + u32le(len(blob)) + blob, blob = [len(key)] + key + ror2(plain[i] ^ key[i])
function languagePayload(deviceId, code) {
  const key = ascii(deviceId);
  const plain = ascii(deviceId + code);
  const blob = [key.length, ...key, ...plain.map((b, i) => ror2(b ^ key[i % key.length]))];
  const n = blob.length;
  return [0x11, 0x33, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...blob];
}

// reply to 12 10: [12 10] + [u16le key][u16le len][value]... ; throws on malformed data
function parseGlobals(payload) {
  const data = payload.slice(2), out = new Map();
  let i = 0;
  while (i < data.length) {
    if (i + 4 > data.length) throw new Error("truncated global data");
    const key = data[i] | (data[i + 1] << 8), n = data[i + 2] | (data[i + 3] << 8);
    if (i + 4 + n > data.length) throw new Error("truncated value for key 0x" + key.toString(16));
    out.set(key, data.slice(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return out;
}

// 06 00 01 01 -> 1.0.6 (Valeton Suite shows V1.0.6)
const firmwareVersion = v => `${v[2]}.${v[1]}.${v[0]}`;
// GlobalModel::updateGlobalLanguage: 1 -> "zh", anything else -> "en"
const languageName = v => v.reduceRight((acc, b) => acc * 256 + b, 0) === 1 ? "zh" : "en";

const hex = a => Array.from(a, b => b.toString(16).padStart(2, "0")).join("");

export { ALLOWED, KEY_FIRMWARE, KEY_LANGUAGE, frames, unwire, replies, decodeDeviceId, languagePayload, parseGlobals, firmwareVersion, languageName, hex };
