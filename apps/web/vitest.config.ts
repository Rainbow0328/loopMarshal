import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@loopmarshal/sdk": fileURLToPath(
        new URL("../../packages/sdk/src/index.ts", import.meta.url),
      ),
      "@loopmarshal/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
