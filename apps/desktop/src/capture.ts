// Quick capture and the share sheet (ADR 0087): what the phones hand the
// app, from the app icon's shortcuts or from another app's share sheet,
// and the new note each capture becomes in its vault's capture folder,
// `Inbox` unless the vault's settings name another. Its title is the
// shared page's title, or the text's first line, or the time; its
// properties are `source`, for a shared link, and `created`; shared files
// are attached beside it and embedded in it. A capture is written into the
// vault's folder without its index, which reads the note as the vault
// opens, so the capture sheet is ready before the vault is.
import type { PropertyEntry } from "@nether/core";
import { safeName, writeFrontmatter } from "@nether/markdown";

/** A file shared to the app, which the app keeps until the capture is filed. */
export interface SharedFile {
  /** Its name, as the app that shared it gave it. */
  readonly name: string;
  /** Its media type, empty when unknown. */
  readonly type: string;
  /** Where the app keeps it until it is filed, as the backend names it. */
  readonly path: string;
}

/** What a capture holds, from the share sheet or typed in the capture sheet. */
export interface CaptureContent {
  /** Its text, which may hold a link; empty when there is none. */
  readonly text: string;
  /** The shared page's title. */
  readonly title?: string;
  /** A shared link. */
  readonly url?: string;
  readonly files: readonly SharedFile[];
}

/** What the share sheet handed the app. */
export interface Shared extends CaptureContent {
  /** The app's own name for it, until it is filed or dropped. */
  readonly id: string;
  /** When it was shared, in milliseconds since 1970. */
  readonly at: number;
  /**
   * The vault the share sheet chose, by its ID, on iOS, whose own sheet
   * asks: the app files it at once. Absent where the capture sheet asks.
   */
  readonly vault?: string;
  /** A vault to make, by its name, when the share sheet found none on the phone. */
  readonly newVault?: string;
}

/** The app icon's shortcuts: Android's app shortcuts, iOS's Home Screen quick actions. */
export const captureShortcuts = ["capture", "newNote", "dayNote", "search"] as const;

export type CaptureShortcut = (typeof captureShortcuts)[number];

/** A shortcut that opens a vault at one of its commands. */
export type VaultShortcut = Exclude<CaptureShortcut, "capture">;

export function isCaptureShortcut(id: string): id is CaptureShortcut {
  return (captureShortcuts as readonly string[]).includes(id);
}

/** What the phone hands the app: a shortcut chosen, or what was shared. */
export type Capture =
  | { readonly kind: "shortcut"; readonly shortcut: CaptureShortcut }
  | { readonly kind: "shared"; readonly shared: Shared };

/** A vault's files as a capture is written into them, before its index or without it. */
export interface CaptureTarget {
  /** A JSON file of the vault's own settings, `.nether/<name>.json`; undefined when missing or unreadable. */
  readData(name: string): Promise<unknown>;
  /** Writes a new note under the first free name beside `path`; gives the path written. */
  create(path: string, text: string): Promise<string>;
  /** Moves a shared file into the vault under the first free name beside `path`; gives the path written. */
  adopt(path: string, file: SharedFile): Promise<string>;
}

/** Where the vault's capture settings are, as `.nether/capture.json`. */
export const captureSettingsName = "capture";

/** The folder captures go in when the vault's settings name none. */
export const defaultCaptureFolder = "Inbox";

/** The longest title a capture's file name takes. */
const longestTitle = 100;

const linkPattern = /\bhttps?:\/\/[^\s<>"]+/i;

/** A folder as the settings name it, each part a name a file system and a link hold. */
export function cleanCaptureFolder(folder: string): string {
  return folder
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => safeName(part))
    .join("/");
}

/** The vault's capture folder, from its settings; `Inbox` when they name none. */
export function captureFolder(settings: unknown): string {
  const folder =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as { readonly folder?: unknown }).folder
      : undefined;
  if (typeof folder !== "string") return defaultCaptureFolder;
  const clean = cleanCaptureFolder(folder);
  return clean === "" ? defaultCaptureFolder : clean;
}

/**
 * A capture's link and text apart: the link it was given, or else the
 * first web address in its text; the text without the link when the text
 * was only that.
 */
export function splitLink(content: Pick<CaptureContent, "text" | "url">): {
  readonly text: string;
  readonly url?: string;
} {
  const text = content.text.trim();
  const given = content.url?.trim() ?? "";
  // A sentence's own stop or closing bracket after an address is not part of it.
  const url = given !== "" ? given : linkPattern.exec(text)?.[0].replace(/[.,;:!?)\]]+$/, "");
  if (url === undefined) return { text };
  return { text: text === url ? "" : text, url };
}

/** A date and time as a date property holds it, to the minute, in the phone's own time zone. */
export function localStamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}`
  );
}

/** A title as a file name takes it, never too long for one. */
function fileTitle(title: string): string {
  const name = safeName(title, "");
  if (name.length <= longestTitle) return name;
  return name.slice(0, longestTitle).replace(/[. ]+$/, "");
}

/**
 * A capture's title, as its file's name: the shared page's title, or its
 * text's first line, without a heading's or a list's marks, or `fallback`,
 * which names the time.
 */
export function captureTitle(content: CaptureContent, fallback: string): string {
  const { text } = splitLink(content);
  const firstLine = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*)/, "").trim())
    .find((line) => line !== "");
  for (const candidate of [content.title, firstLine]) {
    const name = candidate === undefined ? "" : fileTitle(candidate);
    if (name !== "") return name;
  }
  const named = fileTitle(fallback);
  return named === "" ? "Capture" : named;
}

/** A shared file's name in the vault: its own, without what file systems or links cannot hold. */
export function sharedFileName(file: SharedFile, fallback: string): string {
  const name = file.name
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\p{Cc}/gu, "")
    .replace(/^[.\s]+/, "")
    .trim();
  if (name !== "") return name;
  const type = /^[a-z]+\/([a-z0-9]+)/i.exec(file.type)?.[1]?.toLowerCase();
  return type === undefined ? fallback : `${fallback}.${type === "jpeg" ? "jpg" : type}`;
}

/**
 * A capture's note: `source` and `created` as frontmatter, its text, its
 * link when the text does not hold it, and an embed of each file attached
 * to it, by its path in the vault.
 */
export function captureMarkdown(
  content: CaptureContent,
  attached: readonly string[],
  created: Date,
): string {
  const { text, url } = splitLink(content);
  const properties: PropertyEntry[] = [
    ...(url === undefined ? [] : [{ key: "source", value: url }]),
    { key: "created", value: localStamp(created) },
  ];
  const yaml = writeFrontmatter(undefined, [], properties) ?? "";
  const parts = [
    text,
    url === undefined || text.includes(url) ? "" : `<${url}>`,
    attached.map((path) => `![[${path}]]`).join("\n"),
  ].filter((part) => part !== "");
  return `---\n${yaml.replace(/\n$/, "")}\n---\n${parts.join("\n\n")}${parts.length > 0 ? "\n" : ""}`;
}

/**
 * Files a capture as a new note in its vault's capture folder, with its
 * files attached beside it; gives the note's path. `untitled` names a
 * capture that has neither a title nor text, by the time.
 */
export async function fileCapture(
  target: CaptureTarget,
  content: CaptureContent,
  created: Date,
  untitled: string,
): Promise<string> {
  const folder = captureFolder(await target.readData(captureSettingsName));
  const title = captureTitle(content, untitled);
  const attached: string[] = [];
  for (const [index, file] of content.files.entries()) {
    const name = sharedFileName(file, `${title} ${String(index + 1)}`);
    attached.push(await target.adopt(`${folder}/${name}`, file));
  }
  const markdown = captureMarkdown(content, attached, created);
  return target.create(`${folder}/${title}.md`, markdown);
}
