import { defineConfig } from "vitest/config";

const windowsCI = process.platform === "win32" && Boolean(process.env.CI);

export default defineConfig({
  test: {
    // Integration tests start child processes and preserve real file ACLs.
    // Run them serially on Windows CI to avoid competing for those resources.
    ...(windowsCI
      ? { fileParallelism: false, testTimeout: 60_000, hookTimeout: 30_000 }
      : {}),
  },
});
