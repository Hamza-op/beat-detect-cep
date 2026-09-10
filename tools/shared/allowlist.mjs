/**
 * Shared payload allowlist and required-file definitions.
 *
 * Both assemble.mjs (build-time) and payload.mjs (verify-time) import from
 * here so the two lists can never diverge.
 */

/** Files allowed in the distributable payload (excludes payload-manifest.json itself). */
export const PAYLOAD_ALLOWLIST =
  /^(CSXS\/manifest\.xml|META-INF\/.+|index\.html|css\/.+|js\/.+|jsx\/host\.jsx|assets\/fonts\/.+|bin\/beat_analyzer\.exe|native\/MediaCore\/AutoCutColorEngine\.aex|INSTALL\.txt)$/;

/** Same allowlist but also permits payload-manifest.json (used by the verifier). */
export const PAYLOAD_ALLOWLIST_WITH_MANIFEST =
  /^(CSXS\/manifest\.xml|META-INF\/.+|index\.html|css\/.+|js\/.+|jsx\/host\.jsx|assets\/fonts\/.+|bin\/beat_analyzer\.exe|native\/MediaCore\/AutoCutColorEngine\.aex|INSTALL\.txt|payload-manifest\.json)$/;

/** Files that MUST be present in every release payload. */
export const REQUIRED_FILES = [
  "CSXS/manifest.xml",
  "index.html",
  "js/main.js",
  "jsx/host.jsx",
  "bin/beat_analyzer.exe",
  "native/MediaCore/AutoCutColorEngine.aex",
  "INSTALL.txt",
];
