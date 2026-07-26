import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
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
await cp(path.join(source, "index.html"), path.join(output, "index.html"));
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
const hostParts = [
  path.join(source, "host", "legacy.jsx"),
  path.join(source, "host", "dispatcher.jsx"),
];
await mkdir(path.join(output, "jsx"), { recursive: true });
await writeFile(
  path.join(output, "jsx", "host.jsx"),
  (await Promise.all(hostParts.map((part) => readFile(part, "utf8")))).join(
    "\n\n",
  ),
);
console.log(`Built CEP panel at ${path.relative(root, output)}`);
