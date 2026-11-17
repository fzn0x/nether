// What a button does when it is clicked (ADR 0072): its actions, one after
// another, each through the app, as Meta Bind runs them. One that fails
// stops the rest, and says why.
import type { ButtonAction, ButtonProblem } from "@nether/automations";
import type { JsonValue, LinkTarget, NoteId } from "@nether/core";
import { parseLinkText } from "@nether/editor";
import { t } from "./messages.ts";
import type { CommandRun, NoteRequest } from "./plugins/codeBlocks.ts";

/** What a button's actions do through the app. */
export interface ButtonHost {
  /** The note the button is in, whose properties a bind target with no note names. */
  readonly note: NoteId;
  readonly runCommand: (command: string) => CommandRun;
  readonly createNote: (request: NoteRequest) => Promise<void>;
  /** The note a bind target names, as a link from the button's note finds it. */
  readonly findNote: (name: string) => NoteId | undefined;
  readonly setProperty: (note: NoteId, key: string, value: JsonValue) => Promise<void>;
  /** Opens a note, or a part of one, as a link in the button's note does. */
  readonly openLink: (target: LinkTarget) => void;
  /** Opens a web address in the browser. */
  readonly openUrl: (url: string) => void;
  readonly wait: (ms: number) => Promise<void>;
}

/** Where an `open` action goes: a note, or a web address. */
export type ButtonLink = { readonly note: LinkTarget } | { readonly url: string };

const webAddress = /^(https?|mailto):/i;

/**
 * What an `open` action's link names, as Meta Bind reads one: `[[Note]]`,
 * with a heading or block after `#`; a Markdown link, `[text](address)`;
 * a web address; or a note by its name.
 */
export function readLink(text: string): ButtonLink | undefined {
  const link = text.trim();
  const wiki = /^!?\[\[([^\]]*)\]\]$/.exec(link);
  if (wiki !== null) {
    const parsed = parseLinkText(wiki[1] ?? "");
    return parsed === undefined ? undefined : { note: parsed.target };
  }
  const markdown = /^\[[^\]]*\]\(([^)]+)\)$/.exec(link);
  let address = (markdown?.[1] ?? link).trim();
  if (webAddress.test(address)) return { url: address };
  if (markdown !== null) {
    try {
      address = decodeURIComponent(address);
    } catch {
      // Kept as written: a `%` that starts no escape.
    }
  }
  const parsed = parseLinkText(address);
  return parsed === undefined || !("title" in parsed.target) ? undefined : { note: parsed.target };
}

/** Why a block is not a button, in the app's words. */
export function problemText(problem: ButtonProblem): string {
  switch (problem.kind) {
    case "yaml":
      return t("buttonYaml", { detail: problem.detail });
    case "notMap":
      return t("buttonNotMap");
    case "noLabel":
      return t("buttonNoLabel");
    case "noAction":
      return t("buttonNoAction");
    case "badAction":
      return problem.action === ""
        ? t("buttonActionType")
        : t("buttonActionField", { action: problem.action, field: problem.field });
  }
}

/** Runs a button's actions in order; rejects with why one failed, the rest not run. */
export async function runActions(
  actions: readonly ButtonAction[],
  host: ButtonHost,
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "command": {
        const run = host.runCommand(action.command);
        if (run === "missing") throw new Error(t("buttonNoCommand", { command: action.command }));
        if (run === "unavailable") {
          throw new Error(t("buttonCommandUnavailable", { command: action.command }));
        }
        break;
      }
      case "createNote":
        await host.createNote({
          folder: action.folderPath ?? "",
          name: action.fileName,
          template: action.templateFile,
          open: action.openNote,
          openIfExists: action.openIfAlreadyExists,
        });
        break;
      case "updateMetadata": {
        const named = action.target.note;
        const note = named === undefined ? host.note : host.findNote(named);
        if (note === undefined) throw new Error(t("buttonNoNote", { note: named ?? "" }));
        await host.setProperty(note, action.target.property, action.value);
        break;
      }
      case "open": {
        const link = readLink(action.link);
        if (link === undefined) throw new Error(t("buttonBadLink", { link: action.link }));
        if ("url" in link) host.openUrl(link.url);
        else host.openLink(link.note);
        break;
      }
      case "sleep":
        await host.wait(action.ms);
        break;
    }
  }
}
