import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/cep-panel/tests/unit/**/*.test.ts"],
    environment: "node"
  }
});
