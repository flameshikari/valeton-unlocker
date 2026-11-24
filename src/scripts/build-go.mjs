import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = join(root, "server");
const output = join(root, "bin");
const extension = (process.env.GOOS ?? process.platform) === "windows" ? ".exe" : "";
const arch = process.env.GOARCH ?? (process.arch === "x64" ? "amd64" : process.arch);
const resource = join(server, `rsrc_windows_${arch}.syso`);
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const version = (process.env.APP_VERSION || packageVersion).replace(/^v(?=\d)/, "");

// Windows resources require an ICO. The page favicon is already an inline PNG,
// so wrap those same PNG bytes in an ICO container without a second asset.
function faviconICO(html) {
  const match = html.match(/<link\b[^>]*rel="icon"[^>]*href="data:image\/png;base64,([^"]+)"/);
  if (!match) throw new Error("Expected one inline PNG favicon in src/index.html");
  const png = Buffer.from(match[1], "base64");
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid favicon PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || width > 256 || height < 1 || height > 256) throw new Error("Invalid favicon size");
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // one image
  header[6] = width === 256 ? 0 : width;
  header[7] = height === 256 ? 0 : height;
  header.writeUInt16LE(1, 10); // color planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

await mkdir(join(server, "public"), { recursive: true });
await copyFile(join(root, "dist", "index.html"), join(server, "public", "index.html"));
await mkdir(output, { recursive: true });
if (extension) {
  const icon = join(server, "public", "favicon.ico");
  await writeFile(icon, faviconICO(await readFile(join(root, "src", "index.html"), "utf8")));
  const hostEnv = { ...process.env };
  delete hostEnv.GOOS;
  delete hostEnv.GOARCH;
  try {
    execFileSync("go", ["run", "./tools/winres", icon, join(server, "app.manifest"), version, arch, resource], {
      cwd: server,
      env: hostEnv,
      stdio: "inherit",
    });
  } catch (error) {
    await rm(resource, { force: true });
    throw error;
  }
}
try {
  execFileSync("go", ["build", "-trimpath", `-ldflags=-s -w -X main.version=${version}`, "-o", join(output, `valeton-unlocker${extension}`), "."], {
    cwd: server,
    stdio: "inherit",
  });
} finally {
  if (extension) await rm(resource, { force: true });
}
console.log(`Built bin/valeton-unlocker${extension}`);
