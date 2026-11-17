// Drawing a published site's pages (ADR 0076): which notes it has, as its
// publisher's access is now, and each as HTML the server writes, with no
// script. A note becomes Markdown as the API gives it, is parsed as a file
// is, and is written by the HTML export's own `blocksToHtml`. Links are
// resolved as the app resolves them, among the notes the publisher may
// open, and lead only to the site's own pages; files go by their hash.
// Loaded when a published page is first asked for, as it brings the
// editor's schema.
import type { LinkTarget } from "@nether/core";
import { highlightCode, mathToMathml } from "@nether/editor/render";
import {
  type HtmlHooks,
  blocksToHtml,
  escapeHtml,
  headingSlug,
  parseMarkdown,
} from "@nether/markdown";
import { LinkIndex } from "@nether/storage/links";
import * as Y from "yjs";
import { type Queryable, readBytes, readText } from "./db.ts";
import { readNote } from "./markdown.ts";
import type { Site } from "./sites.ts";
import { accessible, general } from "./units.ts";

/** What a site has, as its publisher may open the workspace now. */
export interface SiteIndex {
  readonly site: Site;
  /** The notes the publisher may open, by path, to resolve links among. */
  readonly notes: LinkIndex;
  readonly byPath: ReadonlyMap<string, string>;
  readonly pathOf: ReadonlyMap<string, string>;
  readonly titleOf: ReadonlyMap<string, string>;
  /** Aliases, lowercased, to the note each names. */
  readonly aliases: ReadonlyMap<string, string>;
  /** The site's pages: each note to its address under the site, "" for its root. */
  readonly pages: ReadonlyMap<string, string>;
  readonly byAddress: ReadonlyMap<string, string>;
  /** Every file and note, by path, to resolve files among, and each file's hash. */
  readonly files: LinkIndex;
  readonly hashOf: ReadonlyMap<string, string>;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Reads what a site has: its pages, and the notes and files its links may name. */
export async function siteIndex(db: Queryable, site: Site): Promise<SiteIndex> {
  const { levels } = await accessible(db, site.publisher, site.workspace);
  const { rows } = await db.query(
    `SELECT s.note, s.path, s.title, s.properties, COALESCE(u.unit_id::text, $2) AS unit
       FROM note_search s
       LEFT JOIN note_units u ON u.workspace_id = s.workspace_id AND u.note = s.note
      WHERE s.workspace_id = $1 AND s.path <> ''`,
    [site.workspace, general],
  );
  const byPath = new Map<string, string>();
  const pathOf = new Map<string, string>();
  const titleOf = new Map<string, string>();
  const aliases = new Map<string, string>();
  const published = new Set<string>();
  for (const row of rows) {
    const unit = readText(row, "unit");
    if (!levels.has(unit)) continue;
    const id = readText(row, "note");
    const path = readText(row, "path");
    byPath.set(path, id);
    pathOf.set(id, path);
    titleOf.set(id, readText(row, "title"));
    const properties = record(row.properties);
    for (const alias of texts(properties.aliases)) aliases.set(alias.toLowerCase(), id);
    // Published only with full access, and not when the note says it is not.
    if (levels.get(unit) === "full" && properties.publish !== false) published.add(id);
  }

  const pages = new Map<string, string>();
  const rootPath = site.rootNote === null ? undefined : pathOf.get(site.rootNote);
  const prefix =
    site.rootFolder !== null
      ? `${site.rootFolder}/`
      : rootPath === undefined
        ? undefined
        : `${rootPath.replace(/\.md$/i, "")}/`;
  if (site.rootNote !== null && rootPath !== undefined && published.has(site.rootNote)) {
    pages.set(site.rootNote, "");
  }
  if (prefix !== undefined && (site.rootNote === null || pages.has(site.rootNote))) {
    for (const [path, id] of byPath) {
      if (!path.startsWith(prefix) || !published.has(id)) continue;
      pages.set(id, path.slice(prefix.length).replace(/\.md$/i, ""));
    }
  }

  const hashOf = new Map<string, string>();
  const { rows: vaults } = await db.query(
    `SELECT name, state FROM documents
      WHERE workspace_id = $1 AND (name = 'vault' OR name LIKE 'vault.%')`,
    [site.workspace],
  );
  for (const row of vaults) {
    const name = readText(row, "name");
    if (!levels.has(name === "vault" ? general : name.slice("vault.".length))) continue;
    const document = new Y.Doc();
    Y.applyUpdate(document, readBytes(row, "state"));
    for (const [path, file] of document.getMap("files").entries()) {
      const hash = record(file instanceof Y.Map ? file.toJSON() : file).hash;
      if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) hashOf.set(path, hash);
    }
    document.destroy();
  }
  return {
    site,
    notes: new LinkIndex(byPath.keys()),
    byPath,
    pathOf,
    titleOf,
    aliases,
    pages,
    byAddress: new Map([...pages].map(([id, address]) => [address, id])),
    files: new LinkIndex([...byPath.keys(), ...hashOf.keys()]),
    hashOf,
  };
}

const webAddress = /^(https?:|mailto:|tel:)/i;

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A path relative to a folder, `..` and `.` taken out; undefined when it leaves the vault. */
function joinPath(folder: string, relative: string): string | undefined {
  const parts = folder === "" ? [] : folder.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Where a site's address leads: its base, and the page's address under it, each part encoded. */
export function pageUrl(base: string, address: string): string {
  return address === "" ? base : `${base}${address.split("/").map(encodeURIComponent).join("/")}`;
}

/** Where the files of a site are served, by their hash. */
export const filesFolder = ".files";

/** What a page needs beside its site: where the site is, and where its stylesheet is. */
export interface Where {
  /** The site's address, ending with a slash, as `/p/notes/`. */
  readonly base: string;
  readonly stylesheet: string;
}

/** The note a link's target names from the note at `from`, among those the publisher may open. */
function resolve(index: SiteIndex, target: LinkTarget, from: string): string | undefined {
  if ("note" in target) return index.pathOf.has(target.note) ? target.note : undefined;
  if (!("title" in target)) return index.byPath.get(from);
  const title = target.title.trim();
  if (title === "") return index.byPath.get(from);
  const path = index.notes.resolve(/\.md$/i.test(title) ? title : `${title}.md`, from);
  return path === undefined ? index.aliases.get(title.toLowerCase()) : index.byPath.get(path);
}

/** The hooks a page is drawn with: links among the site's pages, its files by hash, math and code. */
function hooks(index: SiteIndex, where: Where, from: string, files: Set<string>): HtmlHooks {
  const pageHref = (note: string, anchor = "") => {
    const address = index.pages.get(note);
    return address === undefined ? undefined : `${pageUrl(where.base, address)}${anchor}`;
  };
  const fileHref = (src: string) => {
    const path = index.files.resolve(src, from) ?? index.files.resolve(decode(src), from);
    const hash = path === undefined ? undefined : index.hashOf.get(path);
    if (path === undefined || hash === undefined) return undefined;
    files.add(hash);
    const name = path.slice(path.lastIndexOf("/") + 1);
    return `${where.base}${filesFolder}/${hash}/${encodeURIComponent(name)}`;
  };
  return {
    link: (target) => {
      const note = resolve(index, target, from);
      if (note === undefined) return undefined;
      const heading = "heading" in target ? target.heading : undefined;
      const block = "block" in target ? target.block : undefined;
      const anchor =
        heading !== undefined
          ? `#${headingSlug(heading)}`
          : block !== undefined
            ? `#^${block}`
            : "";
      return pageHref(note, anchor);
    },
    href: (href) => {
      if (webAddress.test(href)) return href;
      if (href.startsWith("#")) return href;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
      const [address = "", anchor] = href.split("#", 2);
      // A path from `/` starts at the vault's folder.
      const path = joinPath(address.startsWith("/") ? "" : folderOf(from), decode(address));
      const note = path === undefined ? undefined : index.byPath.get(path);
      if (note !== undefined) {
        return pageHref(note, anchor === undefined ? "" : `#${headingSlug(decode(anchor))}`);
      }
      return fileHref(address);
    },
    file: (src) => (webAddress.test(src) ? src : fileHref(src)),
    math: mathToMathml,
    code: highlightCode,
    // An embed of a note shows as a link to its page, as the link hook finds it, for now.
  };
}

/** A whole page: its title, the site's header and the article. */
function document(where: Where, site: Site, title: string, article: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${escapeHtml(where.stylesheet)}">`,
    "</head>",
    "<body>",
    `<header class="site"><a href="${escapeHtml(where.base)}">${escapeHtml(site.title)}</a></header>`,
    "<main>",
    "<article>",
    article,
    "</article>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** What drawing a page gives: its status, its HTML, and the files it showed, by hash. */
export interface Drawn {
  readonly status: 200 | 404;
  readonly html: string;
  readonly files: readonly string[];
}

/** The page answered for an address the site has no page at. */
export function notPublished(where: Where, site: Site | undefined): Drawn {
  const article = "<h1>Not published</h1>\n<p>Nothing is published at this address.</p>";
  const html =
    site === undefined
      ? [
          "<!doctype html>",
          '<html lang="en">',
          "<head>",
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1">',
          "<title>Not published</title>",
          `<link rel="stylesheet" href="${escapeHtml(where.stylesheet)}">`,
          "</head>",
          `<body><main><article>${article}</article></main></body>`,
          "</html>",
          "",
        ].join("\n")
      : document(where, site, "Not published", article);
  return { status: 404, html, files: [] };
}

/** A folder's site's first page: its pages, by path. */
function folderIndex(index: SiteIndex, where: Where): Drawn {
  const items = [...index.pages]
    .map(([note, address]) => ({ address, title: index.titleOf.get(note) ?? address }))
    .sort((a, b) => a.address.localeCompare(b.address))
    .map(({ address, title }) => {
      const folder = folderOf(address);
      const detail = folder === "" ? "" : ` <small>${escapeHtml(folder)}</small>`;
      return `<li><a href="${escapeHtml(pageUrl(where.base, address))}">${escapeHtml(title)}</a>${detail}</li>`;
    });
  const article = `<h1 class="title">${escapeHtml(index.site.title)}</h1>\n<nav class="index"><ul>\n${items.join("\n")}\n</ul></nav>`;
  return { status: 200, html: document(where, index.site, index.site.title, article), files: [] };
}

/** Draws the page at an address under a site, as its note is now. */
export async function drawPage(
  db: Queryable,
  index: SiteIndex,
  where: Where,
  address: string,
): Promise<Drawn> {
  if (address === "" && index.site.rootFolder !== null) return folderIndex(index, where);
  const note = index.byAddress.get(address);
  const path = note === undefined ? undefined : index.pathOf.get(note);
  if (note === undefined || path === undefined) return notPublished(where, index.site);
  const { rows } = await db.query(
    "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
    [index.site.workspace, note],
  );
  const state = rows[0] === undefined ? undefined : readBytes(rows[0], "state");
  const parsed = parseMarkdown(readNote(state).markdown);
  const files = new Set<string>();
  const body = await blocksToHtml(
    parsed.content,
    hooks(index, where, path, files),
    parsed.writtenIds,
  );
  const title = index.titleOf.get(note) ?? "";
  const [first] = parsed.content;
  const heading =
    first?.type === "heading" && first.attrs.level === 1
      ? ""
      : `<h1 class="title">${escapeHtml(title)}</h1>\n`;
  const shownTitle =
    address === "" || title === index.site.title ? title : `${title} · ${index.site.title}`;
  return {
    status: 200,
    html: document(where, index.site, shownTitle, `${heading}${body}`),
    files: [...files],
  };
}
