import image from "./image.webp";
import { createSession } from "./session.js";

/** GP-5 profile. The build discovers this file because protocol.js exists beside it. */
export default {
  id: "gp-5",
  label: "GP-5",
  productUrl: "https://www.valeton.net/product/gp-5/",
  image,
  midiPort: /(^|\W)GP-5$/,
  ble: {
    name: /^GP-5(?:\s+BLE)?$/i,
    filter: { namePrefix: "GP-5" },
    service: "03b80e5a-ede8-4b33-a751-6ce34ec4c700",
    characteristic: "7772e5db-3868-4112-a1a9-f2669d106bf3",
  },
  testedFirmware: new Set(["1.0.6"]),
  createSession,
};
