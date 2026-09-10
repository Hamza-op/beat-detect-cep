import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const product = JSON.parse(
  await readFile(path.join(root, "config/product.json"), "utf8"),
);
const strict =
  process.argv.includes("--strict") || !!process.env.ACS_STRICT_BUILD;
const source = path.join(root, "apps", "cep-panel", "src");
const output = path.join(root, "dist", "com.autocutstudio.panel");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "js"), { recursive: true });
await build({
  entryPoints: [path.join(source, "panel", "app.ts")],
  outfile: path.join(output, "js", "main.js"),
  bundle: true,
  format: "iife",
  target: ["chrome88", "node15"],
  platform: "browser",
  legalComments: "none",
  sourcemap: false,
});

// Copy and stamp index.html with the product version in the output only.
const indexHtml = (
  await readFile(path.join(source, "index.html"), "utf8")
).replace(/v\d+\.\d+\.\d+/g, `v${product.version}`);
await writeFile(path.join(output, "index.html"), indexHtml);

await cp(path.join(source, "styles"), path.join(output, "css"), {
  recursive: true,
});
await cp(path.join(source, "assets"), path.join(output, "assets"), {
  recursive: true,
});
const manifestTemplate = await readFile(
  path.join(root, "CSXS", "manifest.xml"),
  "utf8",
);
await mkdir(path.join(output, "CSXS"), { recursive: true });
await writeFile(path.join(output, "CSXS", "manifest.xml"), manifestTemplate);

// Copy and stamp host.jsx with the product version in the output only.
await mkdir(path.join(output, "jsx"), { recursive: true });
const hostJsx = (
  await readFile(path.join(source, "host", "legacy.jsx"), "utf8")
).replace(
  /var AUTOCUT_EXTENSION_VERSION = "[^"]+"/,
  `var AUTOCUT_EXTENSION_VERSION = "${product.version}"`,
);
await writeFile(path.join(output, "jsx", "host.jsx"), hostJsx);

const binExe = path.join(root, "bin", "beat_analyzer.exe");
try {
  await mkdir(path.join(output, "bin"), { recursive: true });
  await cp(binExe, path.join(output, "bin", "beat_analyzer.exe"));
} catch {
  console.warn("WARNING: beat_analyzer.exe not found — skipping binary embed.");
  if (strict) {
    throw new Error(
      "Strict build: beat_analyzer.exe is required. Build the analyzer first.",
    );
  }
}
const nativePlugin = path.join(
  root,
  "native",
  "MediaCore",
  "AutoCutColorEngine.aex",
);
try {
  await mkdir(path.join(output, "native", "MediaCore"), { recursive: true });
  await cp(
    nativePlugin,
    path.join(output, "native", "MediaCore", "AutoCutColorEngine.aex"),
  );
} catch {
  console.warn(
    "WARNING: AutoCutColorEngine.aex not found — skipping native plugin embed.",
  );
  if (strict) {
    throw new Error(
      "Strict build: AutoCutColorEngine.aex is required. Build the native plugin first.",
    );
  }
}
const installTxt = path.join(root, "config", "INSTALL.txt");
try {
  await cp(installTxt, path.join(output, "INSTALL.txt"));
} catch {
  await writeFile(
    path.join(output, "INSTALL.txt"),
    `AutoCut Studio ${product.version} Windows build. Install with AutoCutStudioSetup.exe; development builds require CEP debug mode.`,
  );
}
console.log(`Built CEP panel at ${path.relative(root, output)}`);
