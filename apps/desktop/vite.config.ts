import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, build, defineConfig } from "vite";

/**
 * The link index parses notes in a worker, which has no `document`. The
 * browser build of micromark's entity decoder decodes with one; its other
 * build carries the table of entities instead. The page uses that build
 * too, so the dev server and the build, page and worker, all run the same.
 */
function decodeEntitiesWithoutDom(): Plugin {
  return {
    name: "nether:decode-entities-without-dom",
    // Before Vite's own resolver, which would pick the browser build.
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== "decode-named-character-reference") return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved === null
        ? null
        : { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, "index.js") };
    },
  };
}

/**
 * A plugin frame's policy (ADR 0058): the app's own script and what it
 * makes as blobs, a worker from a blob, and the network only for a plugin
 * approved for it. Its frame's own navigations the page's frame-src keeps
 * to the app.
 */
export function pluginFramePolicy(network: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self' blob:",
    "worker-src blob:",
    `connect-src ${network ? "https: wss:" : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function pluginFramePage(network: boolean): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${pluginFramePolicy(network)}" />
    <title>Nether plugin</title>
    <script src="/plugin-frame.js"></script>
  </head>
  <body></body>
</html>
`;
}

/**
 * A script of the app's own, with what it imports, as one classic script,
 * or as one ES module.
 */
async function classicScript(
  entry: string,
  define: Record<string, string> = {},
  format: "iife" | "es" = "iife",
): Promise<string> {
  const built = await build({
    configFile: false,
    root: fileURLToPath(new URL(".", import.meta.url)),
    publicDir: false,
    logLevel: "warn",
    define,
    build: {
      write: false,
      minify: true,
      copyPublicDir: false,
      lib: {
        entry: fileURLToPath(new URL(entry, import.meta.url)),
        formats: [format],
        name: "nether",
      },
    },
  });
  const outputs = Array.isArray(built) ? built : [built];
  for (const each of outputs) {
    if (!("output" in each)) continue;
    const chunk = each.output.find((part) => part.type === "chunk");
    if (chunk !== undefined) return chunk.code;
  }
  throw new Error(`${entry} built to no script.`);
}

/** The frame's script: its bootstrap, with the worker's code in it. */
async function pluginFrameScript(): Promise<string> {
  const worker = await classicScript("src/plugins/frame/worker.ts");
  return classicScript("src/plugins/frame/bootstrap.ts", { pluginWorker: JSON.stringify(worker) });
}

/**
 * The pages plugins from a vault run in, and their script (ADR 0058):
 * built beside the app's page, and served by the dev server as they
 * would be built.
 */
function pluginFrame(): Plugin {
  const pages: Readonly<Record<string, boolean>> = {
    "plugin-frame.html": false,
    "plugin-frame-network.html": true,
  };
  return {
    name: "nether:plugin-frame",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0]?.slice(1) ?? "";
        const network = pages[path];
        if (network !== undefined) {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(pluginFramePage(network));
        } else if (path === "plugin-frame.js") {
          pluginFrameScript().then(
            (script) => {
              response.setHeader("content-type", "text/javascript; charset=utf-8");
              response.end(script);
            },
            (error: unknown) => {
              next(error);
            },
          );
        } else {
          next();
        }
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "plugin-frame.js",
        source: await pluginFrameScript(),
      });
      for (const [fileName, network] of Object.entries(pages)) {
        this.emitFile({ type: "asset", fileName, source: pluginFramePage(network) });
      }
    },
  };
}

/**
 * The built-in plugins that run apart (ADR 0090): each folder of
 * src/plugins with a main.ts, which only they have, built as one ES module
 * with what it imports, served at builtin-plugins/<id>.js, and handed to
 * a sandboxed frame as a vault plugin's main.js is.
 */
function apartPlugins(): Plugin {
  const root = fileURLToPath(new URL("src/plugins", import.meta.url));
  const ids = (): string[] =>
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "main.ts")))
      .map((entry) => entry.name);
  const code = (id: string) => classicScript(`src/plugins/${id}/main.ts`, {}, "es");
  return {
    name: "nether:apart-plugins",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        const id = /^\/builtin-plugins\/([a-z0-9-]+)\.js$/.exec(path)?.[1];
        if (id === undefined || !ids().includes(id)) {
          next();
          return;
        }
        code(id).then(
          (script) => {
            response.setHeader("content-type", "text/javascript; charset=utf-8");
            response.end(script);
          },
          (error: unknown) => {
            next(error);
          },
        );
      });
    },
    async generateBundle() {
      for (const id of ids()) {
        this.emitFile({
          type: "asset",
          fileName: `builtin-plugins/${id}.js`,
          source: await code(id),
        });
      }
    },
  };
}

/**
 * What pdf.js fetches when a PDF needs it (ADR 0061), built and served
 * under pdfjs/, each with its license: the CMaps of Chinese, Japanese and
 * Korean text; the WebAssembly decoders of JBIG2, JPEG 2000 and ICC
 * colors; and the Symbol and Dingbats fonts. Not the Liberation fonts,
 * whose license ADR 0001 does not list: system fonts stand in for them.
 */
function pdfjsFiles(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const files = (): string[] => [
    ...readdirSync(join(root, "cmaps")).map((name) => `cmaps/${name}`),
    ...["jbig2", "openjpeg", "qcms"].flatMap((name) => [
      `wasm/${name === "qcms" ? "qcms_bg" : name}.wasm`,
      `wasm/LICENSE_${name.toUpperCase()}`,
      `wasm/LICENSE_PDFJS_${name.toUpperCase()}`,
    ]),
    "standard_fonts/FoxitSymbol.pfb",
    "standard_fonts/FoxitDingbats.pfb",
    "standard_fonts/LICENSE_FOXIT",
  ];
  return {
    name: "nether:pdfjs-files",
    configureServer(server) {
      const served = new Set(files());
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        const file = path.startsWith("/pdfjs/") ? path.slice("/pdfjs/".length) : "";
        if (!served.has(file)) {
          next();
          return;
        }
        response.setHeader(
          "content-type",
          file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        );
        response.end(readFileSync(join(root, file)));
      });
    },
    generateBundle() {
      for (const file of files()) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/${file}`,
          source: readFileSync(join(root, file)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), decodeEntitiesWithoutDom(), pluginFrame(), apartPlugins(), pdfjsFiles()],
  worker: {
    format: "es",
    plugins: () => [decodeEntitiesWithoutDom()],
  },
  // The dev server bundles micromark with its decoder ahead, apart from the
  // plugins above; without this the worker gets the browser build and fails.
  optimizeDeps: {
    rolldownOptions: { plugins: [decodeEntitiesWithoutDom()] },
    // Workers' packages too: the scan follows the page's imports but not
    // `new Worker(…)`, so a package only a worker uses was found when the
    // worker first loaded, and the dev server reloaded the page for it.
    entries: ["index.html", "src/*.worker.ts"],
    // SQLite's WebAssembly build finds its .wasm beside itself, which
    // bundling ahead would move (ADR 0053).
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  server: {
    // `mygo dev` loads this address (devUrl in mygo.json).
    port: 5173,
    strictPort: true,
    // MyGO's development app and the packaged builds are not the page's.
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
