import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each worker holds its own database or server, some 500 MB: one a core
    // would fill the memory of a machine with many. CI runners have four.
    maxWorkers: 4,
    // The page's own logic, and in integration/ with a real server; the
    // end-to-end tests in e2e/ run in Playwright.
    include: ["test/**/*.test.ts", "integration/**/*.test.ts"],
    // Devices sync through a real server, whose sign-in checks argon2id
    // hashes, slow by design.
    testTimeout: 60_000,
    // Stopping the devices and the server after each test takes a while too.
    hookTimeout: 30_000,
  },
});
