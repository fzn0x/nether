// What a build of the app shows. Sync and collaboration show in every
// build, now that `docker compose up` starts a server for them; a build made
// with VITE_NETHER_SYNC=off leaves their commands and menu out, as for a
// copy meant never to reach a server. The web app, built with
// VITE_NETHER_TARGET=web, is its server's, so it always syncs (ADR 0053),
// and leaves out what a page in a browser cannot do yet. The mobile apps,
// built with VITE_NETHER_TARGET=mobile, keep vaults on the phone (ADR 0087)
// and leave out what comes to them in later parts: sync and signing in,
// exports through the share sheet, the graph and canvases, and updates,
// which the stores give.
import type { CommandId } from "./commands.ts";

/** What a build is made for. */
export interface Build {
  /** The web app, which its server serves. */
  readonly web: boolean;
  /** Whether sync and collaboration show. */
  readonly sync: boolean;
  /** The mobile apps, for Android and iOS. */
  readonly mobile?: boolean;
}

const web = import.meta.env.VITE_NETHER_TARGET === "web";
const mobile = import.meta.env.VITE_NETHER_TARGET === "mobile";

export const build: Build = {
  web,
  mobile,
  sync: web || (!mobile && import.meta.env.VITE_NETHER_SYNC !== "off"),
};

export const syncShown = build.sync;

const syncCommands: ReadonlySet<CommandId> = new Set([
  "servers",
  "sync",
  "members",
  "spaces",
  "share",
  "notifications",
  "webhooks",
  "apiTokens",
]);

/**
 * What the web app leaves out: linking a vault to a workspace, as each of
 * its vaults is one, and updates, which come with its server.
 */
const notOnTheWeb: ReadonlySet<CommandId> = new Set(["sync", "checkUpdates", "updateChecks"]);

/** What the mobile apps leave out until the parts that bring them (ADR 0087). */
const notOnPhonesYet: ReadonlySet<CommandId> = new Set([
  "export",
  "openGraph",
  "newCanvas",
  "checkUpdates",
  "updateChecks",
]);

/** Whether a build shows a command. */
export function shownIn(build: Build, id: CommandId): boolean {
  if (build.web && notOnTheWeb.has(id)) return false;
  if (build.mobile === true && notOnPhonesYet.has(id)) return false;
  return build.sync || !syncCommands.has(id);
}

/** Whether this build shows a command. */
export function commandShown(id: CommandId): boolean {
  return shownIn(build, id);
}

/**
 * A menu's commands a build shows, without the separators leaving some out
 * would put at its ends or side by side.
 */
export function shownEntries(
  ids: readonly (CommandId | "separator")[],
  shown: (id: CommandId) => boolean = commandShown,
): (CommandId | "separator")[] {
  const entries: (CommandId | "separator")[] = [];
  for (const id of ids) {
    if (id !== "separator") {
      if (shown(id)) entries.push(id);
    } else if (entries.length > 0 && entries.at(-1) !== "separator") {
      entries.push(id);
    }
  }
  if (entries.at(-1) === "separator") entries.pop();
  return entries;
}
