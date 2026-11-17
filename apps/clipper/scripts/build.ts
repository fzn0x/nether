// Builds the clipper (ADR 0066): the popup and the script it injects, by
// Vite, then a folder and a ZIP for each browser, the same files with each
// one's manifest: dist/chrome and dist/firefox, and their ZIPs for the
// stores. With --test, a Chrome build for the end-to-end tests instead, in
// dist/test: it may read every page, and has a key, so its ID is known.
import { generateKeyPairSync, createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { zipFolder } from "./zip.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const test = process.argv.includes("--test");
const { version } = JSON.parse(await readFile(here("../package.json"), "utf8")) as {
  version: string;
};

const unpacked = here("../dist/unpacked");
await rm(here("../dist"), { recursive: true, force: true });

// The popup, a page of the extension's own: its scripts are files, as
// Manifest V3's policy asks, never inline.
await build({
  configFile: false,
  root: here("../src"),
  base: "./",
  logLevel: "warn",
  build: {
    outDir: unpacked,
    emptyOutDir: true,
    modulePreload: false,
    target: "es2022",
    rolldownOptions: { input: { popup: here("../src/popup.html") } },
  },
});

// The script the popup injects into a tab it clips: one classic script.
await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: unpacked,
    emptyOutDir: false,
    target: "es2022",
    lib: {
      entry: here("../src/content.ts"),
      formats: ["iife"],
      name: "netherClipper",
      fileName: () => "content.js",
    },
  },
});
await cp(here("../icons"), `${unpacked}/icons`, { recursive: true });

const icons = Object.fromEntries(
  [16, 32, 48, 128].map((size) => [String(size), `icons/icon-${String(size)}.png`]),
);

/** The manifest both browsers share. */
const manifest = {
  manifest_version: 3,
  name: "Nether Web Clipper",
  version,
  // The stores show at most 132 characters of it.
  description:
    "Save a page or a selection as Markdown to a note or a database on your own Nether server.",
  homepage_url: "https://fzn0x.github.io/nether/clipper/",
  icons,
  action: { default_popup: "popup.html", default_title: "Clip to Nether", default_icon: icons },
  permissions: ["activeTab", "scripting", "storage"],
  // Setup asks for the person's own server alone, out of these.
  optional_host_permissions: ["https://*/*", "http://*/*"],
};

const firefox = {
  ...manifest,
  browser_specific_settings: {
    gecko: {
      id: "nether-clipper@fzn0x.github.io",
      strict_min_version: "140.0",
      // A clip is a page's content, sent to the server the person names.
      data_collection_permissions: { required: ["websiteContent"] },
    },
  },
};

async function write(name: string, json: object): Promise<string> {
  const folder = here(`../dist/${name}`);
  await mkdir(folder, { recursive: true });
  await cp(unpacked, folder, { recursive: true });
  await writeFile(`${folder}/manifest.json`, `${JSON.stringify(json, null, 2)}\n`);
  return folder;
}

if (test) {
  // A key makes the ID: the first 128 bits of its SHA-256, written in a to p.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const id = createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  const folder = await write("test", {
    ...manifest,
    key: der.toString("base64"),
    host_permissions: ["<all_urls>"],
  });
  await writeFile(`${folder}/extension-id.txt`, id);
} else {
  for (const [name, json] of [
    ["chrome", manifest],
    ["firefox", firefox],
  ] as const) {
    const folder = await write(name, json);
    await zipFolder(folder, here(`../dist/nether-clipper-${name}-${version}.zip`));
  }
}
await rm(unpacked, { recursive: true, force: true });
