import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Signing in checks an argon2id hash, slow by design, as the server's own tests do.
    testTimeout: 30_000,
    // Each test's database is made and migrated before it.
    hookTimeout: 30_000,
  },
});
