// A workspace's members: who is in it, and at which role. Owners change
// anyone's role and remove anyone; admins change and remove members and
// guests; anyone may leave. A workspace keeps an active owner: its last
// cannot step down while only deactivated owners remain (ADR 0085). A
// change closes the account's open sync connections, so its apps connect
// again and every document is checked anew: one removed reads nothing more,
// and one made a guest only reads. An instance admin sets roles from the
// admin console (ADR 0083), by the same function and its rules.
//
// A membership has its own role and the roles its groups give it, which a
// directory provisions (ADR 0085). `role` is what every check reads, the
// highest of them; `own_role` keeps the rest: empty when `role` is its own
// and no group gives more, as every row made before; a role when a group
// raised `role` above it; `none` when its groups alone give it. One
// function, `settleMembership`, works a membership out from them, and one,
// `deleteMembership`, removes it, for a removal and a settle alike. Owners
// may raise a member above its groups, but not lower it below them, nor
// remove it, and it may not leave: removing it from a group is the
// directory's.
import type { FastifyInstance } from "fastify";
import {
  type Database,
  type Queryable,
  type Row,
  readBoolean,
  readText,
  readTextOrNull,
  readTime,
} from "./db.ts";
import { fail, uuidField } from "./http.ts";
import { accountOf, signedIn } from "./sessions.ts";
import { type RoleSettings, placeOf, seesMembers, settingsOf } from "./places.ts";
import {
  type EventActor,
  type EventDetails,
  type EventOrigin,
  type ServerEvents,
  accountActor,
  originOf,
} from "./events.ts";

export const roles = ["owner", "admin", "member", "guest"] as const;
export type Role = (typeof roles)[number];

/** Who sets a role: a member of the workspace, at their role there, or an instance admin from the console. */
export interface RoleSetter {
  /** The account that acts. */
  readonly account: string;
  /** Its role in the workspace, or `instance-admin` when an instance admin acts from the console. */
  readonly as: string;
  /** What its role may do there (ADR 0089); its built-in role's settings when not given. */
  readonly may?: RoleSettings;
  /** Where its request came from, for the change to be told of (ADR 0081). */
  readonly origin: EventOrigin;
}

/** What setting a role came to: changed, already so, or refused, with its status and why. */
export type RoleOutcome = "changed" | "same" | readonly [status: 403 | 404 | 409, message: string];

/** What removing a member came to: removed, or refused, with its status and why. */
export type RemoveOutcome = "removed" | readonly [status: 403 | 404 | 409, message: string];

interface WorkspaceParams {
  readonly workspace: string;
}

interface MemberParams extends WorkspaceParams {
  readonly user: string;
}

interface RoleChange {
  readonly role: Role;
}

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

const memberParams = {
  type: "object",
  required: ["workspace", "user"],
  properties: { workspace: uuidField, user: uuidField },
} as const;

const roleBody = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: { role: { type: "string", enum: roles } },
} as const;

const noWorkspace = "This account is in no such workspace.";
const noMember = "This workspace has no such member.";
const lastOwner =
  "A workspace keeps at least one active owner: make another member an owner first.";

/** Each role's rank: an owner's is the highest. */
const ranks: Readonly<Record<Role, number>> = { guest: 0, member: 1, admin: 2, owner: 3 };

/** A role from the database's text: a guest's for what is not one, which gives the least. */
export function roleOf(text: string): Role {
  return (roles as readonly string[]).includes(text) ? (text as Role) : "guest";
}

/** The higher of two roles, either of which may be none. */
export function higherRole(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return ranks[a] >= ranks[b] ? a : b;
}

/** Whether an admin may act on a role: members and guests, not owners or other admins. */
function adminMay(role: string): boolean {
  return role === "member" || role === "guest";
}

/**
 * How far a setter manages a workspace's members: as an owner, any of them,
 * as an instance admin from the console does; as one whose role manages
 * members, as an admin's does, members and guests; or not at all.
 */
function managing(by: RoleSetter): "all" | "members" | "none" {
  if (by.as === "owner" || by.as === "instance-admin") return "all";
  return (by.may ?? settingsOf(by.as)).members === "manage" ? "members" : "none";
}

/** A group, as an event or an answer names it. */
export interface GroupName {
  readonly id: string;
  readonly name: string;
}

/** The highest role an account's groups give it in a workspace, and the group that gives it. */
export interface GroupPlace {
  readonly role: Role;
  readonly group: GroupName;
}

/**
 * The place an account's groups give it in a workspace, by the group that
 * gives the highest role, the first by name among equals; none when no
 * group of theirs is mapped to it.
 */
export async function groupPlace(
  db: Queryable,
  workspace: string,
  user: string,
): Promise<GroupPlace | undefined> {
  const { rows } = await db.query(
    `SELECT g.id, g.name, gw.role FROM group_workspaces gw
       JOIN group_members gm ON gm.group_id = gw.group_id
       JOIN groups g ON g.id = gw.group_id
      WHERE gw.workspace_id = $1 AND gm.user_id = $2
      ORDER BY array_position(ARRAY['member', 'admin', 'owner'], gw.role) DESC, lower(g.name), g.id
      LIMIT 1`,
    [workspace, user],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    role: roleOf(readText(row, "role")),
    group: { id: readText(row, "id"), name: readText(row, "name") },
  };
}

/** A membership's own role, from its row: none when its groups alone give it. */
function ownRole(row: Row): Role | null {
  const own = readTextOrNull(row, "own_role");
  if (own === "none") return null;
  return roleOf(own ?? readText(row, "role"));
}

/** A member's row, locked, and the workspace's active owners besides them. */
interface Locked {
  readonly role: Role;
  readonly active: boolean;
  readonly otherActiveOwners: number;
}

/**
 * Locks a member's row and the workspace's owners', in the order of their
 * accounts' IDs, so two changes cannot leave it no active owner, and none
 * waits on another the other way round, as `settleMembership` locks too.
 */
async function lockMember(
  tx: Queryable,
  workspace: string,
  user: string,
): Promise<Locked | undefined> {
  const { rows } = await tx.query(
    `SELECT m.user_id, m.role, u.deactivated_at IS NULL AS active
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND (m.role = 'owner' OR m.user_id = $2)
      ORDER BY m.user_id
      FOR UPDATE OF m`,
    [workspace, user],
  );
  const row = rows.find((each) => readText(each, "user_id") === user);
  if (row === undefined) return undefined;
  return {
    role: roleOf(readText(row, "role")),
    active: readBoolean(row, "active"),
    otherActiveOwners: rows.filter(
      (each) =>
        readText(each, "user_id") !== user &&
        readText(each, "role") === "owner" &&
        readBoolean(each, "active"),
    ).length,
  };
}

/** Whether a change from `current` to `next`, none for a removal, would take the last active owner. */
function takesLastOwner(locked: Locked, next: Role | null): boolean {
  return (
    locked.role === "owner" && next !== "owner" && locked.active && locked.otherActiveOwners === 0
  );
}

/**
 * Removes a membership, with what it held: its sealed copies of an
 * encrypted workspace's key, which are not given again should it join
 * again, and its grants to the workspace's spaces and pages. The sites
 * and webhooks it made go with it, by their keys.
 */
export async function deleteMembership(
  tx: Queryable,
  workspace: string,
  user: string,
): Promise<void> {
  await tx.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [
    workspace,
    user,
  ]);
  await tx.query("DELETE FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2", [
    workspace,
    user,
  ]);
  await tx.query(
    `DELETE FROM unit_grants WHERE user_id = $2
       AND unit_id IN (SELECT id FROM units WHERE workspace_id = $1)`,
    [workspace, user],
  );
}

/**
 * Sets a member's role under the workspace's rules: its owners, and
 * instance admins, change anyone's; its admins change members' and
 * guests'; it keeps an active owner; and no one lowers a member below
 * what its groups give. The role set is the member's own. A change is
 * told of in its transaction (ADR 0081), whoever made it. When the role
 * changed, the caller closes the account's connections.
 */
export async function setRole(
  db: Database,
  workspace: string,
  user: string,
  role: Role,
  by: RoleSetter,
  events: ServerEvents,
): Promise<RoleOutcome> {
  const manages = managing(by);
  if (manages === "none") {
    return [403, "Only the workspace's owners and admins change roles."];
  }
  return db.transaction(async (tx) => {
    const locked = await lockMember(tx, workspace, user);
    if (locked === undefined) return [404, noMember] as const;
    const current = locked.role;
    if (manages === "members" && !(adminMay(current) && adminMay(role))) {
      return [403, "An admin changes members and guests; owners change the rest."] as const;
    }
    if (takesLastOwner(locked, role)) return [409, lastOwner] as const;
    if (current === role) return "same";
    const given = await groupPlace(tx, workspace, user);
    if (given !== undefined && ranks[role] < ranks[given.role]) {
      return [
        409,
        `The group ${given.group.name} gives them the ${given.role} role here: only their directory changes that.`,
      ] as const;
    }
    await tx.query(
      "UPDATE memberships SET role = $3, own_role = NULL WHERE workspace_id = $1 AND user_id = $2",
      [workspace, user, role],
    );
    await events.emit(
      tx,
      {
        action: "member.role_changed",
        actor: accountActor(by.account),
        workspace,
        target: { type: "account", id: user },
        details: { from: current, to: role, as: by.as },
      },
      by.origin,
    );
    return "changed";
  });
}

/**
 * Removes a member, or, as themselves, has them leave, under the
 * workspace's rules: owners remove anyone, admins members and guests; it
 * keeps an active owner; and a place a group gives is the directory's to
 * take. Told of in its transaction; the caller closes the account's
 * connections.
 */
export async function removeMember(
  db: Database,
  workspace: string,
  user: string,
  by: RoleSetter,
  events: ServerEvents,
): Promise<RemoveOutcome> {
  const leaving = by.account === user;
  return db.transaction(async (tx) => {
    const locked = await lockMember(tx, workspace, user);
    if (locked === undefined) return [404, noMember] as const;
    const { role } = locked;
    const manages = managing(by);
    const allowed = leaving || manages === "all" || (manages === "members" && adminMay(role));
    if (!allowed) return [403, "Owners remove anyone, admins remove members and guests."] as const;
    if (takesLastOwner(locked, null)) return [409, lastOwner] as const;
    const given = await groupPlace(tx, workspace, user);
    if (given !== undefined) {
      return [
        409,
        leaving
          ? `The group ${given.group.name} gives you a place here: only your directory takes it.`
          : `The group ${given.group.name} gives them a place here: only their directory takes it.`,
      ] as const;
    }
    await deleteMembership(tx, workspace, user);
    await events.emit(
      tx,
      {
        action: leaving ? "member.left" : "member.removed",
        actor: accountActor(by.account),
        workspace,
        target: { type: "account", id: user },
        details: { role },
      },
      by.origin,
    );
    return "removed";
  });
}

/** Who settles a membership, as its events name them: a directory, or an instance admin mapping a group. */
export interface Settler {
  readonly actor: EventActor;
  readonly origin: EventOrigin;
  /** The group whose change this settles, which its events name; else the group that gives the most. */
  readonly group?: GroupName;
}

/** What settling a membership came to: the account joined, its role changed, it was removed, or none of these. */
export type Settled = "joined" | "changed" | "removed" | "same";

/**
 * Works out an account's membership of a workspace from its own role and
 * the roles its groups give there, in the caller's transaction, and writes
 * the highest. With neither, it removes the membership as a removal does.
 * Each change is told of with `details.via` `group` and the group. It
 * locks the row it changes; a caller settling several settles them in the
 * order of workspace and then account, as `settleMemberships` does, so two
 * settles cannot wait on each other. When the account joined, changed or
 * was removed, the caller closes its connections once its transaction
 * commits.
 */
export async function settleMembership(
  tx: Queryable,
  workspace: string,
  user: string,
  by: Settler,
  events: ServerEvents,
): Promise<Settled> {
  const { rows } = await tx.query(
    `SELECT role, own_role FROM memberships WHERE workspace_id = $1 AND user_id = $2
      FOR UPDATE`,
    [workspace, user],
  );
  const row = rows[0];
  const own = row === undefined ? null : ownRole(row);
  const given = await groupPlace(tx, workspace, user);
  const settled = higherRole(own, given?.role ?? null);
  const group = by.group ?? given?.group;
  const via: EventDetails = {
    via: "group",
    ...(group === undefined ? {} : { group: { id: group.id, name: group.name } }),
  };
  const tell = (
    action: "member.joined" | "member.role_changed" | "member.removed",
    details: EventDetails,
  ) =>
    events.emit(
      tx,
      {
        action,
        actor: by.actor,
        workspace,
        target: { type: "account", id: user },
        details: { ...details, ...via },
      },
      by.origin,
    );
  if (settled === null) {
    if (row === undefined) return "same";
    await deleteMembership(tx, workspace, user);
    await tell("member.removed", { role: readText(row, "role") });
    return "removed";
  }
  // Empty when the role is its own; none when its groups alone give it.
  const ownKept = own === null ? "none" : own === settled ? null : own;
  if (row === undefined) {
    const { rows: made } = await tx.query(
      `INSERT INTO memberships (workspace_id, user_id, role, own_role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING role`,
      [workspace, user, settled, ownKept],
    );
    // Made meanwhile, as by an invitation accepted: settled as it is now.
    if (made.length === 0) return settleMembership(tx, workspace, user, by, events);
    await tell("member.joined", { role: settled });
    return "joined";
  }
  const current = readText(row, "role");
  if (current === settled && readTextOrNull(row, "own_role") === ownKept) return "same";
  await tx.query(
    "UPDATE memberships SET role = $3, own_role = $4 WHERE workspace_id = $1 AND user_id = $2",
    [workspace, user, settled, ownKept],
  );
  if (current === settled) return "same";
  await tell("member.role_changed", { from: current, to: settled });
  return "changed";
}

/**
 * Settles several memberships, in the order of workspace and then
 * account, and gives the accounts whose place changed, for the caller to
 * close their connections once its transaction commits.
 */
export async function settleMemberships(
  tx: Queryable,
  places: Iterable<{ readonly workspace: string; readonly user: string }>,
  by: Settler,
  events: ServerEvents,
): Promise<Set<string>> {
  const keys = new Map<string, { readonly workspace: string; readonly user: string }>();
  for (const place of places) keys.set(`${place.workspace} ${place.user}`, place);
  const changed = new Set<string>();
  for (const key of [...keys.keys()].sort()) {
    const place = keys.get(key);
    if (place === undefined) continue;
    const settled = await settleMembership(tx, place.workspace, place.user, by, events);
    if (settled !== "same") changed.add(place.user);
  }
  return changed;
}

/**
 * The members' routes. `changed` hears of each account whose place in a
 * workspace changed, to close its connections.
 */
export function registerMembers(
  app: FastifyInstance,
  db: Database,
  changed: (userId: string) => void,
  events: ServerEvents,
): void {
  const account = signedIn(db);

  app.get<{ Params: WorkspaceParams }>(
    "/api/workspaces/:workspace/members",
    { schema: { params: workspaceParams }, preHandler: account },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const place = await placeOf(db, accountOf(request).id, workspace);
      if (place === undefined) return fail(reply, 404, noWorkspace);
      if (!seesMembers(place.settings)) {
        return fail(reply, 403, "A guest sees what is shared with them, not who else is here.");
      }
      const { rows } = await db.query(
        `SELECT u.id, u.name, u.email, m.role, m.created_at,
                u.deactivated_at IS NOT NULL AS deactivated
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1
          ORDER BY lower(u.name), lower(u.email)`,
        [workspace],
      );
      // The groups that give each member a place here, with the role each gives (ADR 0085).
      const placed = await db.query(
        `SELECT gm.user_id, g.id, g.name, gw.role FROM group_workspaces gw
           JOIN group_members gm ON gm.group_id = gw.group_id
           JOIN groups g ON g.id = gw.group_id
          WHERE gw.workspace_id = $1
          ORDER BY array_position(ARRAY['owner', 'admin', 'member'], gw.role), lower(g.name), g.id`,
        [workspace],
      );
      const groups = new Map<string, { id: string; name: string; role: string }[]>();
      for (const row of placed.rows) {
        const user = readText(row, "user_id");
        const list = groups.get(user) ?? [];
        list.push({
          id: readText(row, "id"),
          name: readText(row, "name"),
          role: readText(row, "role"),
        });
        groups.set(user, list);
      }
      return {
        members: rows.map((row) => ({
          id: readText(row, "id"),
          name: readText(row, "name"),
          email: readText(row, "email"),
          role: readText(row, "role"),
          joinedAt: readTime(row, "created_at").toISOString(),
          // Signs in no way until its directory turns it back on (ADR 0085).
          deactivated: readBoolean(row, "deactivated"),
          // The groups that give it a place, the highest role first: below
          // theirs, its role is the directory's to change.
          groups: groups.get(readText(row, "id")) ?? [],
        })),
      };
    },
  );

  app.patch<{ Params: MemberParams; Body: RoleChange }>(
    "/api/workspaces/:workspace/members/:user",
    { schema: { params: memberParams, body: roleBody }, preHandler: account },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const user = request.params.user.toLowerCase();
      const { role } = request.body;
      const myId = accountOf(request).id;
      const me = await placeOf(db, myId, workspace);
      if (me === undefined) return fail(reply, 404, noWorkspace);
      const outcome = await setRole(
        db,
        workspace,
        user,
        role,
        { account: myId, as: me.role, may: me.settings, origin: originOf(request) },
        events,
      );
      if (typeof outcome !== "string") return fail(reply, outcome[0], outcome[1]);
      if (outcome === "changed") changed(user);
      return { id: user, role };
    },
  );

  app.delete<{ Params: MemberParams }>(
    "/api/workspaces/:workspace/members/:user",
    { schema: { params: memberParams }, preHandler: account },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const user = request.params.user.toLowerCase();
      const myId = accountOf(request).id;
      const me = await placeOf(db, myId, workspace);
      if (me === undefined) return fail(reply, 404, noWorkspace);
      const outcome = await removeMember(
        db,
        workspace,
        user,
        { account: myId, as: me.role, may: me.settings, origin: originOf(request) },
        events,
      );
      if (outcome !== "removed") return fail(reply, outcome[0], outcome[1]);
      changed(user);
      return reply.code(204).send();
    },
  );
}
