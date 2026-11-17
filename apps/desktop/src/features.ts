// What a build of the app shows. Sync and collaboration show in every
// build, now that `docker compose up` starts a server for them; a build made
// with VITE_NETHER_SYNC=off leaves their commands and menu out, as for a
// copy meant never to reach a server. The web app, built with
// VITE_NETHER_TARGET=web, is its server's, so it always syncs (ADR 0053),
// and leaves out what a page in a browser cannot do yet. The mobile apps,
// built with VITE_NETHER_TARGET=mobile, keep vaults on the phone (ADR 0087),
// sign in and sync as the desktop app does, export through the share sheet
// and send a note's copy there, which only they do, and leave out what
// comes to them later, the graph and canvases; updates, which the stores
// give; and webhooks and access tokens, which stay in the desktop and web
// apps.
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
  sync: web || import.meta.env.VITE_NETHER_SYNC !== "off",
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

/**
 * What the mobile apps leave out (ADR 0087): what later parts bring, what
 * the stores do, and webhooks and access tokens, which stay on the desktop
 * and the web.
 */
const notOnPhonesYet: ReadonlySet<CommandId> = new Set([
  "openGraph",
  "newCanvas",
  "checkUpdates",
  "updateChecks",
  "webhooks",
  "apiTokens",
]);

/** What only the mobile apps show: a note's copy to the system's share sheet. */
const onlyOnPhones: ReadonlySet<CommandId> = new Set(["sendCopy"]);

/** Whether a build shows a command. */
export function shownIn(build: Build, id: CommandId): boolean {
  if (build.web && notOnTheWeb.has(id)) return false;
  if (build.mobile === true && notOnPhonesYet.has(id)) return false;
  if (build.mobile !== true && onlyOnPhones.has(id)) return false;
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
