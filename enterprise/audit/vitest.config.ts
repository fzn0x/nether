import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Signing in checks an argon2id hash, slow by design, as the server's own tests do.
    testTimeout: 30_000,
  },
});
