// A SCIM directory's users (ADR 0085): each an account the directory
// manages. A new one has no password, its address from the directory's
// emails, and its name from what the directory calls it. An account that
// already has the address is taken over when the address is at one of the
// directory's domains and no other directory manages it; otherwise the
// request is a duplicate. `active` deactivates and reactivates it, and a
// removal deactivates it, then takes it out of every workspace and lets
// it go, unless a workspace it is in is on legal hold (ADR 0088).
import { randomUUID } from "node:crypto";
import {
  type AccountChanger,
  deactivateAccount,
  reactivateAccount,
} from "@nether/server/src/accounts.ts";
import type { DataPolicies } from "@nether/server/src/dataPolicies.ts";
import {
  type Queryable,
  readBoolean,
  readText,
  readTextOrNull,
  readTime,
} from "@nether/server/src/db.ts";
import type { ServerEvents } from "@nether/server/src/events.ts";
import { emailKey } from "@nether/server/src/http.ts";
import { deleteMembership } from "@nether/server/src/members.ts";
import { type Directory, addressDomain } from "./directories.ts";
import { ScimError } from "./errors.ts";
import { type Comparison, coreUserSchema } from "./paths.ts";
import { type EmailDoc, type NameDoc, type UserDoc, emailsOf, nameOf } from "./userDoc.ts";

/** A user as the directory's row and its account have it. */
export interface UserRow {
  readonly userId: string;
  readonly userName: string;
  readonly externalId: string | null;
  readonly displayName: string | null;
  readonly name: NameDoc;
  readonly emails: readonly EmailDoc[];
  readonly deactivated: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a request that changes users acts as, for the events it tells of. */
export interface UserContext {
  readonly directory: Directory;
  readonly events: ServerEvents;
  readonly by: AccountChanger;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const addressPattern = /^[^\s@]+@[^\s@]+$/;

/** Longest name an account keeps, as the server's routes take. */
const nameLimit = 200;

const userColumns = `a.user_id, a.user_name, a.external_id, a.attributes, a.created_at,
  a.updated_at, u.deactivated_at IS NOT NULL AS deactivated`;

function rowOf(row: Record<string, unknown>): UserRow {
  const attributes =
    typeof row.attributes === "object" && row.attributes !== null
      ? (row.attributes as Record<string, unknown>)
      : {};
  const displayName = attributes.displayName;
  return {
    userId: readText(row, "user_id"),
    userName: readText(row, "user_name"),
    externalId: readTextOrNull(row, "external_id"),
    displayName: typeof displayName === "string" ? displayName : null,
    name: nameOf(attributes.name),
    emails: emailsOf(attributes.emails),
    deactivated: readBoolean(row, "deactivated"),
    createdAt: readTime(row, "created_at"),
    updatedAt: readTime(row, "updated_at"),
  };
}

/** One of a directory's users, locked until the transaction ends when `lock` says so. */
export async function findUser(
  db: Queryable,
  directory: string,
  id: string,
  lock = false,
): Promise<UserRow | undefined> {
  if (!uuid.test(id)) return undefined;
  const { rows } = await db.query(
    `SELECT ${userColumns} FROM directory_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.directory_id = $1 AND a.user_id = $2${lock ? " FOR UPDATE OF a, u" : ""}`,
    [directory, id.toLowerCase()],
  );
  return rows[0] === undefined ? undefined : rowOf(rows[0]);
}

/** A user's kept attributes, as a PATCH applies to them. */
export function docOf(row: UserRow): UserDoc {
  return {
    userName: row.userName,
    externalId: row.externalId,
    displayName: row.displayName,
    name: row.name,
    emails: row.emails,
    active: !row.deactivated,
  };
}

/** A group a user is in, as its `groups` attribute names it. */
export interface GroupRef {
  readonly value: string;
  readonly display: string;
}

/** The directory's groups each user is in, read only. */
export async function groupsOf(
  db: Queryable,
  directory: string,
  users: readonly string[],
): Promise<Map<string, GroupRef[]>> {
  const found = new Map<string, GroupRef[]>();
  if (users.length === 0) return found;
  const { rows } = await db.query(
    `SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE g.directory_id = $1 AND gm.user_id = ANY($2::uuid[])
      ORDER BY lower(g.name), g.id`,
    [directory, users],
  );
  for (const row of rows) {
    const user = readText(row, "user_id");
    const list = found.get(user) ?? [];
    list.push({ value: readText(row, "id"), display: readText(row, "name") });
    found.set(user, list);
  }
  return found;
}

/** A user as SCIM gives it back: what the directory sent, as it sent it. */
export function resourceOf(
  row: UserRow,
  groups: readonly GroupRef[],
  base: string | null,
): Record<string, unknown> {
  return {
    schemas: [coreUserSchema],
    id: row.userId,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    userName: row.userName,
    ...(Object.keys(row.name).length === 0 ? {} : { name: row.name }),
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.emails.length === 0 ? {} : { emails: row.emails }),
    active: !row.deactivated,
    groups: groups.map((group) => ({
      value: group.value,
      display: group.display,
      ...(base === null ? {} : { $ref: `${base}/Groups/${group.value}` }),
    })),
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      ...(base === null ? {} : { location: `${base}/Users/${row.userId}` }),
    },
  };
}

const filterable =
  'Nether filters users by id, userName, externalId, emails.value, emails[type eq "work"].value and active.';

function badFilter(detail = filterable): ScimError {
  return new ScimError(400, detail, "invalidFilter");
}

/** A filter's comparisons as SQL over `a`, the directory's row, and `u`, its account. */
export function userFilter(comparisons: readonly Comparison[], params: unknown[]): string {
  const parts: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${String(params.length)}`;
  };
  for (const { path, value } of comparisons) {
    if (path.schema === "enterprise" || path.schema === "other") throw badFilter();
    const plain = path.filter === undefined && path.sub === undefined;
    if (path.attr === "id" && plain) {
      if (typeof value !== "string") throw badFilter("An id is compared with text.");
      parts.push(`a.user_id::text = lower(${add(value)})`);
    } else if (path.attr === "username" && plain) {
      if (typeof value !== "string") throw badFilter("A userName is compared with text.");
      parts.push(`lower(a.user_name) = lower(${add(value)})`);
    } else if (path.attr === "externalid" && plain) {
      if (value === null) parts.push("a.external_id IS NULL");
      else if (typeof value === "string") parts.push(`a.external_id = ${add(value)}`);
      else throw badFilter("An externalId is compared with text.");
    } else if (path.attr === "active" && plain) {
      if (typeof value !== "boolean") throw badFilter("active is compared with true or false.");
      parts.push(`(u.deactivated_at IS NULL) = ${add(value)}`);
    } else if (path.attr === "emails" && path.sub === "value") {
      if (typeof value !== "string") throw badFilter("An address is compared with text.");
      const typed = (path.filter ?? []).map(({ path: inner, value: type }) => {
        if (inner.attr !== "type" || inner.sub !== undefined || typeof type !== "string") {
          throw badFilter();
        }
        return `lower(e->>'type') = lower(${add(type)})`;
      });
      parts.push(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.attributes->'emails') = 'array'
                        THEN a.attributes->'emails' ELSE '[]'::jsonb END) e
                  WHERE lower(e->>'value') = lower(${add(value)})
                    ${typed.map((each) => `AND ${each}`).join(" ")})`,
      );
    } else {
      throw badFilter();
    }
  }
  return parts.length === 0 ? "true" : parts.join(" AND ");
}

/** A page of a directory's users, in the order the directory made or took them. */
export async function listUsers(
  db: Queryable,
  directory: string,
  comparisons: readonly Comparison[],
  startIndex: number,
  count: number,
): Promise<{ readonly total: number; readonly rows: UserRow[] }> {
  const params: unknown[] = [directory];
  const where = userFilter(comparisons, params);
  const from = `FROM directory_accounts a JOIN users u ON u.id = a.user_id
                WHERE a.directory_id = $1 AND ${where}`;
  const counted = await db.query(`SELECT count(*)::int AS total ${from}`, params);
  const total = Number(counted.rows[0]?.total ?? 0);
  if (count === 0) return { total, rows: [] };
  const { rows } = await db.query(
    `SELECT ${userColumns} ${from}
      ORDER BY a.created_at, a.user_id
      OFFSET ${String(startIndex - 1)} LIMIT ${String(count)}`,
    params,
  );
  return { total, rows: rows.map(rowOf) };
}

/** The account's address: the primary of its emails, else the one typed work, else the first, else userName when it is one. */
export function addressOf(doc: UserDoc): string {
  const sent = doc.emails.filter((email) => (email.value ?? "").trim() !== "");
  const chosen =
    sent.find((email) => email.primary === true) ??
    sent.find((email) => email.type?.toLowerCase() === "work") ??
    sent[0];
  const address = (chosen?.value ?? doc.userName).trim();
  if (!addressPattern.test(address) || address.length > 320) {
    throw new ScimError(
      400,
      "Give the user an email address, in emails or as a userName that is one.",
      "invalidValue",
    );
  }
  return address;
}

/** The account's name: displayName, else name.formatted, else its given and family names, else the address before its @. */
export function accountName(doc: UserDoc, address: string): string {
  const joined = [doc.name.givenName, doc.name.familyName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ");
  const name =
    [doc.displayName?.trim(), doc.name.formatted?.trim(), joined].find(
      (each) => each !== undefined && each !== "",
    ) ?? address.slice(0, address.lastIndexOf("@"));
  return name.slice(0, nameLimit);
}

function attributesOf(doc: UserDoc): string {
  return JSON.stringify({ name: doc.name, displayName: doc.displayName, emails: doc.emails });
}

/** What writing a user did: its account, whether it was made, and whether its connections close. */
export interface Written {
  readonly userId: string;
  readonly created: boolean;
  readonly disconnect: boolean;
}

/**
 * Writes a user in the caller's transaction: makes or takes over its
 * account when `existing` is undefined, else changes it, with its name,
 * address and whether it is active, telling of each change.
 */
export async function writeUser(
  tx: Queryable,
  context: UserContext,
  existing: UserRow | undefined,
  doc: UserDoc,
): Promise<Written> {
  const { directory, events, by } = context;
  const address = addressOf(doc);
  const name = accountName(doc, address);
  const ours = directory.domains.includes(addressDomain(address));
  const named = await tx.query(
    "SELECT user_id FROM directory_accounts WHERE directory_id = $1 AND lower(user_name) = lower($2)",
    [directory.id, doc.userName],
  );
  const namedId = named.rows[0] === undefined ? undefined : readText(named.rows[0], "user_id");
  if (namedId !== undefined && namedId !== existing?.userId) {
    throw new ScimError(
      409,
      `This directory has a user named ${doc.userName} already.`,
      "uniqueness",
    );
  }
  const held = await tx.query(
    `SELECT u.id, u.name, u.email, a.directory_id FROM users u
       LEFT JOIN directory_accounts a ON a.user_id = u.id
      WHERE u.email_key = $1 FOR UPDATE OF u`,
    [emailKey(address)],
  );
  const holder = held.rows[0];
  const holderId = holder === undefined ? undefined : readText(holder, "id");
  // The account: the one written, the one taken over, or a new one.
  const userId = existing?.userId ?? holderId ?? randomUUID();
  let created = false;
  const tell = (
    action: "account.created" | "directory.account_linked",
    details: Record<string, string>,
  ) =>
    events.emit(
      tx,
      { action, actor: by.actor, target: { type: "account", id: userId, name }, details },
      by.origin,
    );

  if (existing !== undefined) {
    if (holderId !== undefined && holderId !== userId) {
      throw new ScimError(409, `Another account has the address ${address}.`, "uniqueness");
    }
    const { rows } = await tx.query("SELECT name, email FROM users WHERE id = $1 FOR UPDATE", [
      userId,
    ]);
    const before = { name: readText(rows[0], "name"), email: readText(rows[0], "email") };
    const moved = emailKey(before.email) !== emailKey(address);
    if (moved && !ours && !directory.otherDomains) {
      throw outside(address, directory);
    }
    if (before.name !== name || before.email !== address) {
      await tx.query("UPDATE users SET name = $2, email = $3, email_key = $4 WHERE id = $1", [
        userId,
        name,
        address,
        emailKey(address),
      ]);
      await events.emit(
        tx,
        {
          action: "account.changed",
          actor: by.actor,
          target: { type: "account", id: userId, name },
          details: { from: before, to: { name, email: address } },
        },
        by.origin,
      );
    }
    await tx.query(
      `UPDATE directory_accounts SET user_name = $2, external_id = $3, attributes = $4::jsonb,
              updated_at = now()
        WHERE user_id = $1`,
      [userId, doc.userName, doc.externalId, attributesOf(doc)],
    );
  } else if (holder !== undefined && holderId !== undefined) {
    const manager = readTextOrNull(holder, "directory_id");
    if (manager !== null) {
      throw new ScimError(
        409,
        manager === directory.id
          ? `This directory has a user with the address ${address} already.`
          : `Another directory manages the account with the address ${address}.`,
        "uniqueness",
      );
    }
    // Taken over only at the directory's own domains, so one organization's
    // directory never takes another's people.
    if (!ours) {
      throw new ScimError(
        409,
        `An account has the address ${address} already, at a domain this directory does not speak for.`,
        "uniqueness",
      );
    }
    await tx.query(
      `INSERT INTO directory_accounts (user_id, directory_id, user_name, external_id, attributes)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, directory.id, doc.userName, doc.externalId, attributesOf(doc)],
    );
    await tell("directory.account_linked", { userName: doc.userName });
    const before = { name: readText(holder, "name"), email: readText(holder, "email") };
    if (before.name !== name || before.email !== address) {
      await tx.query("UPDATE users SET name = $2, email = $3 WHERE id = $1", [
        userId,
        name,
        address,
      ]);
      await events.emit(
        tx,
        {
          action: "account.changed",
          actor: by.actor,
          target: { type: "account", id: userId, name },
          details: { from: before, to: { name, email: address } },
        },
        by.origin,
      );
    }
  } else {
    if (!ours && !directory.otherDomains) throw outside(address, directory);
    created = true;
    await tx.query("INSERT INTO users (id, email, email_key, name) VALUES ($1, $2, $3, $4)", [
      userId,
      address,
      emailKey(address),
      name,
    ]);
    await tell("account.created", { by: "scim", directory: directory.id });
    await tx.query(
      `INSERT INTO directory_accounts (user_id, directory_id, user_name, external_id, attributes)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, directory.id, doc.userName, doc.externalId, attributesOf(doc)],
    );
  }

  const outcome = doc.active
    ? await reactivateAccount(tx, userId, by, events)
    : await deactivateAccount(tx, userId, by, events);
  if (typeof outcome !== "string") throw new ScimError(outcome[0], outcome[1]);
  return { userId, created, disconnect: !doc.active && outcome === "changed" };
}

function outside(address: string, directory: Directory): ScimError {
  const domains = directory.domains.length === 0 ? "none yet" : directory.domains.join(", ");
  return new ScimError(
    400,
    `${address} is not at one of this directory's domains: ${domains}. Add its domain on the console's Directories page.`,
    "invalidValue",
  );
}

export const heldMessage =
  "This account is in a workspace under legal hold: it stays deactivated until the hold ends.";

/**
 * A directory's removal of a user, in the caller's transaction: the
 * account is deactivated, then, unless a workspace it is in is on legal
 * hold, as the transaction reads the data policies now, it leaves every workspace, as an owner's removal does, with its
 * keys, grants, sites and webhooks there, and its groups; its identities
 * at providers go; and the directory lets it go. The account itself stays,
 * deactivated, as a record. `held` says the hold kept it.
 */
export async function removeUser(
  tx: Queryable,
  context: UserContext,
  row: UserRow,
  policies: DataPolicies,
): Promise<{ readonly held: boolean; readonly disconnect: boolean }> {
  const { directory, events, by } = context;
  const userId = row.userId;
  const outcome = await deactivateAccount(tx, userId, by, events);
  if (typeof outcome !== "string") throw new ScimError(outcome[0], outcome[1]);
  const disconnect = outcome === "changed";
  const { rows: places } = await tx.query(
    "SELECT workspace_id, role FROM memberships WHERE user_id = $1 ORDER BY workspace_id",
    [userId],
  );
  // Read in this transaction, not from what is kept: a hold set a moment
  // ago stops the removal.
  const held = await policies.heldIn(
    tx,
    places.map((place) => readText(place, "workspace_id")),
  );
  if (held.size > 0) return { held: true, disconnect };
  for (const place of places) {
    const workspace = readText(place, "workspace_id");
    await deleteMembership(tx, workspace, userId);
    await events.emit(
      tx,
      {
        action: "member.removed",
        actor: by.actor,
        workspace,
        target: { type: "account", id: userId },
        details: { role: readText(place, "role"), via: "scim" },
      },
      by.origin,
    );
  }
  const { rows: groups } = await tx.query(
    `DELETE FROM group_members gm USING groups g
      WHERE gm.group_id = g.id AND gm.user_id = $1
      RETURNING g.id, g.name`,
    [userId],
  );
  for (const group of groups) {
    await events.emit(
      tx,
      {
        action: "group.member_removed",
        actor: by.actor,
        target: { type: "account", id: userId },
        details: { group: { id: readText(group, "id"), name: readText(group, "name") } },
      },
      by.origin,
    );
  }
  // No provider's earlier link reaches it again.
  await tx.query("DELETE FROM identities WHERE user_id = $1", [userId]);
  await tx.query("DELETE FROM directory_accounts WHERE user_id = $1 AND directory_id = $2", [
    userId,
    directory.id,
  ]);
  await events.emit(
    tx,
    {
      action: "directory.account_unlinked",
      actor: by.actor,
      target: { type: "account", id: userId },
      details: { userName: row.userName },
    },
    by.origin,
  );
  return { held: false, disconnect: true };
}
