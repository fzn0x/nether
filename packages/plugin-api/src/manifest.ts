// A plugin's manifest.json: who it is, the API versions it works with, and
// what it adds, which the app shows before the plugin's code runs
// (ADR 0055). Fields mean what Obsidian's do where they share a name.
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

/** What a plugin adds. */
export interface Contributions {
  readonly commands: readonly CommandContribution[];
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

function readCommands(value: unknown, problems: string[]): CommandContribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("contributes.commands is not a list.");
    return [];
  }
  const commands: CommandContribution[] = [];
  const seen = new Set<string>();
  for (const [at, item] of (value as unknown[]).entries()) {
    const where = `contributes.commands[${String(at)}]`;
    if (!isObject(item)) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    const { id, name, menu, keys } = item;
    if (typeof id !== "string" || !commandIdPattern.test(id)) {
      problems.push(`${where}.id is not letters, digits, hyphens and underscores.`);
      continue;
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
    commands.push({
      id,
      name: isLocalized(name) ? name : id,
      menu: menuNames.includes(menu as MenuName) ? (menu as MenuName) : "plugins",
      keys: Array.isArray(keyList) ? keyList.filter((key) => typeof key === "string") : [],
    });
  }
  return commands;
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
      contributes: { commands },
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
