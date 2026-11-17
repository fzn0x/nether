import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The popup's logic and the page reader; the extension in a browser is e2e/'s.
    include: ["test/**/*.test.ts"],
  },
});
