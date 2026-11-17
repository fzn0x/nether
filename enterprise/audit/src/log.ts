// The audit log's rows (ADR 0081): what each event recorded, written one at
// a time under a lock so each takes the next place in the chain, whichever
// node writes. Names are read as they are when the event happens and kept
// so: the log still reads after an account or a workspace is renamed. No
// contents ever, only IDs and names.
import { randomUUID } from "node:crypto";
import {
  type Queryable,
  type Row,
  readCount,
  readText,
  readTextOrNull,
  readTime,
} from "@nether/server/src/db.ts";
import type { EventActor, EventOrigin, EventTarget } from "@nether/server/src/events.ts";
import { type ChainKey, keyFingerprint, rowHash } from "./chain.ts";

/** The lock that makes one writer at a time, by a number of Nether's own. */
const chainLock = 7_446_872_181;

/** The most a row's details hold, as JSON; more is left out, and the row says so. */
const detailsLimit = 4096;

/** Where the fingerprint of the key the chain was last made under is kept. */
export const keySetting = "audit.key";

/** A row of the log, as the table holds it and its hash covers it. */
export interface AuditRow {
  readonly seq: number;
  readonly id: string;
  /** When it happened, to the millisecond, in UTC. */
  readonly at: string;
  readonly action: string;
  readonly outcome: "success" | "failure";
  readonly reason: string | null;
  readonly actorType: EventActor["kind"];
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly actorEmail: string | null;
  readonly tokenId: string | null;
  readonly tokenName: string | null;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly targetName: string | null;
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

/** A row's fields its hash covers, in their fixed order: all but the hashes. */
export function fieldsOf(row: Omit<AuditRow, "prevHash" | "hash">): readonly unknown[] {
  return [
    row.seq,
    row.id,
    row.at,
    row.action,
    row.outcome,
    row.reason,
    row.actorType,
    row.actorId,
    row.actorName,
    row.actorEmail,
    row.tokenId,
    row.tokenName,
    row.workspaceId,
    row.workspaceName,
    row.targetType,
    row.targetId,
    row.targetName,
    row.address,
    row.userAgent,
    row.details,
  ];
}

/** A row as the table gave it. */
export function rowOf(row: Row): AuditRow {
  const outcome = readText(row, "outcome");
  const actor = readText(row, "actor_type");
  return {
    seq: readCount(row, "seq"),
    id: readText(row, "id"),
    at: readTime(row, "at").toISOString(),
    action: readText(row, "action"),
    outcome: outcome === "failure" ? "failure" : "success",
    reason: readTextOrNull(row, "reason"),
    actorType:
      actor === "visitor" || actor === "anonymous" || actor === "directory" || actor === "system"
        ? actor
        : "account",
    actorId: readTextOrNull(row, "actor_id"),
    actorName: readTextOrNull(row, "actor_name"),
    actorEmail: readTextOrNull(row, "actor_email"),
    tokenId: readTextOrNull(row, "token_id"),
    tokenName: readTextOrNull(row, "token_name"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    workspaceName: readTextOrNull(row, "workspace_name"),
    targetType: readTextOrNull(row, "target_type"),
    targetId: readTextOrNull(row, "target_id"),
    targetName: readTextOrNull(row, "target_name"),
    address: readTextOrNull(row, "address"),
    userAgent: readTextOrNull(row, "user_agent"),
    details:
      typeof row.details === "object" && row.details !== null
        ? (row.details as Record<string, unknown>)
        : {},
    prevHash: readText(row, "prev_hash"),
    hash: readText(row, "hash"),
  };
}

/** What an event asks the log to keep. */
export interface Entry {
  readonly action: string;
  readonly outcome?: "success" | "failure" | undefined;
  readonly reason?: string | undefined;
  readonly actor: EventActor;
  readonly workspace?: string | null | undefined;
  readonly target?: EventTarget | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly origin: EventOrigin;
}

/** One row's text, if a query finds it. */
async function textOf(tx: Queryable, sql: string, params: readonly unknown[], column: string) {
  const { rows } = await tx.query(sql, params);
  return rows[0] === undefined ? null : readTextOrNull(rows[0], column);
}

/** A target's name as the server can read it, when the event gave none. */
async function targetName(tx: Queryable, target: EventTarget, workspace: string | null) {
  if (target.name !== undefined && target.name !== null) return target.name;
  if (target.type === "account") {
    return textOf(tx, "SELECT name FROM users WHERE id::text = $1", [target.id], "name");
  }
  if (target.type === "note" && workspace !== null) {
    // Its title, where the server can read it: an encrypted workspace's notes have none here.
    return textOf(
      tx,
      "SELECT title FROM note_search WHERE workspace_id::text = $1 AND note = $2 AND path <> ''",
      [workspace, target.id],
      "title",
    );
  }
  return null;
}

/** Details as kept: as given, unless larger than a row holds. */
function keptDetails(details: Readonly<Record<string, unknown>> | undefined) {
  const given = details ?? {};
  return JSON.stringify(given).length > detailsLimit ? { omitted: "larger than 4 KB" } : given;
}

/**
 * Records an event as the next row of the chain, in `tx`, the transaction
 * of the change it tells of. When the key the chain is made under is not
 * the one it was last made under, the first row says so (ADR 0081).
 */
export async function record(tx: Queryable, entry: Entry, key: ChainKey): Promise<AuditRow> {
  await tx.query("SELECT pg_advisory_xact_lock($1)", [chainLock]);
  const fingerprint = keyFingerprint(key);
  const { rows: kept } = await tx.query("SELECT value FROM instance_settings WHERE key = $1", [
    keySetting,
  ]);
  const before = kept[0]?.value;
  if (before !== fingerprint) {
    await tx.query(
      `INSERT INTO instance_settings (key, value) VALUES ($1, to_jsonb($2::text))
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [keySetting, fingerprint],
    );
    // A log that has rows under another key starts a new segment here.
    if (typeof before === "string") {
      await append(
        tx,
        {
          action: "audit.key_changed",
          actor: { kind: "system" },
          details: { from: before, to: fingerprint, keyed: key !== null },
          origin: { address: null, userAgent: null },
        },
        key,
      );
    }
  }
  return append(tx, entry, key);
}

/** Appends a row after the last, under the lock `record` holds. */
async function append(tx: Queryable, entry: Entry, key: ChainKey): Promise<AuditRow> {
  const { rows: last } = await tx.query(
    "SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1",
  );
  const head = last[0];
  const seq = head === undefined ? 1 : readCount(head, "seq") + 1;
  const previous = head === undefined ? "" : readText(head, "hash");
  const { actor } = entry;
  const account =
    actor.kind === "account"
      ? (await tx.query("SELECT name, email FROM users WHERE id::text = $1", [actor.id])).rows[0]
      : undefined;
  const workspace = entry.workspace ?? null;
  const workspaceName =
    workspace === null
      ? null
      : await textOf(tx, "SELECT name FROM workspaces WHERE id::text = $1", [workspace], "name");
  const target = entry.target;
  const fields: Omit<AuditRow, "prevHash" | "hash"> = {
    seq,
    id: randomUUID(),
    at: new Date().toISOString(),
    action: entry.action,
    outcome: entry.outcome ?? "success",
    reason: entry.reason ?? null,
    actorType: actor.kind,
    actorId:
      actor.kind === "account" || actor.kind === "directory"
        ? actor.id
        : actor.kind === "visitor"
          ? actor.link
          : null,
    actorName:
      actor.kind === "account"
        ? readTextOrNull(account, "name")
        : actor.kind === "visitor" || actor.kind === "directory"
          ? actor.name
          : null,
    actorEmail:
      actor.kind === "account"
        ? readTextOrNull(account, "email")
        : actor.kind === "anonymous"
          ? (actor.email ?? null)
          : null,
    tokenId: actor.kind === "account" ? (actor.token?.id ?? null) : null,
    tokenName: actor.kind === "account" ? (actor.token?.name ?? null) : null,
    workspaceId: workspace,
    workspaceName,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    targetName: target === undefined ? null : await targetName(tx, target, workspace),
    address: entry.origin.address,
    userAgent: entry.origin.userAgent,
    details: keptDetails(entry.details),
  };
  const hash = rowHash(key, previous, fieldsOf(fields));
  await tx.query(
    `INSERT INTO audit_events
       (seq, id, at, action, outcome, reason, actor_type, actor_id, actor_name, actor_email,
        token_id, token_name, workspace_id, workspace_name, target_type, target_id, target_name,
        address, user_agent, details, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22)`,
    [
      fields.seq,
      fields.id,
      fields.at,
      fields.action,
      fields.outcome,
      fields.reason,
      fields.actorType,
      fields.actorId,
      fields.actorName,
      fields.actorEmail,
      fields.tokenId,
      fields.tokenName,
      fields.workspaceId,
      fields.workspaceName,
      fields.targetType,
      fields.targetId,
      fields.targetName,
      fields.address,
      fields.userAgent,
      JSON.stringify(fields.details),
      previous,
      hash,
    ],
  );
  return { ...fields, prevHash: previous, hash };
}
