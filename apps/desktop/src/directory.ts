// The plugin and theme directory (ADR 0065): an index in Nether's
// repository, read only when asked, of plugins and themes whose files are
// pinned by commit and by hash. Installing fetches each file at its commit
// from GitHub, checks its hash, and writes it into the vault. A plugin
// installed is off until this device approves it; a theme that would load
// anything from an address is not installed.
import { readManifest } from "@nether/plugin-api";
import type { Vault } from "@nether/storage";
import { themesFolder } from "./appearance.ts";

/** Where the app reads the directory. */
export const indexUrl = "https://raw.githubusercontent.com/fzn0x/nether/main/registry/index.json";
/** Where GitHub serves a repository's files, by commit. */
const filesHost = "https://raw.githubusercontent.com";

/** A plugin or a theme the directory lists. */
export interface DirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  /** Its repository on GitHub, as `owner/name`. */
  readonly repo: string;
  /** The commit its files are read at. */
  readonly commit: string;
  /** A plugin's version, as its manifest has it; none for a theme. */
  readonly version?: string;
  /** Each file it installs, with its SHA-256 in hexadecimal. */
  readonly files: Readonly<Record<string, string>>;
}

export interface Directory {
  readonly plugins: readonly DirectoryEntry[];
  readonly themes: readonly DirectoryEntry[];
}

/** Reads a URL's bytes, as `fetch` does; a test gives its own. */
export type Fetcher = (url: string) => Promise<Uint8Array>;

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The files a plugin from the directory installs, as a folder of the vault holds them. */
const pluginFiles = ["main.js", "manifest.json"];

function text(value: unknown, most: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= most
    ? value.trim()
    : undefined;
}

/** An entry as the index has it, if it reads as one of `kind`. */
function readEntry(value: unknown, kind: "plugin" | "theme"): DirectoryEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const id = text(entry.id, 64);
  const name = text(entry.name, 100);
  const description = text(entry.description, 500) ?? "";
  const author = text(entry.author, 100);
  const repo = text(entry.repo, 141);
  const commit = text(entry.commit, 40);
  if (id === undefined || !idPattern.test(id) || name === undefined || author === undefined) {
    return undefined;
  }
  if (
    repo === undefined ||
    !repoPattern.test(repo) ||
    repo.split("/")[1]?.startsWith(".") !== false
  ) {
    return undefined;
  }
  if (commit === undefined || !commitPattern.test(commit)) return undefined;
  const files = entry.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return undefined;
  const hashes = Object.entries(files as Record<string, unknown>);
  if (!hashes.every(([, hash]) => typeof hash === "string" && hashPattern.test(hash))) {
    return undefined;
  }
  const names = hashes.map(([file]) => file).sort();
  if (kind === "plugin") {
    const version = text(entry.version, 64);
    if (version === undefined || !versionPattern.test(version)) return undefined;
    if (names.join() !== pluginFiles.join()) return undefined;
    return {
      id,
      name,
      description,
      author,
      repo,
      commit,
      version,
      files: files as Record<string, string>,
    };
  }
  // A theme is one CSS file, at the top of its repository.
  if (names.length !== 1 || !/^[A-Za-z0-9._-]+\.css$/.test(names[0] ?? "")) return undefined;
  return { id, name, description, author, repo, commit, files: files as Record<string, string> };
}

/** The directory, from its index's JSON: what does not read as an entry is left out. */
export function readDirectory(value: unknown): Directory {
  const index =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (index.version !== 1)
    throw new Error("The directory's index is of a version this app does not read.");
  const list = (items: unknown, kind: "plugin" | "theme") => {
    const seen = new Set<string>();
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const entry = readEntry(item, kind);
      if (entry === undefined || seen.has(entry.id)) return [];
      seen.add(entry.id);
      return [entry];
    });
  };
  return { plugins: list(index.plugins, "plugin"), themes: list(index.themes, "theme") };
}

/** Reads a URL's bytes with the browser's `fetch`, failing on any answer but 200. */
export const fetchBytes: Fetcher = async (url) => {
  const answer = await fetch(url, { cache: "no-cache", credentials: "omit", redirect: "error" });
  if (!answer.ok) throw new Error(`${url} answered ${String(answer.status)}.`);
  return new Uint8Array(await answer.arrayBuffer());
};

/** Reads the directory's index. */
export async function loadDirectory(fetcher: Fetcher = fetchBytes): Promise<Directory> {
  const bytes = await fetcher(indexUrl);
  return readDirectory(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Where an entry's file is, at its commit. */
export function fileUrl(entry: DirectoryEntry, file: string): string {
  return `${filesHost}/${entry.repo}/${entry.commit}/${file}`;
}

/** An entry's file as text, once its bytes are the ones the directory names. */
async function fetchChecked(
  entry: DirectoryEntry,
  file: string,
  fetcher: Fetcher,
): Promise<string> {
  const bytes = await fetcher(fileUrl(entry, file));
  if ((await sha256(bytes)) !== entry.files[file]) {
    throw new Error(`${entry.name}'s ${file} is not the file the directory names.`);
  }
  try {
    // Its bytes as they are, a byte-order mark and all, so the vault keeps the same file.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${entry.name}'s ${file} is not text.`);
  }
}

/** Writes a file of the vault's own, over what is there. */
async function writeOver(vault: Vault, path: string, content: string): Promise<void> {
  await vault.writeFile(path, content, (await vault.fileHash(path)) ?? "");
}

/**
 * Installs a plugin into `.nether/plugins/<id>`, as its files are at the
 * commit the directory names; nothing is written unless every file checks.
 */
export async function installPlugin(
  vault: Vault,
  entry: DirectoryEntry,
  fetcher: Fetcher = fetchBytes,
): Promise<void> {
  const [code, raw] = await Promise.all(
    pluginFiles.map((file) => fetchChecked(entry, file, fetcher)),
  );
  if (code === undefined || raw === undefined) throw new Error(`${entry.name} has no files.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${entry.name}'s manifest.json is not JSON.`);
  }
  const { manifest, problems } = readManifest(parsed);
  if (manifest === undefined) throw new Error(`${entry.name}'s manifest: ${problems.join(" ")}`);
  if (manifest.id !== entry.id || manifest.version !== entry.version) {
    throw new Error(`${entry.name}'s manifest is not the plugin the directory names.`);
  }
  const folder = `.nether/plugins/${entry.id}`;
  await writeOver(vault, `${folder}/manifest.json`, raw);
  await writeOver(vault, `${folder}/main.js`, code);
}

/** Functions of CSS that load what they name; `url()` only for `data:` is allowed. */
const loading = new Set([
  "image",
  "cross-fade",
  "-webkit-cross-fade",
  "element",
  "-moz-element",
  "paint",
  "src",
]);

/**
 * Whether CSS, as the browser writes it out, loads anything from an
 * address: a `url()` that is not `data:`, or a function that draws from
 * elsewhere. Written out, escapes are undone; one left could hide an
 * address in a custom property, so it counts too.
 */
export function loadsFromAddress(written: string): boolean {
  if (written.includes("\\")) return true;
  for (const match of written.matchAll(/([a-z-]+)\s*\(/gi)) {
    const name = (match.at(1) ?? "").toLowerCase();
    if (name === "url") {
      const after = written.slice(match.index + match[0].length).trimStart();
      if (!/^["']?data:/i.test(after)) return true;
    } else if (loading.has(name)) {
      return true;
    }
  }
  return false;
}

/** CSS as the browser reads and writes it out again; none where it cannot here. */
export function writtenOut(css: string): string | undefined {
  if (typeof CSSStyleSheet !== "function" || !("replaceSync" in CSSStyleSheet.prototype)) {
    return undefined;
  }
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return undefined;
  }
  return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
}

/** Why a theme from the directory may not be installed, if it may not. */
export function themeProblem(
  css: string,
  write: (css: string) => string | undefined = writtenOut,
): string | undefined {
  // The browser leaves `@import` out when it reads a sheet, so it is looked for first.
  if (/@import/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) return "It imports other CSS.";
  const written = write(css);
  if (written === undefined) return "Its CSS cannot be read here.";
  return loadsFromAddress(written) ? "It loads something from an address." : undefined;
}

/** Installs a theme into `.nether/themes/<id>.css`, once its CSS loads nothing from an address. */
export async function installTheme(
  vault: Vault,
  entry: DirectoryEntry,
  fetcher: Fetcher = fetchBytes,
  write?: (css: string) => string | undefined,
): Promise<void> {
  const [file] = Object.keys(entry.files);
  if (file === undefined) throw new Error(`${entry.name} has no file.`);
  const css = await fetchChecked(entry, file, fetcher);
  const problem = themeProblem(css, write);
  if (problem !== undefined) throw new Error(`${entry.name} cannot be installed: ${problem}`);
  await writeOver(vault, `${themesFolder}/${entry.id}.css`, css);
}

/** Whether a theme is installed as the directory has it, or as another version. */
export async function themeState(
  vault: Vault,
  entry: DirectoryEntry,
): Promise<"none" | "same" | "other"> {
  const hash = await vault.fileHash(`${themesFolder}/${entry.id}.css`);
  if (hash === undefined) return "none";
  return Object.values(entry.files).includes(hash) ? "same" : "other";
}
