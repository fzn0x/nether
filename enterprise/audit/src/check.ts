// Checking the audit log's chain (ADR 0081): from the oldest row kept, each
// row's place one after the last, its link the last row's hash, and its
// hash as computed again. Rows before the last change of key are checked
// by their links alone, as the key they were made under is gone. The
// newest rows cut off leave a chain that checks: the hourly checkpoints,
// kept elsewhere, show those.
import { type Queryable, readCount } from "@nether/server/src/db.ts";
import { type ChainKey, rowHash } from "./chain.ts";
import { fieldsOf, rowOf } from "./log.ts";

/** What a check found. */
export interface CheckResult {
  /** How many rows it read. */
  readonly checked: number;
  /** The first and last rows' places; null for an empty log. */
  readonly from: number | null;
  readonly to: number | null;
  /** Where its hashes were computed again from: the last change of key. */
  readonly hashesFrom: number | null;
  /** Whether the chain is made under a key from NETHER_SECRET_KEY. */
  readonly keyed: boolean;
  /** The first row that does not hold, and why; null when every row holds. */
  readonly broken: { readonly seq: number; readonly problem: string } | null;
}

const pageSize = 1000;

/** Where the chain is checked by its hashes from: the last change of key, or the start. */
async function lastKeyChange(db: Queryable): Promise<number | null> {
  const { rows } = await db.query(
    "SELECT max(seq) AS seq FROM audit_events WHERE action = 'audit.key_changed'",
  );
  return rows[0]?.seq === null || rows[0] === undefined ? null : readCount(rows[0], "seq");
}

/** The hash the oldest row kept links to: the last purge's, or none at the start. */
async function anchorOf(db: Queryable, oldest: number): Promise<string | undefined> {
  if (oldest === 1) return "";
  const { rows } = await db.query(
    `SELECT details FROM audit_events
      WHERE action = 'audit.purged' AND (details->>'throughSeq')::bigint = $1
      ORDER BY seq DESC LIMIT 1`,
    [oldest - 1],
  );
  const details = rows[0]?.details as { throughHash?: unknown } | undefined;
  return typeof details?.throughHash === "string" ? details.throughHash : undefined;
}

/** Checks the chain from the oldest row kept to the newest. */
export async function checkLog(db: Queryable, key: ChainKey): Promise<CheckResult> {
  const keyedFrom = await lastKeyChange(db);
  let checked = 0;
  let from: number | null = null;
  let last: { seq: number; hash: string } | undefined;
  for (;;) {
    const { rows } = await db.query(
      "SELECT * FROM audit_events WHERE seq > $1 ORDER BY seq LIMIT $2",
      [last?.seq ?? 0, pageSize],
    );
    if (rows.length === 0) break;
    for (const raw of rows) {
      const row = rowOf(raw);
      const broken = (problem: string): CheckResult => ({
        checked,
        from,
        to: row.seq,
        hashesFrom: keyedFrom ?? from,
        keyed: key !== null,
        broken: { seq: row.seq, problem },
      });
      if (last === undefined) {
        from = row.seq;
        const anchor = await anchorOf(db, row.seq);
        if (anchor === undefined) return broken("rows before it went without a purge saying so");
        if (row.prevHash !== anchor) return broken("it does not link to the rows purged before it");
      } else {
        if (row.seq !== last.seq + 1) return broken("a row before it is missing");
        if (row.prevHash !== last.hash) return broken("it does not link to the row before it");
      }
      const hashed = keyedFrom === null || row.seq >= keyedFrom;
      if (hashed && rowHash(key, row.prevHash, fieldsOf(row)) !== row.hash) {
        return broken("its fields are not what its hash says");
      }
      checked += 1;
      last = { seq: row.seq, hash: row.hash };
    }
  }
  return {
    checked,
    from,
    to: last?.seq ?? null,
    hashesFrom: keyedFrom ?? from,
    keyed: key !== null,
    broken: null,
  };
}
