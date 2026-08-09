import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hostFiles = ["apps/cep-panel/src/host/legacy.jsx"];

for (const relativeFile of hostFiles) {
  const source = await readFile(path.join(root, relativeFile), "utf8");
  try {
    espree.parse(source, {
      ecmaVersion: 3,
      sourceType: "script",
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "message" in error
        ? error.message
        : String(error);
    throw new Error(`${relativeFile} is not ES3-compatible: ${detail}`);
  }
}

console.log(`Verified ${hostFiles.length} ExtendScript files as ES3 syntax.`);
