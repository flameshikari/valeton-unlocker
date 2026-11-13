import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedPageLocation, supportedConnections } from "../src/browser.js";

const models = [{ ble: {} }];
const requestMIDIAccess = () => {};
const bluetooth = { requestDevice() {} };

test("Firefox does not show USB even when Web MIDI exists", () => {
  const browser = { userAgent: "Mozilla/5.0 Firefox/143.0", requestMIDIAccess, bluetooth };
  assert.deepEqual(supportedConnections(browser, models), { midi: false, ble: false });
});

test("Chromium shows only available connection APIs", () => {
  const browser = { userAgent: "Mozilla/5.0 Chrome/140.0.0.0", requestMIDIAccess };
  assert.deepEqual(supportedConnections(browser, models), { midi: true, ble: false });
  browser.bluetooth = bluetooth;
  assert.deepEqual(supportedConnections(browser, models), { midi: true, ble: true });
});

test("Chromium Client Hints take precedence over the user-agent fallback", () => {
  const browser = {
    userAgent: "Mozilla/5.0 Firefox/143.0",
    userAgentData: { brands: [{ brand: "Chromium", version: "140" }] },
    requestMIDIAccess,
  };
  assert.deepEqual(supportedConnections(browser, models), { midi: true, ble: false });
});

test("only HTTPS and loopback HTTP origins may access hardware", () => {
  const allowed = url => isAllowedPageLocation(new URL(url));
  assert.equal(allowed("https://example.com"), true);
  assert.equal(allowed("http://localhost:8080"), true);
  assert.equal(allowed("http://127.0.0.1:8080"), true);
  assert.equal(allowed("http://[::1]:8080"), true);
  assert.equal(allowed("http://example.com"), false);
  assert.equal(allowed("file:///tmp/index.html"), false);
});
