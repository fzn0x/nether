// A plugin's manifest.json: who it is, the API versions it works with, and
// what it adds, which the app shows before the plugin's code runs
// (ADR 0055). Fields mean what Obsidian's do where they share a name.
import { type JsonObject, isJsonObject } from "./json.ts";
import { isRange, isVersion } from "./version.ts";

/** A name or text, alone or by language tag, as `{ "en": "Copy", "fr": "Copier" }`. */
export type Localized = string | Readonly<Record<string, string>>;

/** The app's menus a command may sit in. */
export const menuNames = ["file", "note", "view", "sync", "settings", "plugins"] as const;
export type MenuName = (typeof menuNames)[number];

/** A command a plugin adds, which its code attaches by `id` when it runs. */
export interface CommandContribution {
  /** Unique in the plugin; the app knows it as `plugin-id:id`. */
  readonly id: string;
  readonly name: Localized;
  /** The menu it sits in, as every command does: Plugins unless it says another. */
  readonly menu: MenuName;
  /** Its shortcuts unless the vault chooses others, as `Mod+Shift+K`. */
  readonly keys: readonly string[];
}

/** How the slash menu offers something a plugin adds, to insert a new one. */
export interface SlashEntry {
  readonly name: Localized;
  /** More words the slash menu finds it by, separated by spaces. */
  readonly keywords?: Localized;
}

/**
 * A code block's language a plugin draws, as `mermaid` for a block fenced
 * with ` ```mermaid `. The code stays as it is written; what the plugin
 * draws shows below it in the editor, and takes its place in HTML.
 */
export interface CodeBlockContribution {
  /** Lowercase here; the app matches a fence's language whatever its case. */
  readonly language: string;
  /** With a name, the slash menu inserts a block in the language, holding `text`. */
  readonly slash?: SlashEntry & { readonly text: string };
}

/**
 * A type of block a plugin adds, which a note's file writes as a code
 * block named `plugin-id/type` holding its attributes as JSON. The
 * slash menu inserts one; the plugin's view shows it.
 */
export interface BlockContribution {
  /** A lowercase letter, then letters, digits and hyphens. */
  readonly type: string;
  readonly slash: SlashEntry;
  /** What a new block holds. */
  readonly attrs: JsonObject;
}

/** What a plugin adds. */
export interface Contributions {
  readonly commands: readonly CommandContribution[];
  readonly codeBlocks: readonly CodeBlockContribution[];
  readonly blocks: readonly BlockContribution[];
}

export interface Manifest {
  /** Lowercase words joined by hyphens, as `word-count`. */
  readonly id: string;
  readonly name: Localized;
  /** The plugin's own version, as `1.0.2`. */
  readonly version: string;
  /** The API versions it works with, as `^0.1`. */
  readonly api: string;
  readonly description?: Localized;
  readonly author?: string;
  readonly authorUrl?: string;
  readonly contributes: Contributions;
}

/** A manifest, or what is wrong with one. */
export type ManifestResult =
  | { readonly manifest: Manifest; readonly problems?: undefined }
  | { readonly manifest?: undefined; readonly problems: readonly string[] };

const pluginIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commandIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const languagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** A fence's language, as `mermaid`, `c++` or `objective-c`. */
const codeLanguagePattern = /^[a-z0-9][a-z0-9_+#.-]*$/;
/** The second half of a plugin block's type, as `@nether/core` reads it. */
const blockTypePattern = /^[a-z][a-zA-Z0-9-]*$/;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalized(value: unknown): value is Localized {
  if (typeof value === "string") return value.trim() !== "";
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([language, text]) =>
        languagePattern.test(language) && typeof text === "string" && text.trim() !== "",
    )
  );
}

/** Reads `contributes.<field>`, a list of objects, with `read` for each; nothing is an empty list. */
function readList<T>(
  value: unknown,
  field: string,
  problems: string[],
  read: (item: Readonly<Record<string, unknown>>, where: string) => T | undefined,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`contributes.${field} is not a list.`);
    return [];
  }
  const contributions: T[] = [];
  for (const [at, item] of (value as unknown[]).entries()) {
    const where = `contributes.${field}[${String(at)}]`;
    if (!isObject(item)) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    const contribution = read(item, where);
    if (contribution !== undefined) contributions.push(contribution);
  }
  return contributions;
}

function readCommands(value: unknown, problems: string[]): CommandContribution[] {
  const seen = new Set<string>();
  return readList(value, "commands", problems, (item, where) => {
    const { id, name, menu, keys } = item;
    if (typeof id !== "string" || !commandIdPattern.test(id)) {
      problems.push(`${where}.id is not letters, digits, hyphens and underscores.`);
      return undefined;
    }
    if (seen.has(id)) problems.push(`${where}.id "${id}" is there twice.`);
    seen.add(id);
    if (!isLocalized(name)) problems.push(`${where}.name is not a name.`);
    if (menu !== undefined && !menuNames.includes(menu as MenuName)) {
      problems.push(`${where}.menu is not one of ${menuNames.join(", ")}.`);
    }
    const keyList: unknown = keys ?? [];
    if (!Array.isArray(keyList) || !keyList.every((key) => typeof key === "string")) {
      problems.push(`${where}.keys is not a list of shortcuts.`);
    }
    return {
      id,
      name: isLocalized(name) ? name : id,
      menu: menuNames.includes(menu as MenuName) ? (menu as MenuName) : "plugins",
      keys: Array.isArray(keyList) ? keyList.filter((key) => typeof key === "string") : [],
    };
  });
}

/** A slash entry's name and keywords, when it has a name. */
function readSlash(
  item: Readonly<Record<string, unknown>>,
  where: string,
  problems: string[],
): SlashEntry | undefined {
  const { name, keywords } = item;
  if (keywords !== undefined && !isLocalized(keywords)) {
    problems.push(`${where}.keywords is not text.`);
  }
  if (name === undefined) return undefined;
  if (!isLocalized(name)) {
    problems.push(`${where}.name is not a name.`);
    return undefined;
  }
  return isLocalized(keywords) ? { name, keywords } : { name };
}

function readCodeBlocks(value: unknown, problems: string[]): CodeBlockContribution[] {
  const seen = new Set<string>();
  return readList(value, "codeBlocks", problems, (item, where) => {
    const { language, text } = item;
    if (typeof language !== "string" || !codeLanguagePattern.test(language)) {
      problems.push(`${where}.language is not a code block's language in lowercase, as mermaid.`);
      return undefined;
    }
    if (seen.has(language)) problems.push(`${where}.language "${language}" is there twice.`);
    seen.add(language);
    if (text !== undefined && typeof text !== "string") problems.push(`${where}.text is not text.`);
    const slash = readSlash(item, where, problems);
    return slash === undefined
      ? { language }
      : { language, slash: { ...slash, text: typeof text === "string" ? text : "" } };
  });
}

function readBlocks(value: unknown, problems: string[]): BlockContribution[] {
  const seen = new Set<string>();
  return readList(value, "blocks", problems, (item, where) => {
    const { type, attrs } = item;
    if (typeof type !== "string" || !blockTypePattern.test(type)) {
      problems.push(`${where}.type is not a lowercase letter, then letters, digits and hyphens.`);
      return undefined;
    }
    if (seen.has(type)) problems.push(`${where}.type "${type}" is there twice.`);
    seen.add(type);
    if (attrs !== undefined && !isJsonObject(attrs)) {
      problems.push(`${where}.attrs is not a JSON object.`);
    }
    const slash = readSlash(item, where, problems);
    if (slash === undefined) {
      if (item.name === undefined) problems.push(`${where}.name is not a name.`);
      return undefined;
    }
    return { type, slash, attrs: isJsonObject(attrs) ? attrs : {} };
  });
}

/** Reads a manifest as parsed from its JSON, or says everything wrong with it. */
export function readManifest(value: unknown): ManifestResult {
  if (!isObject(value)) return { problems: ["The manifest is not an object."] };
  const problems: string[] = [];
  const { id, name, version, api, description, author, authorUrl, contributes } = value;
  if (typeof id !== "string" || !pluginIdPattern.test(id)) {
    problems.push("id is not lowercase words joined by hyphens.");
  }
  if (!isLocalized(name)) problems.push("name is not a name.");
  if (typeof version !== "string" || !isVersion(version)) {
    problems.push("version is not a version, as 1.0.0.");
  }
  if (typeof api !== "string" || !isRange(api)) {
    problems.push("api is not a range of versions, as ^0.1.");
  }
  if (description !== undefined && !isLocalized(description)) {
    problems.push("description is not text.");
  }
  if (author !== undefined && typeof author !== "string") problems.push("author is not text.");
  if (authorUrl !== undefined && typeof authorUrl !== "string") {
    problems.push("authorUrl is not text.");
  }
  if (contributes !== undefined && !isObject(contributes)) {
    problems.push("contributes is not an object.");
  }
  const commands = readCommands(isObject(contributes) ? contributes.commands : undefined, problems);
  const codeBlocks = readCodeBlocks(
    isObject(contributes) ? contributes.codeBlocks : undefined,
    problems,
  );
  const blocks = readBlocks(isObject(contributes) ? contributes.blocks : undefined, problems);
  // A plugin block's type starts with its plugin's ID, which must then start with a letter.
  if (blocks.length > 0 && typeof id === "string" && !/^[a-z]/.test(id)) {
    problems.push("id starts with a digit, which a plugin that adds blocks cannot.");
  }
  if (problems.length > 0) return { problems };
  return {
    manifest: {
      id: id as string,
      name: name as Localized,
      version: version as string,
      api: api as string,
      ...(description === undefined ? {} : { description: description as Localized }),
      ...(author === undefined ? {} : { author: author as string }),
      ...(authorUrl === undefined ? {} : { authorUrl: authorUrl as string }),
      contributes: { commands, codeBlocks, blocks },
    },
  };
}

/**
 * The text for a language: its own, else its main language's (`pt` for
 * `pt-BR`), else English, else the first there is.
 */
export function localize(text: Localized, language: string): string {
  if (typeof text === "string") return text;
  const lower = new Map(Object.entries(text).map(([tag, value]) => [tag.toLowerCase(), value]));
  const wanted = language.toLowerCase();
  return (
    lower.get(wanted) ??
    lower.get(wanted.split("-")[0] ?? wanted) ??
    lower.get("en") ??
    Object.values(text)[0] ??
    ""
  );
}
