import "./styles.css";
import "bigger-picture/css";
import BiggerPicture from "bigger-picture";
import { isAllowedPageLocation, supportedConnections } from "./browser.js";
import { modelForBleName, modelForMidiPort, modelName, models } from "./models/index.js";

const $ = id => document.getElementById(id);
const options = () => [...document.querySelectorAll("#seg .opt")];

const SHORT = { en: "EN", zh: "CN" };
const MODE_NAMES = { en: "English only", zh: "Chinese only", both: "English + Chinese" };
const SUPPORTED_MODELS = `Supported models: ${models.map(item => item.label).join(", ")}`;

let midi = null, input = null, output = null;
let bleDevice = null, bleIo = null, bleSysEx = null, transport = null;
let model = null, session = null;
let pedal = null;          // { deviceId, firmware, language } once every check passed
let draft = null;          // languages toggled on in the switch (Set), null = untouched
let target = null;         // mode those toggles describe, waiting for the arrow button
const modeOf = set => set.size === 2 ? "both" : [...set][0];
const setOf = mode => new Set(mode === "both" ? ["en", "zh"] : [mode]);
let flash = null;          // { text, kind }: last result / error, shown until the next action
let picture = null;
let pictureOpen = false;
let pictureClosing = false;
let busy = false;

// everything goes to the DevTools console (F12), the page stays clean
const log = (...args) => console.log("[Valeton]", ...args);
const logError = (...args) => console.error("[Valeton]", ...args);

function connectionErrorMessage(err, kind) {
  const message = String(err?.message || "").toLowerCase();
  if (err?.name === "NotAllowedError") return "Access denied — allow device access and try again";
  if (err?.name === "SecurityError") return "Device access requires HTTPS or localhost";
  if (err?.name === "NotFoundError") return kind === "Bluetooth"
    ? "No device selected — enable pairing and try again"
    : "No device selected — reconnect the pedal and try again";
  if (err?.name === "NetworkError" || message.includes("gatt") || message.includes("disconnected")) {
    return "Bluetooth disconnected — enable pairing and reconnect";
  }
  return `${kind} connection failed — check the pedal and try again`;
}

let metaInfo = "";          // what the line under the model says when there is no error

// Swap text with a sideways slide: the old text slides out to the left and fades, the new one
// slides in from the right (skipped if nothing changed). resize = animate the width to the new text.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const swapTimers = new WeakMap();
function swap(el, key, apply, resize = false) {
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  clearTimeout(swapTimers.get(el));
  if (reduceMotion) { apply(); return; }
  const from = el.getBoundingClientRect().width;
  if (resize) el.style.width = from + "px";
  el.classList.remove("swap-in");
  el.classList.add("swap-out");
  swapTimers.set(el, setTimeout(() => {
    apply();
    let to = 0;
    if (resize) {
      el.style.width = "auto";
      to = el.getBoundingClientRect().width;
      el.style.width = from + "px";
    }
    el.classList.remove("swap-out");
    el.classList.add("swap-in");               // jump to the right, invisible, without transition
    void el.offsetWidth;
    el.classList.remove("swap-in");            // then slide into place
    if (resize) {
      el.style.width = to + "px";
      swapTimers.set(el, setTimeout(() => { el.style.width = ""; }, 320));
    }
  }, 180));
}

// the model word in the title
function swapWord(el, text) { swap(el, text, () => { el.textContent = text; }, true); }

function setStatus(text, kind) {
  flash = text ? { text, kind } : null;
  render();
}

function setMeta(text) {
  metaInfo = text;
  render();
}

// ---- model picture -------------------------------------------------------------------

const MODEL_IMAGE_WIDTH = 1600;
const MODEL_IMAGE_HEIGHT = 1200;
const modelAlphaMasks = new Map();

async function prepareModelAlphaMask(selectedModel) {
  if (!selectedModel || modelAlphaMasks.has(selectedModel.image)) return;
  const pending = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = MODEL_IMAGE_WIDTH;
        canvas.height = MODEL_IMAGE_HEIGHT;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, MODEL_IMAGE_WIDTH, MODEL_IMAGE_HEIGHT);
        const rgba = context.getImageData(0, 0, MODEL_IMAGE_WIDTH, MODEL_IMAGE_HEIGHT).data;
        const alpha = new Uint8Array(MODEL_IMAGE_WIDTH * MODEL_IMAGE_HEIGHT);
        for (let source = 3, target = 0; source < rgba.length; source += 4, target++) alpha[target] = rgba[source];
        resolve(alpha);
      } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error(`Could not read ${selectedModel.label} image`));
    image.src = selectedModel.image;
  });
  modelAlphaMasks.set(selectedModel.image, pending);
  try {
    modelAlphaMasks.set(selectedModel.image, await pending);
  } catch (error) {
    modelAlphaMasks.delete(selectedModel.image);
    logError("Could not create the pedal image hit mask", error);
  }
}

function isModelPixel(event) {
  if (!model) return false;
  const alpha = modelAlphaMasks.get(model.image);
  if (!(alpha instanceof Uint8Array)) return false;
  const svg = $("stage").querySelector("svg");
  if (!svg) return false;
  const bounds = svg.getBoundingClientRect();
  const x = Math.floor((event.clientX - bounds.left) / bounds.width * MODEL_IMAGE_WIDTH);
  const y = Math.floor((event.clientY - bounds.top) / bounds.height * MODEL_IMAGE_HEIGHT);
  if (x < 0 || y < 0 || x >= MODEL_IMAGE_WIDTH || y >= MODEL_IMAGE_HEIGHT) return false;
  return alpha[y * MODEL_IMAGE_WIDTH + x] > 0;
}

function setPlaceholderIcon(icon) { $("stage").dataset.icon = icon; }

function showPedal(selectedModel) {
  const stage = $("stage");
  swapWord($("modelName"), selectedModel?.label || "Unlocker");
  if (!selectedModel) {
    stage.classList.remove("over-pedal");
    stage.removeAttribute("role");
    stage.removeAttribute("tabindex");
    stage.removeAttribute("aria-label");
    stage.classList.add("empty");
    stage.innerHTML = stage.dataset.placeholder;
    return;
  }
  stage.classList.remove("empty");
  stage.innerHTML = `<svg viewBox="0 0 ${MODEL_IMAGE_WIDTH} ${MODEL_IMAGE_HEIGHT}" role="img" aria-label="${selectedModel.label}">
    <image href="${selectedModel.image}" width="${MODEL_IMAGE_WIDTH}" height="${MODEL_IMAGE_HEIGHT}"/></svg>`;
  stage.role = "button";
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", `Enlarge ${selectedModel.label}`);
  prepareModelAlphaMask(selectedModel);
}

function modelImage(selectedModel) {
  return {
    src: selectedModel.image,
    width: MODEL_IMAGE_WIDTH,
    height: MODEL_IMAGE_HEIGHT,
  };
}

function openPedalPicture() {
  if (!pedal || !model || pictureOpen) return;
  const stage = $("stage"), origin = stage.querySelector("svg");
  if (!origin) return;
  try {
    // Bigger Picture restores focus to whatever was active when it opened.
    // Do not let a mouse/touch activation leave the stage outlined on close.
    stage.blur();
    picture ||= BiggerPicture({ target: document.body });
    pictureOpen = true;
    pictureClosing = false;
    const image = modelImage(model);
    picture.open({
      items: [{
        img: image.src,
        thumb: image.src,
        alt: model.label,
        width: image.width,
        height: image.height,
        element: origin,
        maxZoom: 1,
      }],
      scale: .92,
      onOpen(container) {
        container.classList.add("pedal-picture");
        stage.classList.add("picture-open");
        container.addEventListener("click", event => {
          if (!pictureClosing && !event.target.closest?.(".bp-img")) picture.close();
        });
        container.addEventListener("wheel", event => {
          if (event.deltaY > 0 && !pictureClosing) {
            event.preventDefault();
            event.stopImmediatePropagation();
            picture.close();
          }
        }, { capture: true, passive: false });
      },
      onClose() {
        pictureClosing = true;
      },
      onClosed() {
        pictureOpen = false;
        pictureClosing = false;
        stage.classList.remove("picture-open");
        stage.blur();
        requestAnimationFrame(() => stage.blur());
        document.getSelection()?.removeAllRanges();
      },
      onError(_container, _item, error) {
        logError("Could not open the pedal image", error);
      },
    });
  } catch (error) {
    pictureOpen = false;
    pictureClosing = false;
    stage.classList.remove("picture-open");
    logError("Could not initialize the pedal image viewer", error);
  }
}

$("stage").addEventListener("pointermove", event => {
  $("stage").classList.toggle("over-pedal", isModelPixel(event));
});
$("stage").addEventListener("pointerleave", () => $("stage").classList.remove("over-pedal"));
$("stage").addEventListener("click", event => {
  if (isModelPixel(event)) openPedalPicture();
});
$("stage").addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openPedalPicture();
  }
});
$("stage").addEventListener("wheel", event => {
  if (event.deltaY < 0 && pedal && !pictureOpen && isModelPixel(event)) {
    event.preventDefault();
    openPedalPicture();
  }
}, { passive: false });

// ---- MIDI I/O ------------------------------------------------------------------------

function onMessage(e) {
  session?.receive(e.data);
}

// BLE MIDI has a timestamp header before the first SysEx byte and another timestamp
// before F7. Continuation packets begin with a header alone. The GP-5 protocol uses
// SysEx only, so ordinary MIDI messages and real-time bytes can be ignored here.
function onBleMessage(e) {
  const bytes = new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength);
  if (!bytes.length || (bytes[0] & 0xc0) !== 0x80) return;
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xf0) { bleSysEx = [b]; continue; }
    if (b === 0xf7) {
      if (bleSysEx) {
        bleSysEx.push(b);
        session?.receive(bleSysEx);
      }
      bleSysEx = null;
      continue;
    }
    if (b >= 0x80) continue; // timestamp or unrelated MIDI status
    if (bleSysEx) bleSysEx.push(b);
  }
}

// Send each Valeton SysEx frame in one BLE MIDI write. The captured short
// requests use this layout and the pedal negotiated MTU 512 in that session.
// F7 is a separate MIDI status and gets its own timestamp byte.
function blePacket(frame) {
  if (frame[0] !== 0xf0 || frame[frame.length - 1] !== 0xf7) throw new Error("not a SysEx frame");
  return Uint8Array.from([0x80, 0x80, ...frame.slice(0, -1), 0x80, 0xf7]);
}

async function sendFrame(frame) {
  if (transport === "ble") {
    if (!bleIo || !bleDevice.gatt.connected) throw new Error("Bluetooth disconnected");
    const packet = blePacket(frame);
    await bleIo.writeValueWithoutResponse(packet);
  } else if (transport === "midi" && output) {
    output.send(frame);
  } else {
    throw new Error("Pedal disconnected");
  }
}

// ---- language mode -------------------------------------------------------------------
// The pedal reports only its current language (global key 0x0201), not which languages are
// unlocked (no Valeton app reads the mode back, and 12 33 gets no reply). So the switch starts
// from the current language.

// earlier versions of this page remembered the last mode per Device ID; drop those entries
try {
  Object.keys(localStorage).filter(k => k.startsWith("gp5-mode:")).forEach(k => localStorage.removeItem(k));
} catch { /* storage blocked */ }

const ARROW = $("apply").innerHTML;

function render() {
  const title = $("projectTitle");
  title.href = pedal && model?.productUrl ? model.productUrl :
    "https://github.com/flameshikari/valeton-unlocker";
  title.setAttribute("aria-label", pedal && model?.productUrl ?
    `Open the official ${model.label} page` : "Open Valeton Unlocker on GitHub");
  $("github").hidden = !pedal;
  $("disconnect").hidden = !pedal;
  $("disconnect").disabled = busy;
  const language = pedal && pedal.language;
  const shown = !pedal ? new Set() : draft || setOf(language);
  options().forEach(b => {
    const lang = b.dataset.lang, on = shown.has(lang);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.disabled = !pedal || busy;
  });
  const apply = $("apply");
  apply.disabled = !pedal || !target || busy;
  apply.title = target ? `Switch to ${MODE_NAMES[target]}` : "Pick the languages first";
  apply.setAttribute("aria-label", apply.title);
  options().forEach(b => {
    b.title = b.dataset.lang === "en" ? "English" : "Chinese";
  });

  // the line under the model: an error if there is one, else firmware · Device ID · language
  const meta = $("meta");
  const untested = pedal && !model.testedFirmware.has(pedal.firmware);
  const text = flash ? flash.text : metaInfo;
  const cls = "meta swap" + (flash ? " " + flash.kind : untested ? " warn" : "");
  swap(meta, cls + "|" + text, () => {
    meta.title = text;
    meta.className = cls;
    if (!pedal || flash) {
      meta.textContent = text;
      return;
    }
    const fw = pedal.firmware + (untested ? " (untested)" : "");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "device-id";
    copy.textContent = pedal.deviceId;
    copy.title = "Copy Device ID";
    copy.setAttribute("aria-label", `Copy Device ID ${pedal.deviceId}`);
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pedal.deviceId);
        copy.classList.remove("copied");
        void copy.offsetWidth;
        copy.classList.add("copied");
        copy.title = "Device ID copied";
        copy.setAttribute("aria-label", "Device ID copied");
        setTimeout(() => {
          copy.classList.remove("copied");
          copy.title = "Copy Device ID";
          copy.setAttribute("aria-label", `Copy Device ID ${pedal.deviceId}`);
        }, 650);
      } catch (err) {
        logError(err);
        copy.title = "Could not copy Device ID";
      }
    };
    meta.replaceChildren(document.createTextNode(`${fw} · `), copy,
      document.createTextNode(` · ${SHORT[pedal.language]}`));
  });
}

options().forEach(b => b.onclick = () => {
  if (!pedal || busy) return;
  const lang = b.dataset.lang;
  const next = new Set(draft || setOf(pedal.language));
  flash = null;
  if (!next.has(lang)) next.add(lang);                // add the other language -> both
  else if (next.size === 2) next.delete(lang);          // both on -> keep the other one
  else { next.clear(); next.add(lang === "en" ? "zh" : "en"); }   // the only one -> switch
  draft = next;
  target = draft ? modeOf(draft) : null;
  render();
});

// ---- connection ----------------------------------------------------------------------

function pickPorts() {
  const ins = [...midi.inputs.values()].filter(p => p.state === "connected" && modelForMidiPort(p.name));
  const sel = $("port"), keep = sel.value;
  sel.innerHTML = "";
  ins.forEach((p, i) => sel.add(new Option(ins.length > 1 ? `${p.name} #${i + 1}` : p.name, p.id)));
  if (ins.some(p => p.id === keep)) sel.value = keep;
  sel.hidden = ins.length < 2;
  const inPort = ins.find(p => p.id === sel.value) || null;
  const selectedModel = inPort && modelForMidiPort(inPort.name);
  const outs = [...midi.outputs.values()].filter(p => p.state === "connected" && modelForMidiPort(p.name) === selectedModel);
  const modelInputs = ins.filter(p => modelForMidiPort(p.name) === selectedModel);
  const outPort = inPort ? outs[modelInputs.indexOf(inPort)] || outs[0] || null : null;
  return [inPort, outPort, selectedModel];
}

async function refresh() {
  if (busy) return;
  busy = true; pedal = null; target = null; draft = null;
  flash = null;
  setMeta("Reading…");
  try {
    const deviceId = await session.readDeviceId();
    const state = await session.readState();
    pedal = { deviceId, ...state };
    const fw = state.firmware + (model.testedFirmware.has(state.firmware) ? "" : " (untested)");
    metaInfo = `${fw} · ${deviceId} · ${SHORT[state.language]}`;
    log(`Device ID ${deviceId}, firmware V${state.firmware}, language ${state.language}`);
  } catch (err) {
    logError(err);
    metaInfo = "Couldn't read the pedal";
    flash = { text: "Couldn't read the pedal: " + err.message, kind: "err" };
  } finally {
    busy = false;
    render();
  }
}

async function rebind() {
  if (transport !== "midi") return;
  if (input) input.onmidimessage = null;
  session?.dispose();
  session = model = null;
  input = output = null; pedal = null; target = null; draft = null; flash = null;
  const [inPort, outPort, selectedModel] = pickPorts();
  showControls(inPort && outPort ? "seg" : "connections");
  if (!inPort || !outPort) {
    const other = [...midi.inputs.values()].filter(p => p.state === "connected").map(p => modelName(p.name)).find(Boolean);
    setPlaceholderIcon("usb");
    showPedal(null);
    if (other) swapWord($("modelName"), other);
    setMeta(other ? SUPPORTED_MODELS : connectionHint());
    return;
  }
  model = selectedModel;
  session = model.createSession(sendFrame);
  input = inPort; output = outPort;
  input.onmidimessage = onMessage;
  showPedal(null);
  setPlaceholderIcon("loading");
  setMeta("Connecting over USB…");
  try {
    await input.open();
    await output.open();
    await refresh();
    if (pedal) showPedal(model);
    else { setPlaceholderIcon("usb"); showControls("connections"); }
  } catch (err) {
    logError("USB MIDI port connection failed", err);
    setPlaceholderIcon("usb");
    showControls("connections");
    setStatus(connectionErrorMessage(err, "USB"), "err");
  }
}

// which control sits in the slot: connection buttons or language switch
function showControls(which) {
  $("connections").classList.toggle("off", which !== "connections");
  $("seg").classList.toggle("off", which !== "seg");
}

function connectionHint() {
  if (hasMidi && hasBle) return "Connect the pedal over USB or Bluetooth";
  return hasMidi ? "Connect the pedal over USB" : "Connect the pedal over Bluetooth";
}

function resetConnectionChoice() {
  setPlaceholderIcon("arrow");
  flash = null;
  setMeta(connectionHint());
}

$("disconnect").onclick = async () => {
  if (!pedal || busy) return;
  const oldInput = input, oldOutput = output;
  if (midi) midi.onstatechange = null;
  if (oldInput) oldInput.onmidimessage = null;
  if (bleIo) bleIo.removeEventListener("characteristicvaluechanged", onBleMessage);
  if (bleDevice) {
    bleDevice.removeEventListener("gattserverdisconnected", onBleDisconnect);
    if (bleDevice.gatt.connected) bleDevice.gatt.disconnect();
  }
  session?.dispose();
  session = model = null;
  midi = input = output = bleDevice = bleIo = bleSysEx = transport = null;
  pedal = target = draft = flash = null;
  $("port").onchange = null;
  $("port").hidden = true;
  setPlaceholderIcon("arrow");
  showPedal(null);
  showControls("connections");
  setMeta(connectionHint());
  await Promise.allSettled([oldInput, oldOutput].filter(Boolean).map(port => Promise.resolve().then(() => port.close())));
};

$("connect").onclick = async () => {
  if (!isAllowedPageLocation(window.location)) {
    setStatus("This page requires HTTPS or localhost", "err");
    return;
  }
  flash = null;
  setPlaceholderIcon("usb");
  setMeta(connectionHint());
  try {
    midi = await navigator.requestMIDIAccess({ sysex: true });
  } catch (err) {
    resetConnectionChoice();
    logError("USB MIDI access failed", err);
    setStatus(connectionErrorMessage(err, "USB"), "err");
    return;
  }
  if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
  transport = "midi";
  setPlaceholderIcon("loading");
  $("port").onchange = rebind;
  // opening a port fires statechange too: rebind only when the set of plugged-in ports changes
  const plugged = () => [...midi.inputs.values(), ...midi.outputs.values()]
    .filter(p => p.state === "connected").map(p => p.id).sort().join();
  let known = plugged();
  midi.onstatechange = () => { const now = plugged(); if (now !== known) { known = now; rebind(); } };
  await rebind();
};

function onBleDisconnect(event) {
  if (event && event.target !== bleDevice) return;
  bleIo?.removeEventListener("characteristicvaluechanged", onBleMessage);
  bleIo = null; bleSysEx = null;
  if (transport !== "ble") return;
  session?.dispose();
  session = model = null;
  transport = null; pedal = null; target = null; draft = null; busy = false;
  setPlaceholderIcon("arrow");
  showPedal(null);
  showControls("connections");
  setMeta("Bluetooth disconnected");
}

$("connectBle").onclick = async () => {
  if (!isAllowedPageLocation(window.location)) {
    setStatus("This page requires HTTPS or localhost", "err");
    return;
  }
  if (!navigator.bluetooth) {
    setStatus("Web Bluetooth is unavailable — use Chrome or Edge", "err");
    return;
  }
  flash = null;
  setPlaceholderIcon("ble");
  setMeta(connectionHint());
  let device;
  try {
    // The log advertises "GP-5 BLE" and the standard BLE MIDI service. Requesting
    // the service here grants Web Bluetooth access to its characteristic.
    device = await navigator.bluetooth.requestDevice({
      filters: models.filter(item => item.ble).map(item => item.ble.filter),
      optionalServices: [...new Set(models.filter(item => item.ble).map(item => item.ble.service))],
    });
  } catch (err) {
    resetConnectionChoice();
    logError("Bluetooth device selection failed", err);
    setStatus(connectionErrorMessage(err, "Bluetooth"), "err");
    return;
  }
  const selectedModel = modelForBleName(device.name);
  if (!selectedModel) {
    setPlaceholderIcon("arrow");
    setStatus(SUPPORTED_MODELS, "err");
    return;
  }
  try {
    showPedal(null);
    setPlaceholderIcon("loading");
    transport = "ble";
    model = selectedModel;
    session = model.createSession(sendFrame);
    if (input) input.onmidimessage = null;
    input = output = null;
    if (midi) midi.onstatechange = null;
    midi = null;
    if (bleDevice) bleDevice.removeEventListener("gattserverdisconnected", onBleDisconnect);
    bleDevice = device;
    bleDevice.addEventListener("gattserverdisconnected", onBleDisconnect);
    setMeta("Connecting over Bluetooth…");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(model.ble.service);
    bleIo = await service.getCharacteristic(model.ble.characteristic);
    if (!bleIo.properties.notify || !bleIo.properties.writeWithoutResponse) {
      throw new Error("BLE MIDI characteristic lacks notify or write support");
    }
    bleIo.addEventListener("characteristicvaluechanged", onBleMessage);
    await bleIo.startNotifications();
    showControls("seg");
    await refresh();
    if (pedal) showPedal(model);
    else { setPlaceholderIcon("ble"); showControls("connections"); }
  } catch (err) {
    logError("Bluetooth GATT connection failed", err);
    if (device.gatt.connected) device.gatt.disconnect();
    onBleDisconnect();
    setStatus(connectionErrorMessage(err, "Bluetooth"), "err");
  }
};

$("apply").onclick = async () => {
  if (!pedal || !target || busy) return;
  const want = target, before = pedal.language;
  busy = true; flash = null;
  render();
  $("apply").innerHTML = '<span class="spin"></span>';
  try {
    const status = await session.setLanguage(pedal.deviceId, want);
    log("acks:", status);
    // the pedal applies the language a moment after acking, so re-read a few times
    let after;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 1000));
      after = await session.readState();
      if (want === "both" || after.language === want) break;
    }
    log(`language: ${before} → ${after.language}`);
    if (want !== "both" && after.language !== want) throw new Error("acked, but the pedal still reports the old language");
    $("apply").innerHTML = ARROW;
    busy = false;
    await refresh();
  } catch (err) {
    logError(err);
    $("apply").innerHTML = ARROW;
    busy = false;
    setStatus(err.message, "err");
  }
};

$("stage").dataset.placeholder = $("stage").innerHTML;
const trustedPage = isAllowedPageLocation(window.location);
const { midi: detectedMidi, ble: detectedBle } = supportedConnections(navigator, models);
const hasMidi = trustedPage && detectedMidi, hasBle = trustedPage && detectedBle;
$("connect").hidden = !hasMidi;
$("connectBle").hidden = !hasBle;
$("connections").classList.toggle("single", hasMidi !== hasBle);
showControls(hasMidi || hasBle ? "connections" : "none");
if (!trustedPage) {
  setPlaceholderIcon("cross");
  setMeta("Open this page over HTTPS or localhost");
} else if (!hasMidi && !hasBle) {
  setPlaceholderIcon("cross");
  setMeta("Use Chromium-based browser to use this");
} else if (!hasMidi) {
  setMeta(connectionHint());
} else if (!hasBle) {
  setMeta(connectionHint());
}
