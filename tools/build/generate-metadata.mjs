import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const product = JSON.parse(
  await readFile(path.join(root, "config/product.json"), "utf8"),
);
const versionModule = `export const PRODUCT_VERSION = ${JSON.stringify(product.version)};\n`;
const cepHostSpec = String(product.compatibility.cepHost || "").match(
  /^([A-Za-z0-9_]+)\s+(.+)$/,
);
if (!cepHostSpec) {
  throw new Error(
    `compatibility.cepHost must be formatted as "HOST [min,max]"; received ${product.compatibility.cepHost}`,
  );
}
const cepHostName = cepHostSpec[1];
const cepHostVersion = cepHostSpec[2];
await writeFile(
  path.join(root, "apps/cep-panel/src/panel/version.ts"),
  versionModule,
);
const panelIndexPath = path.join(root, "apps/cep-panel/src/index.html");
const panelIndex = await readFile(panelIndexPath, "utf8");
await writeFile(
  panelIndexPath,
  panelIndex.replace(/v\d+\.\d+\.\d+/g, `v${product.version}`),
);
const legacyPanelPath = path.join(
  root,
  "apps/cep-panel/src/panel/legacy-main.js",
);
const legacyPanel = await readFile(legacyPanelPath, "utf8");
await writeFile(
  legacyPanelPath,
  legacyPanel.replace(
    /var APP_VERSION = "[^"]+"/,
    `var APP_VERSION = "${product.version}"`,
  ),
);
const legacyHostPath = path.join(root, "apps/cep-panel/src/host/legacy.jsx");
const legacyHost = await readFile(legacyHostPath, "utf8");
await writeFile(
  legacyHostPath,
  legacyHost.replace(
    /var AUTOCUT_EXTENSION_VERSION = "[^"]+"/,
    `var AUTOCUT_EXTENSION_VERSION = "${product.version}"`,
  ),
);
const manifestPath = path.join(root, "CSXS/manifest.xml");
const manifest = (await readFile(manifestPath, "utf8"))
  .replace(
    /ExtensionBundleVersion="[^"]+"/,
    `ExtensionBundleVersion="${product.version}"`,
  )
  .replace(
    /(<Extension Id="[^"]+" Version=")[^"]+(")/,
    `$1${product.version}$2`,
  )
  .replace(
    /<Host Name="[^"]+" Version="[^"]+"\/>/,
    `<Host Name="${cepHostName}" Version="${cepHostVersion}"/>`,
  )
  .replace(
    /(<RequiredRuntime Name="CSXS" Version=")[^"]+(")/,
    `$1${product.compatibility.minimumCsxsRuntime}$2`,
  );
await writeFile(manifestPath, manifest);
const installerManifestPath = path.join(
  root,
  "crates/installer/src/manifest.xml",
);
const installerManifest = await readFile(installerManifestPath, "utf8");
await writeFile(
  installerManifestPath,
  installerManifest.replace(
    /assemblyIdentity version="[^"]+"/,
    `assemblyIdentity version="${product.version}.0"`,
  ),
);
const [major, minor, patch] = product.version.split(".").map(Number);
if (
  ![major, minor, patch].every(Number.isInteger) ||
  major < 0 ||
  major > 127 ||
  minor < 0 ||
  minor > 15 ||
  patch < 0 ||
  patch > 15
) {
  throw new Error(
    `Native Adobe effect version must fit 127.15.15; received ${product.version}`,
  );
}
const effectVersion =
  (((major >> 3) & 0x0f) << 26) |
  ((major & 0x07) << 19) |
  ((minor & 0x0f) << 15) |
  ((patch & 0x0f) << 11);
const nativeVersionPath = path.join(
  root,
  "native/premiere-plugin/autocut_product_version.h",
);
const nativeVersionHeader = [
  "#pragma once",
  `#define AUTOCUT_PRODUCT_VERSION "${product.version}"`,
  `#define AUTOCUT_PRODUCT_VERSION_MAJOR ${major}`,
  `#define AUTOCUT_PRODUCT_VERSION_MINOR ${minor}`,
  `#define AUTOCUT_PRODUCT_VERSION_PATCH ${patch}`,
  `#define AUTOCUT_EFFECT_VERSION ${effectVersion}`,
  `#define AUTOCUT_COLOR_MATCH_NAME "${product.nativeEffects.colorMatchName}"`,
  "",
].join("\n");
let existingNativeVersion = "";
try {
  existingNativeVersion = await readFile(nativeVersionPath, "utf8");
} catch {
  // The first metadata generation creates the header.
}
if (existingNativeVersion !== nativeVersionHeader) {
  await writeFile(nativeVersionPath, nativeVersionHeader);
}
console.log(`Generated metadata for ${product.productName} ${product.version}`);
