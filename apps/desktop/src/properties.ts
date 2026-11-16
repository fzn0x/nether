// A note's properties as the app shows and edits them: each one's type,
// the vault's choice for its key or else what its value looks like, as
// Obsidian reads them, and values carried over when a type changes. A
// plugin's type for a key is kept with the app's type it stores as, which
// is how it shows without the plugin (ADR 0057).
import {
  type JsonValue,
  type PluginPropertyType,
  type PropertyType,
  type StoredType,
  isPluginPropertyType,
  propertyTypes,
  storedTypes,
} from "@nether/core";

/** The types the app edits, in the order its menu lists them. */
export const editableTypes: readonly PropertyType[] = [
  "text",
  "number",
  "checkbox",
  "date",
  "url",
  "select",
  "multiSelect",
  "person",
  "relation",
  "file",
];

/** A plugin's type chosen for a key, with the app's type it stores as. */
export interface PluginTypeChoice {
  readonly type: PluginPropertyType;
  readonly stores: StoredType;
}

/** The vault's chosen type for each property key, kept in `.nether/properties.json`. */
export type PropertyTypes = Readonly<Record<string, PropertyType | PluginTypeChoice>>;

const isoDate = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** What a value's type looks like, when the vault has not chosen one for its key. */
export function inferType(value: JsonValue): PropertyType {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) {
    return value.length > 0 &&
      value.every((item) => typeof item === "string" && /^\[\[.*\]\]$/.test(item))
      ? "relation"
      : "multiSelect";
  }
  if (typeof value === "string") {
    if (isoDate.test(value)) return "date";
    if (/^https?:\/\/\S+$/i.test(value)) return "url";
    if (/^\[\[.*\]\]$/.test(value)) return "relation";
  }
  return "text";
}

/**
 * A property's type: the vault's choice for its key, or else what its value
 * looks like. For a plugin's type, the app's type it stores as.
 */
export function typeOf(key: string, value: JsonValue, types: PropertyTypes): PropertyType {
  const chosen = types[key];
  if (chosen === undefined) return inferType(value);
  return typeof chosen === "string" ? chosen : chosen.stores;
}

/** The plugin's type the vault chose for a key, if it chose one. */
export function pluginTypeOf(key: string, types: PropertyTypes): PluginTypeChoice | undefined {
  const chosen = types[key];
  return typeof chosen === "object" ? chosen : undefined;
}

function asText(value: JsonValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(asText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Whether a type holds a list of values. */
export function isListType(type: PropertyType): boolean {
  // A person property holds names, as many as work on a thing.
  return type === "multiSelect" || type === "relation" || type === "person";
}

/** A value carried over to another type, as near as it goes: `"a, b"` as a list, `"3"` as a number. */
export function convertValue(value: JsonValue, type: PropertyType): JsonValue {
  const text = asText(value).trim();
  switch (type) {
    case "number": {
      const number = Number(text);
      return text !== "" && Number.isFinite(number) ? number : null;
    }
    case "checkbox":
      return value === true || /^(true|yes|1|x)$/i.test(text);
    case "date":
      return isoDate.test(text) ? text.slice(0, 10) : null;
    case "multiSelect":
    case "relation":
    case "person":
      return Array.isArray(value)
        ? value.map(asText).filter((item) => item !== "")
        : text === ""
          ? []
          : text
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part !== "");
    default:
      return text;
  }
}

/** The entries with `key` moved to just before or after `target`, the others in their order. */
export function moveProperty<T extends { readonly key: string }>(
  entries: readonly T[],
  key: string,
  target: string,
  place: "before" | "after",
): T[] {
  const moving = entries.find((entry) => entry.key === key);
  const rest = entries.filter((entry) => entry.key !== key);
  const at = rest.findIndex((entry) => entry.key === target);
  if (moving === undefined || at === -1) return [...entries];
  const index = place === "before" ? at : at + 1;
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}

/** A new property's key: `property`, then `property 2` and so on, clear of those the note has. */
export function newPropertyKey(taken: readonly string[]): string {
  const keys = new Set(taken.map((key) => key.toLowerCase()));
  if (!keys.has("property")) return "property";
  let n = 2;
  while (keys.has(`property ${String(n)}`)) n++;
  return `property ${String(n)}`;
}

/** A plugin's type as `.nether/properties.json` writes it, if it is one. */
function readPluginChoice(value: unknown): PluginTypeChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, stores } = value as { readonly type?: unknown; readonly stores?: unknown };
  return typeof type === "string" &&
    isPluginPropertyType(type) &&
    (storedTypes as readonly unknown[]).includes(stores)
    ? { type, stores: stores as StoredType }
    : undefined;
}

/**
 * The vault's chosen types, from `.nether/properties.json`, kept only where
 * they are the app's types, or a plugin's with the app's type it stores as.
 */
export function readPropertyTypes(data: unknown): PropertyTypes {
  if (typeof data !== "object" || data === null) return {};
  return Object.fromEntries(
    Object.entries(data).flatMap(([key, value]): [string, PropertyType | PluginTypeChoice][] => {
      if ((propertyTypes as readonly unknown[]).includes(value)) {
        return [[key, value as PropertyType]];
      }
      const plugin = readPluginChoice(value);
      return plugin === undefined ? [] : [[key, plugin]];
    }),
  );
}
