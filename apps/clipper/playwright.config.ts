import { defineConfig } from "@playwright/test";

const ci = process.env.CI !== undefined;

// The extension, unpacked from its test build (dist/test), in Playwright's
// Chromium, against the web app's end-to-end server: a real Nether server
// on port 4175, built and started as the web app's tests start it.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  workers: 1,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: { trace: "on-first-retry" },
  webServer: {
    command: "pnpm exec vite build && node e2e/server.ts",
    cwd: "../web",
    url: "http://127.0.0.1:4175/health",
    reuseExistingServer: !ci,
    timeout: 180_000,
  },
});
