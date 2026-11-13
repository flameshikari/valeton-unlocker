import {
  ALLOWED, KEY_FIRMWARE, KEY_LANGUAGE, decodeDeviceId, firmwareVersion, frames,
  hex, languageName, languagePayload, parseGlobals, replies, unwire,
} from "./protocol.js";

const LANGUAGE_CODES = { en: "0001", zh: "0002", both: "0003" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAck = frame => frame[4] === 0x14 && frame[5] === 0x08;

/** GP-5 protocol session. All incoming SysEx frames must be passed to receive(). */
export function createSession(sendFrame) {
  let collector = null;

  function receive(frame) {
    const decoded = unwire(Array.from(frame));
    if (decoded && collector) collector.push(decoded);
  }

  function dispose() { collector = null; }

  async function request(payload, complete, waitMs = 1500) {
    assertAllowed(payload);
    collector = [];
    try {
      for (const frame of frames(payload)) await sendFrame(frame);
      const deadline = performance.now() + waitMs;
      while (!complete(collector) && performance.now() < deadline) await sleep(10);
      return collector;
    } finally {
      collector = null;
    }
  }

  // The pedal must acknowledge each frame before the next one is sent.
  async function write(payload, ackTimeoutMs = 1500) {
    assertAllowed(payload);
    const statuses = [];
    try {
      for (const frame of frames(payload)) {
        collector = [];
        await sendFrame(frame);
        const deadline = performance.now() + ackTimeoutMs;
        let ack = null;
        while (!ack && performance.now() < deadline) {
          await sleep(10);
          ack = collector.find(isAck) || null;
        }
        statuses.push(ack ? ack[6] : null);
        if (statuses.at(-1) !== 0) break;
      }
      return statuses;
    } finally {
      collector = null;
    }
  }

  // Valeton Suite can share a MIDI port. Select our reply and retry reads.
  async function readReply(selector) {
    const matchingReply = received => replies(received)
      .find(payload => payload[0] === 0x12 && payload[1] === selector);
    const receivedCounts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      // Global data (0x10) is much larger than the Device ID reply and arrives as
      // several BLE notifications. Wait for a complete protocol reply instead of
      // discarding whatever happened to arrive after a fixed two-second sleep.
      const received = await request([0x12, selector], matchingReply, selector === 0x10 ? 6000 : 3000);
      const reply = matchingReply(received);
      if (reply) return reply;
      receivedCounts.push(received.length);
    }
    throw new Error(`no complete reply from the pedal to 0x${selector.toString(16)} ` +
      `(decoded frames per attempt: ${receivedCounts.join(", ")})`);
  }

  async function readDeviceId() {
    const deviceId = decodeDeviceId(await readReply(0x32));
    if (!/^[0-9a-f]{16}$/.test(deviceId)) {
      throw new Error("unexpected Device ID: " + JSON.stringify(deviceId));
    }
    return deviceId;
  }

  async function readState() {
    const globals = parseGlobals(await readReply(0x10));
    const firmware = globals.get(KEY_FIRMWARE);
    const language = globals.get(KEY_LANGUAGE);
    if (!firmware || firmware.length !== 4 || !language?.length) {
      throw new Error("global data has no firmware or language: " +
        [...globals.keys()].map(key => "0x" + key.toString(16)).join(", "));
    }
    return { firmware: firmwareVersion(firmware), language: languageName(language) };
  }

  async function setLanguage(deviceId, mode) {
    const payload = languagePayload(deviceId, LANGUAGE_CODES[mode]);
    const statuses = await write(payload);
    if (statuses.length !== frames(payload).length || statuses.some(status => status !== 0)) {
      throw new Error("the pedal did not accept the command: " + JSON.stringify(statuses));
    }
    return statuses;
  }

  return { receive, dispose, readDeviceId, readState, setLanguage };
}

function assertAllowed(payload) {
  if (!ALLOWED.has(hex(payload.slice(0, 2)))) {
    throw new Error("command not in the allowlist: " + hex(payload.slice(0, 2)));
  }
}
