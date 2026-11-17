// How long the audit log keeps its events, and its hourly upkeep (ADR 0081).
// The log keeps its events 365 days unless an instance admin changes it,
// from 30 days to ten years, or NETHER_AUDIT_RETENTION_DAYS pins it: its own
// setting, apart from data policies. The purge never takes the newest row,
// so the chain always has a head, and it records itself, with the hash of
// the last row it took, which the oldest row kept links to. A checkpoint
// each hour writes the chain's head to the log and to the server's log, so
// rows cut off the end show against either.
import { type Database, type Queryable, readCount, readText } from "@nether/server/src/db.ts";
import type { ChainKey } from "./chain.ts";
import { record } from "./log.ts";

export const defaultRetentionDays = 365;
export const minRetentionDays = 30;
export const maxRetentionDays = 3650;

/** Where the console's choice of days is kept. */
export const retentionSetting = "audit.retention_days";

/** The lock one node takes to purge, by a number of Nether's own. */
const purgeLock = 7_446_872_182;

/** The environment's pin of the days, if it sets one; a value out of range stops the server. */
export function pinnedRetention(value: string | undefined): number | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  const days = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(days) || days < minRetentionDays || days > maxRetentionDays) {
    throw new Error(
      `NETHER_AUDIT_RETENTION_DAYS must be a whole number of days from ${String(minRetentionDays)} to ${String(maxRetentionDays)}, not "${text}".`,
    );
  }
  return days;
}

/** The days the log keeps its events: the pin, the console's choice, or the default. */
export async function retentionDays(db: Queryable, pinned: number | undefined): Promise<number> {
  if (pinned !== undefined) return pinned;
  const { rows } = await db.query("SELECT value FROM instance_settings WHERE key = $1", [
    retentionSetting,
  ]);
  const value = rows[0]?.value;
  return typeof value === "number" ? value : defaultRetentionDays;
}

/** Keeps the console's choice of days. */
export async function setRetentionDays(db: Queryable, days: number): Promise<void> {
  await db.query(
    `INSERT INTO instance_settings (key, value) VALUES ($1, to_jsonb($2::integer))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [retentionSetting, days],
  );
}

/**
 * Purges the events older than the log keeps, but never the newest, and
 * records the purge; gives how many went. One node at a time does it.
 */
export async function purge(db: Database, days: number, key: ChainKey): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows: locked } = await tx.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [
      purgeLock,
    ]);
    if (locked[0]?.locked !== true) return 0;
    const { rows } = await tx.query(
      `SELECT seq, hash FROM audit_events
        WHERE seq = (SELECT max(seq) FROM audit_events
                      WHERE at < now() - make_interval(days => $1)
                        AND seq < (SELECT max(seq) FROM audit_events))`,
      [days],
    );
    const through = rows[0];
    if (through === undefined) return 0;
    const seq = readCount(through, "seq");
    // The trigger lets this transaction delete up to here, and no further.
    await tx.query("SELECT set_config('nether.audit_purge_through', $1, true)", [String(seq)]);
    const { rows: gone } = await tx.query(
      "DELETE FROM audit_events WHERE seq <= $1 RETURNING seq",
      [seq],
    );
    await record(
      tx,
      {
        action: "audit.purged",
        actor: { kind: "system" },
        details: {
          count: gone.length,
          throughSeq: seq,
          throughHash: readText(through, "hash"),
          retentionDays: days,
        },
        origin: { address: null, userAgent: null },
      },
      key,
    );
    return gone.length;
  });
}

/** Records the chain's head as it is now; gives it, for the server's log. */
export async function checkpoint(
  db: Database,
  key: ChainKey,
): Promise<{ readonly seq: number; readonly hash: string } | undefined> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1");
    const head = rows[0];
    if (head === undefined) return undefined;
    const reached = { seq: readCount(head, "seq"), hash: readText(head, "hash") };
    await record(
      tx,
      {
        action: "audit.checkpoint",
        actor: { kind: "system" },
        details: reached,
        origin: { address: null, userAgent: null },
      },
      key,
    );
    return reached;
  });
}
