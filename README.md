# Valeton Unlocker

A static web app for changing the language of supported Valeton pedals over USB MIDI or Bluetooth LE MIDI. It requires only a Chromium-based browser on a computer or phone — no installation, account, server, or Valeton application.

Based on the original idea and main script implementation by [Olegas](https://github.com/Olegas). The [original research notes and script](docs/olegas/) are preserved in this repository for history and attribution.

This repository previously used a different approach that patched the Valeton application itself. That implementation is preserved in the [legacy branch](https://github.com/flameshikari/valeton-suite-en/tree/legacy); the current project communicates with the pedal directly and does not modify the application.

## ⚠️ Disclaimer

This is an unofficial community project and is not affiliated with or endorsed by Valeton. Use it at your own risk. Although the app restricts communication to the commands needed to read the pedal and change its language, hardware and firmware behavior may differ. Keep backups of your presets and settings before using it. The authors are not responsible for data loss, device malfunction, or other damage.

## 🚧 Limitations

- Only Chromium-based browsers are supported.
- The page must be opened over HTTPS or from localhost via the webserver; hardware access is unavailable on an ordinary insecure HTTP origin.
- USB access requires Web MIDI with SysEx support. Bluetooth access requires Web Bluetooth and Bluetooth LE MIDI support.
- Only explicitly listed devices and firmware versions have been tested.

## ✅ Tested Devices

- Valeton GP-5, firmware `1.0.6`: USB MIDI and Bluetooth LE MIDI.

Other Valeton models and firmware versions have not been tested. The app identifies only explicitly supported devices and reports untested firmware before a language change.

The project uses separate model profiles to allow future expansion. GP-5 is currently the only tested model; GP-50 is the closest candidate for further investigation, while it is not yet clear whether other models expose a compatible language-switching mechanism. As that becomes better understood, the project may be expanded or renamed to reflect its actual scope.

## 🚀 Usage

> [!WARNING]
> Close Valeton Suite and any other application using the pedal before continuing.

### 🌐 Ready-to-use

1. Open [vu.hexed.pw](https://vu.hexed.pw/) in Chrome, Edge, or another Chromium-based browser.
2. Choose the connection type:
   - **USB:** connect the pedal to the computer, select USB on the page, approve MIDI access, then choose the pedal from the device list.
   - **Bluetooth:** put the pedal into pairing mode, select Bluetooth on the page, then find and choose the pedal in the browser's device list.
3. Select one or more languages.
4. Review the selection, press the arrow button, and wait for the page to read the pedal state back and confirm the change.

### 🐳 Docker

Build and serve the app with Docker Compose:

```sh
docker compose up --build
```

Open <http://localhost:8080>, then follow [Ready-to-use](#-ready-to-use) starting from step 2.

### ⌨️ Python

```sh
# Read the connected pedal's port, Device ID, firmware, and current language (Windows USB MIDI)
python tools/valeton_unlocker.py

# Set English, Chinese, or both languages
python tools/valeton_unlocker.py --en
python tools/valeton_unlocker.py --zh
python tools/valeton_unlocker.py --both

# Check and print the SysEx frames without writing to the pedal
python tools/valeton_unlocker.py --en --dry-run

# Generate an activation code offline; --days controls its validity period
python tools/valeton_unlocker.py --make-code <DEVICE_ID> --en
python tools/valeton_unlocker.py --make-code <DEVICE_ID> --both --days 3650

# Decode a code and optionally verify that it belongs to the Device ID
python tools/valeton_unlocker.py --decode-code <HEX_CODE> --device-id <DEVICE_ID>

# Test the cipher, activation-code round trip, and protocol framing without a pedal
python tools/valeton_unlocker.py --self-test

# Show all options; use --force with care to bypass USB safety checks
python tools/valeton_unlocker.py --help
```

## 🛠️ Development

Install Node.js 20 or newer, then use npm:

```sh
npm ci
npm test
npm run build
```

The build generates a single static file at `dist/index.html`. Serve it locally with:

```sh
npm run serve
```

The server listens on `0.0.0.0:8080`. Open <http://localhost:8080> on the same computer.
