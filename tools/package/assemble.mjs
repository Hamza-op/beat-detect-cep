import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const payload = path.join(root, "dist", "com.autocutstudio.panel");
const allowed =
  /^(CSXS\/manifest\.xml|META-INF\/.+|index\.html|css\/.+|js\/.+|jsx\/host\.jsx|assets\/fonts\/.+|bin\/beat_analyzer\.exe|native\/MediaCore\/AutoCutColorEngine\.aex|INSTALL\.txt)$/;
async function walk(dir, relative = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = `${relative}${entry.name}`;
    if (entry.isDirectory())
      out.push(...(await walk(path.join(dir, entry.name), `${rel}/`)));
    else out.push(rel.replaceAll("\\", "/"));
  }
  return out;
}
const allFiles = (await walk(payload))
  .filter((file) => file !== "payload-manifest.json")
  .sort();
const rejected = allFiles.filter((file) => !allowed.test(file));
if (rejected.length)
  throw new Error(
    `Payload contains non-allowlisted files:\n${rejected.join("\n")}`,
  );
const required = [
  "CSXS/manifest.xml",
  "index.html",
  "js/main.js",
  "jsx/host.jsx",
  "bin/beat_analyzer.exe",
  "native/MediaCore/AutoCutColorEngine.aex",
  "INSTALL.txt",
];
const missing = required.filter((file) => !allFiles.includes(file));
if (missing.length)
  throw new Error(
    `Payload is missing required release files:\n${missing.join("\n")}`,
  );
// CEP signatures are generated after assembly and sign this manifest too.
// Keep META-INF out of the self-hash to avoid a circular signature dependency.
const files = allFiles.filter((file) => !file.startsWith("META-INF/"));
const manifest = {};
for (const file of files) {
  const bytes = await readFile(path.join(payload, file));
  manifest[file] = {
    relative_path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
await writeFile(
  path.join(payload, "payload-manifest.json"),
  JSON.stringify({ schema_version: 1, files: manifest }, null, 2),
);
await mkdir(path.join(root, "dist"), { recursive: true });
console.log(`Assembled ${files.length} allowlisted payload files`);
