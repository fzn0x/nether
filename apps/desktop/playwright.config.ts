import { defineConfig, devices } from "@playwright/test";

const ci = process.env.CI !== undefined;

// The page runs in Chromium here, as in WebView2. Desktop-only behavior is
// tested on the Go side. The phone's layout (ADR 0087) runs on phones'
// viewports with touch: Chromium as a Pixel 7, as Android's WebView is, and
// WebKit as an iPhone 15, as iOS's is.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !ci,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /phone\.spec\.ts$/ },
    { name: "phone-chromium", use: { ...devices["Pixel 7"] }, testMatch: /phone\.spec\.ts$/ },
    { name: "phone-webkit", use: { ...devices["iPhone 15"] }, testMatch: /phone\.spec\.ts$/ },
  ],
});
