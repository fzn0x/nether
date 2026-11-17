import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each worker holds its own database or server, some 500 MB: one a core
    // would fill the memory of a machine with many. CI runners have four.
    maxWorkers: 4,
    // Signing in checks an argon2id hash, slow by design, as the server's own tests do.
    testTimeout: 30_000,
  },
});
