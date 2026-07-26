import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "apps/cep-panel/tests/browser",
  webServer: { command: "node tools/build/preview.mjs", port: 4173, reuseExistingServer: true },
  use: { headless: true }
});
