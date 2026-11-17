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

/** Settles each of the accounts' places in each workspace, and gives those whose place changed. */
function settle(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupName,
  workspaces: readonly string[],
  users: Iterable<string>,
): Promise<Set<string>> {
  const places: { workspace: string; user: string }[] = [];
  for (const user of users) {
    for (const workspace of workspaces) places.push({ workspace, user });
  }
  return settleMemberships(
    tx,
    places,
    { actor: changer.actor, origin: changer.origin, group },
    changer.events,
  );
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
  return settle(tx, changer, { id: group.id, name: group.name }, workspaces, members);
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
 * Maps a group to a workspace at a role, or changes its role there, and
 * settles its members' places there.
 */
export async function setMapping(
  tx: Queryable,
  changer: GroupChanger,
  group: GroupRow,
  workspace: string,
  role: Role,
): Promise<Set<string>> {
  const { actor, origin, events } = changer;
  const { rows } = await tx.query(
    "SELECT role FROM group_workspaces WHERE group_id = $1 AND workspace_id = $2 FOR UPDATE",
    [group.id, workspace],
  );
  const before = rows[0] === undefined ? null : readText(rows[0], "role");
  if (before === role) return new Set();
  await tx.query(
    `INSERT INTO group_workspaces (group_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, workspace_id) DO UPDATE SET role = excluded.role`,
    [group.id, workspace, role],
  );
  await events.emit(
    tx,
    {
      action: "group.workspace_set",
      actor,
      workspace,
      target: { type: "group", id: group.id, name: group.name },
      details: before === null ? { role } : { from: before, role },
    },
    origin,
  );
  return settle(tx, changer, group, [workspace], await groupMembers(tx, group.id));
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
    "DELETE FROM group_workspaces WHERE group_id = $1 AND workspace_id = $2 RETURNING role",
    [group.id, workspace],
  );
  if (rows[0] === undefined) return undefined;
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
  return settle(tx, changer, group, [workspace], await groupMembers(tx, group.id));
}

/** A workspace and an account whose membership there is to be settled. */
export interface Place {
  readonly workspace: string;
  readonly user: string;
}

/**
 * Puts an account in exactly these of its directory's groups, in the
 * caller's transaction, as an LDAP run reads them, telling of each it
 * joins and leaves. Gives how many, and the places to settle: each
 * workspace a group it joined or left is mapped to. The caller settles
 * them, a batch at once, in the order `settleMemberships` keeps.
 */
export async function setAccountGroups(
  tx: Queryable,
  changer: GroupChanger,
  user: string,
  groups: ReadonlyMap<string, string>,
): Promise<{ readonly added: number; readonly removed: number; readonly places: Place[] }> {
  const { directory, actor, origin, events } = changer;
  const { rows } = await tx.query(
    `SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE g.directory_id = $1 AND gm.user_id = $2`,
    [directory, user],
  );
  const before = new Map(rows.map((row) => [readText(row, "id"), readText(row, "name")]));
  const added = [...groups.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !groups.has(id)).sort();
  for (const group of added) {
    await tx.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [group, user]);
  }
  if (removed.length > 0) {
    await tx.query("DELETE FROM group_members WHERE user_id = $1 AND group_id = ANY($2::uuid[])", [
      user,
      removed,
    ]);
  }
  for (const [action, ids, names] of [
    ["group.member_added", added, groups],
    ["group.member_removed", removed, before],
  ] as const) {
    for (const id of ids) {
      await events.emit(
        tx,
        {
          action,
          actor,
          target: { type: "account", id: user },
          details: { group: { id, name: names.get(id) ?? "" } },
        },
        origin,
      );
    }
  }
  const changed = [...added, ...removed];
  if (changed.length === 0) return { added: 0, removed: 0, places: [] };
  const mapped = await tx.query(
    "SELECT DISTINCT workspace_id FROM group_workspaces WHERE group_id = ANY($1::uuid[])",
    [changed],
  );
  return {
    added: added.length,
    removed: removed.length,
    places: mapped.rows.map((row) => ({ workspace: readText(row, "workspace_id"), user })),
  };
}

async function groupMembers(tx: Queryable, group: string): Promise<string[]> {
  const { rows } = await tx.query(
    "SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY user_id",
    [group],
  );
  return rows.map((row) => readText(row, "user_id"));
}
