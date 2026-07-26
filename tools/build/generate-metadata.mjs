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
    /(<Host Name="PPRO" Version=")[^"]+(")/,
    `$1${product.compatibility.cepHost}$2`,
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
await writeFile(
  path.join(root, "native/premiere-plugin/autocut_product_version.h"),
  [
    "#pragma once",
    `#define AUTOCUT_PRODUCT_VERSION "${product.version}"`,
    `#define AUTOCUT_PRODUCT_VERSION_MAJOR ${major}`,
    `#define AUTOCUT_PRODUCT_VERSION_MINOR ${minor}`,
    `#define AUTOCUT_PRODUCT_VERSION_PATCH ${patch}`,
    `#define AUTOCUT_COLOR_MATCH_NAME "${product.nativeEffects.colorMatchName}"`,
    `#define AUTOCUT_TRANSFORM_MATCH_NAME "${product.nativeEffects.transformMatchName}"`,
    "",
  ].join("\n"),
);
console.log(`Generated metadata for ${product.productName} ${product.version}`);
