// The mobile apps' page (ADR 0087): the desktop app's page, built from its
// sources with VITE_NETHER_TARGET=mobile, which picks the mobile backend
// inside the apps and leaves out what comes to them in later parts. Capacitor
// copies dist/ into each app, which serves it from its own files: nothing
// loads from a network, and there is no service worker. The build leaves out
// the web backend and SQLite's WebAssembly, as the desktop app's does.
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import desktop from "../desktop/vite.config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default mergeConfig(
  desktop,
  defineConfig({
    root: here("../desktop"),
    cacheDir: here("node_modules/.vite"),
    define: { "import.meta.env.VITE_NETHER_TARGET": JSON.stringify("mobile") },
    build: { outDir: here("dist"), emptyOutDir: true },
  }),
);
