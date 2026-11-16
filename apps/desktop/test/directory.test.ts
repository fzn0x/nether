// The plugin and theme directory (ADR 0065): what of its index reads as
// entries, files fetched at their commit and checked by hash before
// anything is written, and themes that load nothing from an address.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type DirectoryEntry,
  type Fetcher,
  fileUrl,
  installPlugin,
  installTheme,
  loadsFromAddress,
  readDirectory,
  themeProblem,
  themeState,
} from "../src/directory.ts";
import { readFolders } from "../src/plugins/folders.ts";

const encode = (text: string) => new TextEncoder().encode(text);

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const commit = "0123456789abcdef0123456789abcdef01234567";
const manifest = (version = "1.0.0", id = "word-goal") =>
  JSON.stringify({ id, name: "Word goal", version, api: "^0.1", contributes: {} });
const code = "export default { activate() {} };\n";

/** An entry for files as given, with their hashes. */
async function pluginEntry(files: { manifest: string; code: string }, version = "1.0.0") {
  return {
    id: "word-goal",
    name: "Word goal",
    description: "Counts toward a goal.",
    author: "someone",
    repo: "someone/nether-word-goal",
    commit,
    version,
    files: { "manifest.json": await hashOf(files.manifest), "main.js": await hashOf(files.code) },
  } satisfies DirectoryEntry;
}

/** Serves files by their URL at the entry's commit. */
function serving(entry: DirectoryEntry, files: Readonly<Record<string, string>>): Fetcher {
  return (url) => {
    for (const [name, text] of Object.entries(files)) {
      if (url === fileUrl(entry, name)) return Promise.resolve(encode(text));
    }
    return Promise.reject(new Error(`No ${url}.`));
  };
}

async function emptyVault(): Promise<Vault> {
  const vault = new Vault(new MemoryFiles({ "a.md": "A" }), new MemoryStore());
  await vault.open();
  return vault;
}

describe("readDirectory", () => {
  it("keeps the entries that read as plugins and themes, once each", async () => {
    const plugin = await pluginEntry({ manifest: manifest(), code });
    const theme = {
      id: "dusk",
      name: "Dusk",
      author: "someone",
      repo: "someone/nether-dusk",
      commit,
      files: { "dusk.css": "a".repeat(64) },
    };
    const read = readDirectory({
      version: 1,
      plugins: [
        plugin,
        { ...plugin, name: "Again" },
        { ...plugin, id: "Bad Id" },
        { ...plugin, id: "other", repo: "someone/../x" },
        { ...plugin, id: "short", commit: "abc" },
        { ...plugin, id: "nover", version: "one" },
        { ...plugin, id: "extra", files: { ...plugin.files, "styles.css": "b".repeat(64) } },
        { ...plugin, id: "badhash", files: { ...plugin.files, "main.js": "nope" } },
        "not an entry",
      ],
      themes: [
        theme,
        { ...theme, id: "two", files: { "a.css": "a".repeat(64), "b.css": "b".repeat(64) } },
      ],
    });
    expect(read.plugins.map((entry) => `${entry.id} ${entry.name}`)).toEqual([
      "word-goal Word goal",
    ]);
    expect(read.themes.map((entry) => entry.id)).toEqual(["dusk"]);
    expect(read.themes[0]?.description).toBe("");
  });

  it("refuses an index of another version", () => {
    expect(() => readDirectory({ version: 2, plugins: [] })).toThrow(
      "The directory's index is of a version this app does not read.",
    );
  });
});

describe("installPlugin", () => {
  it("writes a plugin's files into the vault's plugins folder, where it is listed", async () => {
    const vault = await emptyVault();
    const files = { manifest: manifest(), code };
    const entry = await pluginEntry(files);
    await installPlugin(
      vault,
      entry,
      serving(entry, { "manifest.json": files.manifest, "main.js": code }),
    );
    const [listed] = await readFolders(vault, new Set());
    expect(listed?.folder).toBe("word-goal");
    expect(listed?.problems).toEqual([]);
    expect(listed?.code?.text).toBe(code);
    expect(listed?.code?.hash).toBe(entry.files["main.js"]);
    // Updating writes over it.
    const newer = { manifest: manifest("1.1.0"), code: `${code}// newer\n` };
    const update = await pluginEntry(newer, "1.1.0");
    await installPlugin(
      vault,
      update,
      serving(update, { "manifest.json": newer.manifest, "main.js": newer.code }),
    );
    const [updated] = await readFolders(vault, new Set());
    expect(updated?.manifest?.version).toBe("1.1.0");
  });

  it("writes nothing unless every file is the one the directory names", async () => {
    const vault = await emptyVault();
    const files = { manifest: manifest(), code };
    const entry = await pluginEntry(files);
    await expect(
      installPlugin(
        vault,
        entry,
        serving(entry, { "manifest.json": files.manifest, "main.js": `${code}//\n` }),
      ),
    ).rejects.toThrow("Word goal's main.js is not the file the directory names.");
    // A manifest for another plugin, though its hash is the entry's.
    const other = { manifest: manifest("1.0.0", "other"), code };
    const named = await pluginEntry(other);
    await expect(
      installPlugin(
        vault,
        named,
        serving(named, { "manifest.json": other.manifest, "main.js": code }),
      ),
    ).rejects.toThrow("Word goal's manifest is not the plugin the directory names.");
    expect(await readFolders(vault, new Set())).toEqual([]);
  });

  it("installs no file that is not text", async () => {
    const vault = await emptyVault();
    const entry = await pluginEntry({ manifest: manifest(), code });
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const binary = { ...entry, files: { ...entry.files, "main.js": hash } };
    const fetcher: Fetcher = (url) =>
      Promise.resolve(url.endsWith("main.js") ? bytes : encode(manifest()));
    await expect(installPlugin(vault, binary, fetcher)).rejects.toThrow(
      "Word goal's main.js is not text.",
    );
  });
});

describe("themes from the directory", () => {
  it("load nothing from an address", () => {
    expect(
      loadsFromAddress(
        ':root { --bg: #111; } @font-face { src: url("data:font/woff2;base64,AA"); }',
      ),
    ).toBe(false);
    expect(loadsFromAddress('body { background: url("https://a.example/1.png"); }')).toBe(true);
    expect(loadsFromAddress("body { background: url(a.png); }")).toBe(true);
    expect(
      loadsFromAddress('body { background: image-set(url("data:image/png;base64,AA") 1x); }'),
    ).toBe(false);
    expect(loadsFromAddress("body { background: cross-fade(a, b); }")).toBe(true);
    expect(loadsFromAddress("body { --x: u\\72l(https://a.example); }")).toBe(true);
  });

  it("say why one cannot be installed", () => {
    const asIs = (css: string) => css;
    expect(themeProblem(":root { --bg: #111; }", asIs)).toBeUndefined();
    expect(themeProblem('@import url("https://a.example/x.css");', asIs)).toBe(
      "It imports other CSS.",
    );
    // Only a comment names it.
    expect(themeProblem("/* @import */ :root { --bg: #111; }", asIs)).toBeUndefined();
    expect(themeProblem("body { background: url(https://a.example/1.png); }", asIs)).toBe(
      "It loads something from an address.",
    );
    expect(themeProblem(":root {}", () => undefined)).toBe("Its CSS cannot be read here.");
  });

  it("install into the themes folder, and are known once there", async () => {
    const vault = await emptyVault();
    const css = ":root { --bg: #102030; }\n";
    const entry: DirectoryEntry = {
      id: "dusk",
      name: "Dusk",
      description: "",
      author: "someone",
      repo: "someone/nether-dusk",
      commit,
      files: { "dusk.css": await hashOf(css) },
    };
    expect(await themeState(vault, entry)).toBe("none");
    await installTheme(vault, entry, serving(entry, { "dusk.css": css }), (text) => text);
    expect((await vault.readFile(".nether/themes/dusk.css")).text).toBe(css);
    expect(await themeState(vault, entry)).toBe("same");
    expect(await themeState(vault, { ...entry, files: { "dusk.css": "c".repeat(64) } })).toBe(
      "other",
    );
    const loud = "body { background: url(https://a.example/1.png); }\n";
    const tracking = { ...entry, id: "loud", files: { "dusk.css": await hashOf(loud) } };
    await expect(
      installTheme(vault, tracking, serving(tracking, { "dusk.css": loud }), (text) => text),
    ).rejects.toThrow("Dusk cannot be installed: It loads something from an address.");
    expect((await vault.readFile(".nether/themes/loud.css")).missing).toBe(true);
  });
});
