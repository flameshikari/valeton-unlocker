import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession } from "../src/models/gp-5/session.js";
import { frames, unwire } from "../src/models/gp-5/protocol.js";

test("GP-5 reads identity and state, then waits for every write acknowledgement", async () => {
  const deviceId = "1d11190808090505";
  const key = [...deviceId].map(char => char.charCodeAt(0));
  const encryptedId = [key.length, ...key, ...Array(key.length).fill(0)];
  const globals = [
    0x01, 0x01, 4, 0, 6, 0, 1, 1, // firmware V1.0.6
    0x01, 0x02, 1, 0, 0,          // English
  ];
  const sent = [];
  let session;
  session = createSession(async frame => {
    const decoded = unwire(frame);
    const payload = decoded.slice(4);
    sent.push({ payload, frameIndex: decoded[2] });
    let response;
    if (payload[0] === 0x12 && payload[1] === 0x32) {
      response = [0x12, 0x32, encryptedId.length, 0, ...encryptedId];
    } else if (payload[0] === 0x12 && payload[1] === 0x10) {
      response = [0x12, 0x10, ...globals];
    } else {
      response = [0x14, 0x08, 0];
    }
    queueMicrotask(() => frames(response).forEach(session.receive));
  });

  assert.equal(await session.readDeviceId(), deviceId);
  assert.deepEqual(await session.readState(), { firmware: "1.0.6", language: "en" });
  assert.deepEqual(await session.setLanguage(deviceId, "both"), [0, 0, 0]);
  assert.deepEqual(sent.map(({ frameIndex }) => frameIndex), [0, 0, 0, 1, 2]);
  session.dispose();
});

test("GP-5 waits for every frame of a delayed global-data reply", async () => {
  const globals = [
    0x01, 0x01, 4, 0, 6, 0, 1, 1,
    0x01, 0x02, 1, 0, 0,
    // Make the response span several protocol frames, like the real pedal state.
    0x34, 0x12, 40, 0, ...Array(40).fill(0x55),
  ];
  let session;
  session = createSession(async () => {
    frames([0x12, 0x10, ...globals]).forEach((frame, index) => {
      setTimeout(() => session.receive(frame), 20 + index * 30);
    });
  });

  assert.deepEqual(await session.readState(), { firmware: "1.0.6", language: "en" });
  session.dispose();
});
