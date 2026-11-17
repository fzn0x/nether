// What changes a directory's groups (ADR 0085): a SCIM client making,
// renaming, changing the members of and removing a group, and an instance
// admin mapping a group to a workspace at a role. Each change settles the
// memberships it touches, through core's `settleMembership`, in the
// request's one transaction, and gives the accounts whose place changed,
// whose connections the caller closes once it commits.
import { randomUUID } from "node:crypto";
import { type Queryable, readText, readTextOrNull, readTime } from "@nether/server/src/db.ts";
import type { EventActor, EventOrigin, ServerEvents } from "@nether/server/src/events.ts";
import { type GroupName, type Role, settleMemberships } from "@nether/server/src/members.ts";
import { ScimError } from "./errors.ts";
import type { GroupDoc } from "./groupDoc.ts";
import type { GroupRow } from "./groups.ts";

/** Who changes a group, as its events name them: the directory, or an instance admin. */
export interface GroupChanger {
  readonly directory: string;
  readonly actor: EventActor;
  readonly origin: EventOrigin;
  readonly events: ServerEvents;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The roles a group may give: guests come by pages, so none makes one. */
export const groupRoles = ["owner", "admin", "member"] as const;

/** The workspaces a group is mapped to. */
async function mappedWorkspaces(tx: Queryable, group: string): Promise<string[]> {
  const { rows } = await tx.query(
    "SELECT workspace_id FROM group_workspaces WHERE group_id = $1 ORDER BY workspace_id",
    [group],
  );
  return rows.map((row) => readText(row, "workspace_id"));
}

/**
 * Settles each of the accounts' places in each workspace, and gives those
 * whose place changed; and, where the group gives a custom role, all of
 * them, as what they may do changes with their role unchanged (ADR 0089).
 */
async function settle(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupName,
  workspaces: readonly string[],
  users: Iterable<string>,
): Promise<Set<string>> {
  const accounts = [...users];
  const places: { workspace: string; user: string }[] = [];
  for (const user of accounts) {
    for (const workspace of workspaces) places.push({ workspace, user });
  }
  const changed = await settleMemberships(
    tx,
    places,
    { actor: changer.actor, origin: changer.origin, group },
    changer.events,
  );
  if (await givesCustomRole(tx, group.id, workspaces)) {
    for (const user of accounts) changed.add(user);
  }
  return changed;
}

/** Whether a group gives a custom role in any of the workspaces. */
async function givesCustomRole(
  tx: Queryable,
  group: string,
  workspaces: readonly string[],
): Promise<boolean> {
  if (workspaces.length === 0) return false;
  const { rows } = await tx.query(
    `SELECT 1 FROM group_workspaces
      WHERE group_id = $1 AND workspace_id = ANY($2::uuid[]) AND custom_role IS NOT NULL`,
    [group, workspaces],
  );
  return rows.length > 0;
}

/** Checks each member is an account the directory manages: no group, no one else's account. */
async function checkMembers(
  tx: Queryable,
  directory: string,
  members: readonly string[],
): Promise<void> {
  const notIds = members.filter((id) => !uuid.test(id));
  if (notIds.length > 0) {
    throw new ScimError(400, `${notIds[0] ?? ""} is not a user of this directory.`, "invalidValue");
  }
  if (members.length === 0) return;
  const { rows } = await tx.query(
    "SELECT user_id FROM directory_accounts WHERE directory_id = $1 AND user_id = ANY($2::uuid[])",
    [directory, members],
  );
  const known = new Set(rows.map((row) => readText(row, "user_id")));
  const unknown = members.find((id) => !known.has(id));
  if (unknown !== undefined) {
    throw new ScimError(
      400,
      `${unknown} is not a user of this directory: a group's members are its users, never groups.`,
      "invalidValue",
    );
  }
}

/**
 * Makes a group, or changes one, in the caller's transaction, to what the
 * request gives: its name, unique in the directory, its externalId and
 * its members. Telling of each change, it settles the places of the
 * members it adds and removes in each workspace the group is mapped to.
 */
export async function writeGroup(
  tx: Queryable,
  changer: GroupChanger,
  existing: GroupRow | undefined,
  doc: GroupDoc,
): Promise<{ readonly groupId: string; readonly closing: Set<string> }> {
  const { directory, actor, origin, events } = changer;
  const named = await tx.query(
    "SELECT id FROM groups WHERE directory_id = $1 AND lower(name) = lower($2)",
    [directory, doc.displayName],
  );
  const namedId = named.rows[0] === undefined ? undefined : readText(named.rows[0], "id");
  if (namedId !== undefined && namedId !== existing?.id) {
    throw new ScimError(
      409,
      `This directory has a group named ${doc.displayName} already.`,
      "uniqueness",
    );
  }
  await checkMembers(tx, directory, doc.members);
  const groupId = existing?.id ?? randomUUID();
  const group: GroupName = { id: groupId, name: doc.displayName };
  const target = { type: "group", id: groupId, name: doc.displayName };
  if (existing === undefined) {
    await tx.query(
      "INSERT INTO groups (id, directory_id, name, external_id) VALUES ($1, $2, $3, $4)",
      [groupId, directory, doc.displayName, doc.externalId],
    );
    await events.emit(
      tx,
      {
        action: "group.created",
        actor,
        target,
        details: { externalId: doc.externalId },
      },
      origin,
    );
  } else if (existing.name !== doc.displayName || existing.externalId !== doc.externalId) {
    await tx.query(
      "UPDATE groups SET name = $2, external_id = $3, updated_at = now() WHERE id = $1",
      [groupId, doc.displayName, doc.externalId],
    );
    await events.emit(
      tx,
      {
        action: "group.changed",
        actor,
        target,
        details: {
          from: { name: existing.name, externalId: existing.externalId },
          to: { name: doc.displayName, externalId: doc.externalId },
        },
      },
      origin,
    );
  }
  const { rows } = await tx.query("SELECT user_id FROM group_members WHERE group_id = $1", [
    groupId,
  ]);
  const before = new Set(rows.map((row) => readText(row, "user_id")));
  const after = new Set(doc.members);
  const added = doc.members.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id)).sort();
  for (const user of added) {
    await tx.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [
      groupId,
      user,
    ]);
  }
  if (removed.length > 0) {
    await tx.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])", [
      groupId,
      removed,
    ]);
  }
  for (const [action, users] of [
    ["group.member_added", added],
    ["group.member_removed", removed],
  ] as const) {
    for (const user of users) {
      await events.emit(
        tx,
        {
          action,
          actor,
          target: { type: "account", id: user },
          details: { group: { id: group.id, name: group.name } },
        },
        origin,
      );
    }
  }
  const closing = await settle(tx, changer, group, await mappedWorkspaces(tx, groupId), [
    ...added,
    ...removed,
  ]);
  return { groupId, closing };
}

/**
 * Removes a group, in the caller's transaction, with its members and its
 * mappings, then settles what it gave: each member keeps only its own
 * role, or what its other groups give, in each workspace it was mapped to.
 */
export async function deleteGroup(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupRow,
): Promise<Set<string>> {
  const { actor, origin, events } = changer;
  const workspaces = await mappedWorkspaces(tx, group.id);
  const { rows } = await tx.query("SELECT user_id FROM group_members WHERE group_id = $1", [
    group.id,
  ]);
  const members = rows.map((row) => readText(row, "user_id")).sort();
  // A custom role it gave goes with it, though the role may stay (ADR 0089).
  const gaveCustom = await givesCustomRole(tx, group.id, workspaces);
  await tx.query("DELETE FROM groups WHERE id = $1", [group.id]);
  await events.emit(
    tx,
    {
      action: "group.deleted",
      actor,
      target: { type: "group", id: group.id, name: group.name },
      details: { members: members.length, workspaces },
    },
    origin,
  );
  const closing = await settle(
    tx,
    changer,
    { id: group.id, name: group.name },
    workspaces,
    members,
  );
  if (gaveCustom) for (const user of members) closing.add(user);
  return closing;
}

/** A group locked for the rest of the transaction, so two changes to it take turns. */
export async function lockGroup(
  tx: Queryable,
  directory: string,
  id: string,
): Promise<GroupRow | undefined> {
  if (!uuid.test(id)) return undefined;
  const { rows } = await tx.query(
    `SELECT id, name, external_id, created_at, updated_at FROM groups
      WHERE directory_id = $1 AND id = $2 FOR UPDATE`,
    [directory, id.toLowerCase()],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    externalId: readTextOrNull(row, "external_id"),
    createdAt: readTime(row, "created_at"),
    updatedAt: readTime(row, "updated_at"),
  };
}

/**
 * Maps a group to a workspace at a role, or changes its role there, with
 * the workspace's custom role on it as its base, which the caller checked
 * (ADR 0089), and settles its members' places there.
 */
export async function setMapping(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupRow,
  workspace: string,
  role: Role,
  customRole: string | null = null,
): Promise<Set<string>> {
  const { actor, origin, events } = changer;
  const { rows } = await tx.query(
    `SELECT role, custom_role FROM group_workspaces
      WHERE group_id = $1 AND workspace_id = $2 FOR UPDATE`,
    [group.id, workspace],
  );
  const before = rows[0] === undefined ? null : readText(rows[0], "role");
  const customBefore = rows[0] === undefined ? null : readTextOrNull(rows[0], "custom_role");
  if (before === role && customBefore === customRole) return new Set();
  await tx.query(
    `INSERT INTO group_workspaces (group_id, workspace_id, role, custom_role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, workspace_id)
     DO UPDATE SET role = excluded.role, custom_role = excluded.custom_role`,
    [group.id, workspace, role, customRole],
  );
  const named = async (id: string | null) => {
    if (id === null) return null;
    const { rows: found } = await tx.query(
      "SELECT name FROM custom_roles WHERE workspace_id = $1 AND id = $2",
      [workspace, id],
    );
    return { id, name: readText(found[0], "name") };
  };
  await events.emit(
    tx,
    {
      action: "group.workspace_set",
      actor,
      workspace,
      target: { type: "group", id: group.id, name: group.name },
      details: {
        ...(before === null ? { role } : { from: before, role }),
        ...(customBefore === customRole
          ? {}
          : { customRole: { from: await named(customBefore), to: await named(customRole) } }),
      },
    },
    origin,
  );
  const members = await groupMembers(tx, group.id);
  const closing = await settle(tx, changer, group, [workspace], members);
  // What its members may do changed with the custom role, their role or not.
  if (customBefore !== customRole) for (const user of members) closing.add(user);
  return closing;
}

/** Removes a group's mapping to a workspace, and settles its members' places there. */
export async function removeMapping(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupRow,
  workspace: string,
): Promise<Set<string> | undefined> {
  const { actor, origin, events } = changer;
  const { rows } = await tx.query(
    `DELETE FROM group_workspaces WHERE group_id = $1 AND workspace_id = $2
     RETURNING role, custom_role`,
    [group.id, workspace],
  );
  if (rows[0] === undefined) return undefined;
  const gaveCustom = readTextOrNull(rows[0], "custom_role") !== null;
  await events.emit(
    tx,
    {
      action: "group.workspace_removed",
      actor,
      workspace,
      target: { type: "group", id: group.id, name: group.name },
      details: { role: readText(rows[0], "role") },
    },
    origin,
  );
  const members = await groupMembers(tx, group.id);
  const closing = await settle(tx, changer, group, [workspace], members);
  // The custom role it gave goes, their role or not.
  if (gaveCustom) for (const user of members) closing.add(user);
  return closing;
}

async function groupMembers(tx: Queryable, group: string): Promise<string[]> {
  const { rows } = await tx.query(
    "SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY user_id",
    [group],
  );
  return rows.map((row) => readText(row, "user_id"));
}
