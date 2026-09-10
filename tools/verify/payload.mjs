import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAYLOAD_ALLOWLIST_WITH_MANIFEST } from "../shared/allowlist.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const payload = path.join(root, "dist", "com.autocutstudio.panel");
const manifest = JSON.parse(
  await readFile(path.join(payload, "payload-manifest.json"), "utf8"),
);
if (
  manifest.schema_version !== 1 ||
  !manifest.files ||
  typeof manifest.files !== "object"
)
  throw new Error("Unsupported payload manifest schema");
const allowed = PAYLOAD_ALLOWLIST_WITH_MANIFEST;
const actualFiles = [];
async function walk(dir, relative = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${relative}${entry.name}`;
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${name}/`);
    else actualFiles.push(name.replaceAll("\\", "/"));
  }
}
await walk(payload);
for (const file of actualFiles) {
  if (!allowed.test(file))
    throw new Error(`Non-allowlisted payload file: ${file}`);
  if (
    file !== "payload-manifest.json" &&
    !file.startsWith("META-INF/") &&
    !manifest.files[file]
  )
    throw new Error(`Payload file not in manifest: ${file}`);
}
for (const [relative, expected] of Object.entries(manifest.files)) {
  if (
    relative.includes("..") ||
    path.isAbsolute(relative) ||
    !allowed.test(relative) ||
    expected.relative_path !== relative
  )
    throw new Error(`Invalid payload path: ${relative}`);
  const bytes = await readFile(path.join(payload, relative));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expected.sha256 || bytes.length !== expected.bytes)
    throw new Error(`Payload hash mismatch: ${relative}`);
}
console.log(`Verified ${Object.keys(manifest.files).length} payload files`);
