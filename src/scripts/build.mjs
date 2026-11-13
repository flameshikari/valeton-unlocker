import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";
import { minify } from "html-minifier-terser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = join(root, "src");
const output = join(root, "dist");
const modelsDir = join(source, "models");

// A model is enabled only when its folder has both the profile and protocol.
// Image-only folders stay out of the bundle without a manually maintained list.
const folders = (await readdir(modelsDir, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
  .map(entry => entry.name).sort();
const supported = (await Promise.all(folders.map(async name => {
  try {
    const files = await Promise.all(["main.js", "protocol.js"]
      .map(file => stat(join(modelsDir, name, file))));
    return files.every(file => file.isFile()) ? name : null;
  } catch { return null; }
}))).filter(Boolean);
if (!supported.length) throw new Error("No supported pedal models found in src/models");

const modelImports = supported.map((name, index) =>
  `import model${index} from "./models/${name}/main.js";`).join("\n");
const modelRegistry = `${modelImports}\nexport const models = [${supported.map((_, index) => `model${index}`).join(", ")}];`;
const supportedModelsPlugin = {
  name: "supported-models",
  setup(builder) {
    builder.onResolve({ filter: /^virtual:supported-models$/ }, () =>
      ({ path: "supported-models", namespace: "supported-models" }));
    builder.onLoad({ filter: /.*/, namespace: "supported-models" }, () =>
      ({ contents: modelRegistry, loader: "js", resolveDir: source }));
  },
};

const result = await build({
  entryPoints: [join(source, "main.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome90", "edge90"],
  outdir: output,
  entryNames: "app",
  loader: { ".png": "dataurl", ".webp": "dataurl" },
  plugins: [supportedModelsPlugin],
  write: false,
  logLevel: "warning",
});

const js = result.outputFiles.find(file => file.path.endsWith(".js"));
const css = result.outputFiles.find(file => file.path.endsWith(".css"));
if (!js || !css || result.outputFiles.length !== 2) throw new Error("Expected one JS and one CSS bundle");
new Script(js.text, { filename: "app.js" });

let html = await readFile(join(source, "index.html"), "utf8");

// Minify the HTML shell before inserting bundles. Passing Bigger Picture's
// template literals through an HTML parser corrupts their embedded CSS.
html = await minify(html, {
  collapseWhitespace: true,
  removeComments: true,
  ignoreCustomComments: [/^\s*app:(?:styles|script)\s*$/],
  collapseBooleanAttributes: true,
  minifyCSS: false,
  minifyJS: false,
});

function inline(marker, content) {
  if (html.split(marker).length !== 2) throw new Error(`Expected one ${marker} marker`);
  // A replacement callback keeps `$&`, "$'", and similar sequences inside
  // third-party bundles from being interpreted as String.replace patterns.
  html = html.replace(marker, () => content);
}
inline("<!-- app:styles -->", `<style>${css.text.replace(/<\/style/gi, "<\\/style")}</style>`);
inline("<!-- app:script -->", `<script>${js.text.replace(/<\/script/gi, "<\\/script")}</script>`);

const inlinedScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
if (!inlinedScript) throw new Error("Built HTML has no inline script");
new Script(inlinedScript, { filename: "dist/index.html" });

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(join(output, "index.html"), html);
console.log(`Built dist/index.html (${Buffer.byteLength(html)} bytes; models: ${supported.join(", ")})`);
