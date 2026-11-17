// What a role may do in a workspace (ADR 0089): ten settings, which each of
// the four built-in roles fixes to what it has always given. Every check
// of what an account may do in a workspace reads them through `placeOf`,
// never a role's name, so a role that sets them otherwise holds wherever
// the server decides. Full access to a unit still decides who manages it;
// these settings only add a gate before it.
import { type Queryable, readText } from "./db.ts";
import type { Role } from "./members.ts";
import type { Level } from "./units.ts";

export type Encryption = "none" | "end-to-end";

/** An account's place in a workspace. */
export interface Membership {
  readonly role: string;
  readonly encryption: Encryption;
}

/** An account's role in a workspace, and whether the workspace is encrypted. */
export async function membership(
  db: Queryable,
  userId: string,
  workspaceId: string,
): Promise<Membership | undefined> {
  const { rows } = await db.query(
    `SELECT m.role, w.encryption FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    role: readText(row, "role"),
    encryption: readText(row, "encryption") === "end-to-end" ? "end-to-end" : "none",
  };
}

/** What a role may do in a workspace. */
export interface RoleSettings {
  /** The level at which General opens; none, it is not opened. */
  readonly general: Level | "none";
  /** The highest level anything opens at, whatever is granted; a private space stays full. */
  readonly atMost: Level;
  /** Making teamspaces and joining them; joining them only; or neither. */
  readonly teamspaces: "make" | "join" | "none";
  readonly privateSpace: boolean;
  /**
   * Changing and removing members and guests, and inviting; inviting
   * members and admins, and seeing them; seeing who is in the workspace;
   * or none of these.
   */
  readonly members: "manage" | "invite" | "see" | "none";
  /** Inviting a guest to a page it has full access to. */
  readonly guests: boolean;
  /** Making links to a page it has full access to. */
  readonly shareLinks: boolean;
  /** Publishing a page or a folder it has full access to. */
  readonly publishing: boolean;
  /** Reading the workspace's text and rows through the public API, and the apps' export. */
  readonly export: boolean;
  /** The workspace's settings, its publishing switch, every one of its sites, and its webhooks. */
  readonly workspace: boolean;
}

const member: RoleSettings = {
  general: "full",
  atMost: "full",
  teamspaces: "make",
  privateSpace: true,
  members: "see",
  guests: true,
  shareLinks: true,
  publishing: true,
  export: true,
  workspace: false,
};

const admin: RoleSettings = { ...member, members: "manage", workspace: true };

/** The built-in roles' settings, which give what each role has always given. */
export const builtInSettings: Readonly<Record<Role, RoleSettings>> = {
  owner: admin,
  admin,
  member,
  guest: {
    ...member,
    general: "none",
    teamspaces: "none",
    privateSpace: false,
    members: "none",
  },
};

/** A built-in role's settings: a guest's, which give the least, for a name that is not one. */
export function settingsOf(role: string): RoleSettings {
  return role === "owner" || role === "admin" || role === "member"
    ? builtInSettings[role]
    : builtInSettings.guest;
}

/** An account's place in a workspace: its role, the workspace's encryption, and what it may do. */
export interface Place extends Membership {
  readonly settings: RoleSettings;
}

/** An account's place in a workspace, or undefined when it is not in it. */
export async function placeOf(
  db: Queryable,
  userId: string,
  workspaceId: string,
): Promise<Place | undefined> {
  const found = await membership(db, userId, workspaceId);
  if (found === undefined) return undefined;
  return { ...found, settings: settingsOf(found.role) };
}

const levels: readonly Level[] = ["view", "comment", "edit", "full"];

/** A level cut to a role's At most; undefined stays undefined. */
export function cut(level: Level | undefined, settings: RoleSettings): Level | undefined {
  if (level === undefined) return undefined;
  return levels.indexOf(level) <= levels.indexOf(settings.atMost) ? level : settings.atMost;
}

/** The level at which a role opens General, cut to its At most; undefined when it opens none. */
export function generalLevel(settings: RoleSettings): Level | undefined {
  return settings.general === "none" ? undefined : cut(settings.general, settings);
}

/** Whether a role sees who is in the workspace. */
export function seesMembers(settings: RoleSettings): boolean {
  return settings.members !== "none";
}

/** Whether a role invites members and admins, and sees the invitations waiting. */
export function invitesMembers(settings: RoleSettings): boolean {
  return settings.members === "invite" || settings.members === "manage";
}
