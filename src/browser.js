/**
 * The UI promises support in Chromium-based browsers. Firefox also exposes Web MIDI,
 * but its SysEx permission flow differs, so API presence alone is insufficient here.
 * Client Hints are preferred; older Chromium versions use the user-agent fallback.
 */
export function isChromiumBased(browser) {
  const brands = browser.userAgentData?.brands;
  if (Array.isArray(brands)) {
    return brands.some(({ brand }) => /Chromium|Chrome|Edge|Opera|Brave|Vivaldi/i.test(brand));
  }
  return /\b(?:Chromium|Chrome|Edg|OPR|Vivaldi)\/\d+/i.test(browser.userAgent || "");
}

export function supportedConnections(browser, models) {
  const supportedBrowser = isChromiumBased(browser);
  return {
    midi: supportedBrowser && typeof browser.requestMIDIAccess === "function",
    ble: supportedBrowser && models.some(model => model.ble) &&
      typeof browser.bluetooth?.requestDevice === "function",
  };
}

/** Hardware APIs require a secure context. Browsers treat loopback HTTP as
 * potentially trustworthy, so allow it for local development only. */
export function isAllowedPageLocation(location) {
  if (location.protocol === "https:") return true;
  if (location.protocol !== "http:") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]";
}
