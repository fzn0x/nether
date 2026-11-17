// What a role may do in a workspace (ADR 0089): ten settings, which each of
// the four built-in roles fixes to what it has always given, and a custom
// role, a workspace's own, sets from a base. Every check of what an account
// may do in a workspace reads them through `placeOf`, never a role's name,
// so a custom role holds wherever the server decides. Full access to a unit
// still decides who manages it; these settings only add a gate before it.
//
// An account's settings are the most of each across its sources: its own
// role, and the role each of its groups mapped to the workspace gives. While
// the `permissions` feature is off, a custom role acts as its base, which
// `memberships.role` keeps, as older nodes and apps read it.
import { type Queryable, type Row, readText, readTextOrNull } from "./db.ts";
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

/** Each setting's values, from the least to the most. */
export const settingValues = {
  general: ["none", "view", "comment", "edit", "full"],
  atMost: ["view", "comment", "edit", "full"],
  teamspaces: ["none", "join", "make"],
  members: ["none", "see", "invite", "manage"],
} as const;

const switches = [
  "privateSpace",
  "guests",
  "shareLinks",
  "publishing",
  "export",
  "workspace",
] as const;

/** Where a value stands among its setting's, from 0 for the least. */
function rank(values: readonly string[], value: string): number {
  return values.indexOf(value);
}

/** The most of each setting of two roles: what one who holds both may do. */
export function mostOf(a: RoleSettings, b: RoleSettings): RoleSettings {
  const higher = <T extends string>(values: readonly T[], x: T, y: T): T =>
    rank(values, x) >= rank(values, y) ? x : y;
  return {
    general: higher(settingValues.general, a.general, b.general),
    atMost: higher(settingValues.atMost, a.atMost, b.atMost),
    teamspaces: higher(settingValues.teamspaces, a.teamspaces, b.teamspaces),
    privateSpace: a.privateSpace || b.privateSpace,
    members: higher(settingValues.members, a.members, b.members),
    guests: a.guests || b.guests,
    shareLinks: a.shareLinks || b.shareLinks,
    publishing: a.publishing || b.publishing,
    export: a.export || b.export,
    workspace: a.workspace || b.workspace,
  };
}

/** Whether `have` is at least as much as `give` in every setting: whoever has it may give it. */
export function covers(have: RoleSettings, give: RoleSettings): boolean {
  return (
    rank(settingValues.general, have.general) >= rank(settingValues.general, give.general) &&
    rank(settingValues.atMost, have.atMost) >= rank(settingValues.atMost, give.atMost) &&
    rank(settingValues.teamspaces, have.teamspaces) >=
      rank(settingValues.teamspaces, give.teamspaces) &&
    rank(settingValues.members, have.members) >= rank(settingValues.members, give.members) &&
    switches.every((name) => have[name] || !give[name])
  );
}

/**
 * Settings as a custom role keeps them, or as a request gives them: each
 * one missing, or not one of its values, taken from `base`.
 */
export function readSettings(value: unknown, base: RoleSettings): RoleSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return base;
  const given = value as Readonly<Record<string, unknown>>;
  const pick = <T extends string>(values: readonly T[], key: string, fallback: T): T =>
    (values as readonly unknown[]).includes(given[key]) ? (given[key] as T) : fallback;
  const flag = (key: (typeof switches)[number]): boolean =>
    typeof given[key] === "boolean" ? given[key] : base[key];
  return {
    general: pick(settingValues.general, "general", base.general),
    atMost: pick(settingValues.atMost, "atMost", base.atMost),
    teamspaces: pick(settingValues.teamspaces, "teamspaces", base.teamspaces),
    privateSpace: flag("privateSpace"),
    members: pick(settingValues.members, "members", base.members),
    guests: flag("guests"),
    shareLinks: flag("shareLinks"),
    publishing: flag("publishing"),
    export: flag("export"),
    workspace: flag("workspace"),
  };
}

/** Why settings contradict each other, or undefined when they do not. */
export function settingsProblem(settings: RoleSettings): string | undefined {
  if (
    rank(settingValues.general, settings.general) > rank(settingValues.general, settings.atMost)
  ) {
    return "General's level is no higher than the role's At most.";
  }
  if (settings.atMost !== "full") {
    if (settings.teamspaces === "make") return "Making teamspaces takes At most at full access.";
    if (settings.guests) return "Inviting guests takes At most at full access.";
    if (settings.shareLinks) return "Making share links takes At most at full access.";
    if (settings.publishing) return "Publishing takes At most at full access.";
  }
  return undefined;
}

/** The bases a custom role may have: never an owner's, which owns the workspace. */
export const customBases = ["admin", "member", "guest"] as const;
export type CustomBase = (typeof customBases)[number];

/** A workspace's custom role. */
export interface CustomRole {
  readonly id: string;
  readonly name: string;
  readonly base: CustomBase;
  readonly settings: RoleSettings;
}

function baseOf(text: string): CustomBase {
  return text === "admin" || text === "member" ? text : "guest";
}

/** A custom role from its row's `role_id`, `role_name`, `role_base` and `role_settings`; undefined without one. */
function customRoleOfRow(row: Row): CustomRole | undefined {
  const id = readTextOrNull(row, "role_id");
  if (id === null) return undefined;
  const base = baseOf(readText(row, "role_base"));
  return {
    id,
    name: readText(row, "role_name"),
    base,
    settings: readSettings(row.role_settings, settingsOf(base)),
  };
}

/** A workspace's custom role by its ID, locked for the rest of the transaction when asked. */
export async function customRoleOf(
  db: Queryable,
  workspaceId: string,
  roleId: string,
  lock = false,
): Promise<CustomRole | undefined> {
  const { rows } = await db.query(
    `SELECT id AS role_id, name AS role_name, base AS role_base, settings AS role_settings
       FROM custom_roles WHERE workspace_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [workspaceId, roleId],
  );
  return rows[0] === undefined ? undefined : customRoleOfRow(rows[0]);
}

/** Whether advanced permissions hold now: the `permissions` feature's switch (ADR 0089). */
export class Permissions {
  readonly #on: (db?: Queryable) => Promise<boolean>;

  /** `on` says whether the feature is on, reading through `db` when given, as within a transaction. */
  constructor(on: (db?: Queryable) => Promise<boolean>) {
    this.#on = on;
  }

  on(db?: Queryable): Promise<boolean> {
    return this.#on(db);
  }
}

/** A custom role that holds for an account: its own, or the one a group gives it. */
export interface HeldRole {
  readonly id: string;
  readonly name: string;
  /** The group that gives it; null for the account's own. */
  readonly group: { readonly id: string; readonly name: string } | null;
}

/** An account's place in a workspace: its role, the workspace's encryption, and what it may do. */
export interface Place extends Membership {
  readonly settings: RoleSettings;
  /** The custom roles that hold for it, while the feature is on. */
  readonly customRoles: readonly HeldRole[];
}

/**
 * An account's place in a workspace, or undefined when it is not in it.
 * While advanced permissions are on, its settings are the most of its own
 * role's and its groups', custom roles among them; off, its role's.
 */
export async function placeOf(
  db: Queryable,
  permissions: Permissions,
  userId: string,
  workspaceId: string,
): Promise<Place | undefined> {
  const { rows } = await db.query(
    `SELECT m.role, m.own_role, w.encryption,
            r.id AS role_id, r.name AS role_name, r.base AS role_base, r.settings AS role_settings
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN custom_roles r ON r.workspace_id = m.workspace_id AND r.id = m.custom_role
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const role = readText(row, "role");
  const encryption = readText(row, "encryption") === "end-to-end" ? "end-to-end" : "none";
  if (!(await permissions.on(db))) {
    return { role, encryption, settings: settingsOf(role), customRoles: [] };
  }
  const sources: RoleSettings[] = [];
  const customRoles: HeldRole[] = [];
  const ownRole = readTextOrNull(row, "own_role");
  // `none`: its groups alone give it a place.
  if (ownRole !== "none") {
    const own = customRoleOfRow(row);
    sources.push(own?.settings ?? settingsOf(ownRole ?? role));
    if (own !== undefined) customRoles.push({ id: own.id, name: own.name, group: null });
  }
  const { rows: given } = await db.query(
    `SELECT gw.role, g.id AS group_id, g.name AS group_name,
            r.id AS role_id, r.name AS role_name, r.base AS role_base, r.settings AS role_settings
       FROM group_workspaces gw
       JOIN group_members gm ON gm.group_id = gw.group_id
       JOIN groups g ON g.id = gw.group_id
       LEFT JOIN custom_roles r ON r.workspace_id = gw.workspace_id AND r.id = gw.custom_role
      WHERE gw.workspace_id = $1 AND gm.user_id = $2
      ORDER BY lower(g.name), g.id`,
    [workspaceId, userId],
  );
  for (const each of given) {
    const custom = customRoleOfRow(each);
    sources.push(custom?.settings ?? settingsOf(readText(each, "role")));
    if (custom !== undefined) {
      customRoles.push({
        id: custom.id,
        name: custom.name,
        group: { id: readText(each, "group_id"), name: readText(each, "group_name") },
      });
    }
  }
  const settings = sources.reduce(mostOf, sources[0] ?? settingsOf(role));
  return { role, encryption, settings, customRoles };
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

/** A teamspace or a restricted page, as a refusal names it. */
export interface ManagedUnit {
  readonly id: string;
  readonly kind: "team" | "page";
  readonly name: string;
}

/**
 * The teamspaces and restricted pages of a workspace where one of `users`
 * has a full grant, and no one with a full grant has a role that opens it
 * at full access: no one left to manage them. Read through `db`, so a
 * caller asks before and after a change in its transaction, and refuses a
 * change that leaves one unmanaged that was not.
 */
export async function unmanagedUnits(
  db: Queryable,
  permissions: Permissions,
  workspaceId: string,
  users: readonly string[],
): Promise<ManagedUnit[]> {
  if (users.length === 0) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.kind, u.name, s.title FROM units u
       LEFT JOIN note_search s ON s.workspace_id = u.workspace_id AND s.note = u.root_note
      WHERE u.workspace_id = $1 AND (u.kind = 'team' OR (u.kind = 'page' AND u.restricted))
        AND EXISTS (SELECT 1 FROM unit_grants g
                     WHERE g.unit_id = u.id AND g.level = 'full' AND g.user_id = ANY($2::uuid[]))
      ORDER BY u.id`,
    [workspaceId, users],
  );
  const places = new Map<string, Place | undefined>();
  const found: ManagedUnit[] = [];
  for (const row of rows) {
    const id = readText(row, "id");
    const kind = readText(row, "kind") === "team" ? "team" : "page";
    const { rows: holders } = await db.query(
      "SELECT user_id FROM unit_grants WHERE unit_id = $1 AND level = 'full' ORDER BY user_id",
      [id],
    );
    let kept = false;
    for (const holder of holders) {
      const user = readText(holder, "user_id");
      if (!places.has(user)) places.set(user, await placeOf(db, permissions, user, workspaceId));
      const settings = places.get(user)?.settings;
      if (settings?.atMost === "full" && (kind === "page" || settings.teamspaces !== "none")) {
        kept = true;
        break;
      }
    }
    if (!kept) {
      const name = readTextOrNull(row, "name") ?? readTextOrNull(row, "title") ?? "";
      found.push({ id, kind, name: name === "" ? "Untitled" : name });
    }
  }
  return found;
}

/** The first unit in `after` not in `before`: one a change left unmanaged. */
export function newlyUnmanaged(
  before: readonly ManagedUnit[],
  after: readonly ManagedUnit[],
): ManagedUnit | undefined {
  const was = new Set(before.map((unit) => unit.id));
  return after.find((unit) => !was.has(unit.id));
}

/** Why a change is refused, for leaving a unit unmanaged. */
export function unmanagedRefusal(unit: ManagedUnit): string {
  return unit.kind === "team"
    ? `This would leave the teamspace ${unit.name} with no one to manage it: give someone else full access there first.`
    : `This would leave the page ${unit.name} with no one to manage it: give someone else full access there first.`;
}
