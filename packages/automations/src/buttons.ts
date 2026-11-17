// Buttons (ADR 0072): a `meta-bind-button` code block, in Meta Bind's own
// syntax, read into what the button shows and the actions it runs. What
// Nether does not run is named, so the button can say so and run none of
// its actions.
import type { JsonValue } from "@nether/core";
import { parse } from "yaml";

/** The language of a button's code block, as Meta Bind names it. */
export const buttonLanguage = "meta-bind-button";

/** How a button looks, as Meta Bind names its styles. */
export type ButtonStyle = "default" | "primary" | "destructive" | "plain";

const styles: readonly ButtonStyle[] = ["default", "primary", "destructive", "plain"];

/** A property a button sets: of the note it is in, or of a note a link names. */
export interface BindTarget {
  /** The note, as a link names it; none for the button's own note. */
  readonly note?: string;
  readonly property: string;
}

/** What a button does, in the order it does it. */
export type ButtonAction =
  | { readonly type: "command"; readonly command: string }
  | {
      readonly type: "createNote";
      /** The note's name; none for the app's name for a new note. */
      readonly fileName?: string;
      readonly folderPath?: string;
      /** The template to fill it from, by its path from the vault's folder. */
      readonly templateFile?: string;
      readonly openNote: boolean;
      readonly openIfAlreadyExists: boolean;
    }
  | { readonly type: "updateMetadata"; readonly target: BindTarget; readonly value: JsonValue }
  | { readonly type: "open"; readonly link: string; readonly newTab: boolean }
  | { readonly type: "sleep"; readonly ms: number };

/** A button, as its block says. */
export interface Button {
  readonly label: string;
  readonly style: ButtonStyle;
  readonly tooltip?: string;
  readonly id?: string;
  readonly hidden: boolean;
  readonly actions: readonly ButtonAction[];
  /** What it asks that Nether does not run, by Meta Bind's names; when any, it runs nothing. */
  readonly unsupported: readonly string[];
}

/** Why a block is not a button. */
export type ButtonProblem =
  | { readonly kind: "yaml"; readonly detail: string }
  | { readonly kind: "notMap" }
  | { readonly kind: "noLabel" }
  | { readonly kind: "noAction" }
  | { readonly kind: "badAction"; readonly action: string; readonly field: string };

/** The longest a `sleep` waits, in milliseconds. */
export const longestSleep = 10_000;

/** Meta Bind's actions that Nether reads and does not run: code, input, and edits of the note's text. */
const unrun = new Set([
  "js",
  "inlineJS",
  "input",
  "runTemplaterFile",
  "replaceInNote",
  "replaceSelf",
  "regexpReplaceInNote",
  "insertIntoNote",
]);

const number = /^-?\d+(\.\d+)?$/;

/** A value as Meta Bind reads a literal: null, true, false, a number, or else the text. */
export function readLiteral(value: unknown): JsonValue {
  if (typeof value !== "string") {
    return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonValue);
  }
  if (value.toLowerCase() === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return number.test(value.trim()) ? Number(value) : value;
}

/**
 * The property a Meta Bind bind target names: `property`, `Note#property`
 * or `frontmatter^Note#property`, a name with spaces as `["a b"]`; undefined
 * for its memory, or a nested property, which Nether does not keep.
 */
export function readBindTarget(text: string): BindTarget | undefined {
  let rest = text.trim();
  const caret = rest.indexOf("^");
  if (caret !== -1) {
    if (rest.slice(0, caret).trim() !== "frontmatter") return undefined;
    rest = rest.slice(caret + 1);
  }
  const hash = rest.lastIndexOf("#");
  const note = hash === -1 ? undefined : rest.slice(0, hash).trim();
  let property = (hash === -1 ? rest : rest.slice(hash + 1)).trim();
  const quoted = /^\[\s*"([^"]+)"\s*\]$/.exec(property);
  if (quoted !== null) property = quoted[1] ?? "";
  else if (/[.[\]]/.test(property)) return undefined;
  if (property === "" || note === "") return undefined;
  return note === undefined ? { property } : { note, property };
}

type Read = { readonly action: ButtonAction } | { readonly problem: ButtonProblem } | "unrun";

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  return typeof value === "number" ? String(value) : undefined;
}

/** One action of a block, by Meta Bind's names. */
function readAction(raw: unknown): Read | { readonly unknown: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problem: { kind: "badAction", action: "", field: "type" } };
  }
  const fields = raw as Record<string, unknown>;
  const type = typeof fields.type === "string" ? fields.type : "";
  const bad = (field: string): Read => ({ problem: { kind: "badAction", action: type, field } });
  switch (type) {
    case "":
      return bad("type");
    case "command": {
      const command = text(fields.command);
      return command === undefined ? bad("command") : { action: { type, command } };
    }
    case "createNote":
    case "templaterCreateNote": {
      const fileName = text(fields.fileName);
      const folderPath = text(fields.folderPath);
      const templateFile = text(fields.templateFile);
      if (type === "createNote" && fileName === undefined) return bad("fileName");
      if (type === "templaterCreateNote" && templateFile === undefined) return bad("templateFile");
      return {
        action: {
          type: "createNote",
          ...(fileName === undefined ? {} : { fileName }),
          ...(folderPath === undefined ? {} : { folderPath }),
          ...(templateFile === undefined ? {} : { templateFile }),
          openNote: fields.openNote === true,
          openIfAlreadyExists: fields.openIfAlreadyExists === true,
        },
      };
    }
    case "updateMetadata": {
      if (fields.evaluate === true) return "unrun";
      const target =
        typeof fields.bindTarget === "string" ? readBindTarget(fields.bindTarget) : undefined;
      return target === undefined
        ? bad("bindTarget")
        : { action: { type, target, value: readLiteral(fields.value) } };
    }
    case "open": {
      const link = text(fields.link);
      return link === undefined
        ? bad("link")
        : { action: { type, link, newTab: fields.newTab === true } };
    }
    case "sleep": {
      const ms = typeof fields.ms === "number" ? fields.ms : Number(fields.ms);
      return Number.isFinite(ms) && ms >= 0
        ? { action: { type, ms: Math.min(ms, longestSleep) } }
        : bad("ms");
    }
    default:
      return unrun.has(type) ? "unrun" : { unknown: type };
  }
}

/** A button from its block's text; why it is not one, when it is not. */
export function readButton(
  source: string,
): { readonly button: Button } | { readonly problem: ButtonProblem } {
  let data: unknown;
  try {
    data = parse(source);
  } catch (error) {
    return {
      problem: { kind: "yaml", detail: error instanceof Error ? error.message : String(error) },
    };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { problem: { kind: "notMap" } };
  }
  const fields = data as Record<string, unknown>;
  const label = text(fields.label);
  if (label === undefined) return { problem: { kind: "noLabel" } };
  const listed: unknown[] = Array.isArray(fields.actions)
    ? fields.actions
    : fields.action === undefined
      ? []
      : [fields.action];
  if (listed.length === 0) return { problem: { kind: "noAction" } };
  const actions: ButtonAction[] = [];
  const unsupported: string[] = [];
  for (const raw of listed) {
    const read = readAction(raw);
    if (read === "unrun") {
      const type = (raw as { type?: unknown }).type;
      const evaluated = type === "updateMetadata" ? "updateMetadata with evaluate" : String(type);
      unsupported.push(evaluated);
    } else if ("unknown" in read) {
      unsupported.push(read.unknown);
    } else if ("problem" in read) {
      return { problem: read.problem };
    } else {
      actions.push(read.action);
    }
  }
  const style = styles.find((each) => each === fields.style) ?? "default";
  const tooltip = text(fields.tooltip);
  const id = text(fields.id);
  return {
    button: {
      label,
      style,
      ...(tooltip === undefined ? {} : { tooltip }),
      ...(id === undefined ? {} : { id }),
      hidden: fields.hidden === true,
      actions,
      unsupported,
    },
  };
}
