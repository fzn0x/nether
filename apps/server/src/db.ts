// The server's database (ADR 0031): PostgreSQL through node-postgres, behind
// the small interface the rest of the server uses, so its tests run it on
// PGlite, PostgreSQL in the test's own process, and CI on a real server.
import pg from "pg";

/** A row as the database returns it; whoever reads a column checks its type. */
export type Row = Record<string, unknown>;

function unexpected(column: string, value: unknown, expected: string): TypeError {
  return new TypeError(`The database returned ${typeof value} for ${column}, not ${expected}`);
}

/** A column's text, such as a name or a UUID. */
export function readText(row: Row | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== "string") throw unexpected(column, value, "text");
  return value;
}

/** A column's text, or null where it has none. */
export function readTextOrNull(row: Row | undefined, column: string): string | null {
  const value = row?.[column];
  if (value === null) return null;
  return readText(row, column);
}

/** An `integer` column, which both drivers return as a number. */
export function readNumber(row: Row | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== "number") throw unexpected(column, value, "a number");
  return value;
}

export function readBoolean(row: Row | undefined, column: string): boolean {
  const value = row?.[column];
  if (typeof value !== "boolean") throw unexpected(column, value, "a boolean");
  return value;
}

/**
 * A `bigint` column that counts, such as a sequence's number: node-postgres
 * returns it as text, PGlite as a number or a bigint. Counts stay far below
 * 2^53, where a number would lose precision.
 */
export function readCount(row: Row | undefined, column: string): number {
  const value = row?.[column];
  const count = typeof value === "string" || typeof value === "bigint" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count)) {
    throw unexpected(column, value, "a count");
  }
  return count;
}

/** A `bytea` column: a Buffer from node-postgres, a Uint8Array from PGlite. */
export function readBytes(row: Row | undefined, column: string): Uint8Array {
  const value = row?.[column];
  if (!(value instanceof Uint8Array)) throw unexpected(column, value, "bytes");
  return value;
}

/** A `timestamptz` column, which both drivers return as a Date. */
export function readTime(row: Row | undefined, column: string): Date {
  const value = row?.[column];
  if (!(value instanceof Date)) throw unexpected(column, value, "a time");
  return value;
}

/**
 * What runs SQL: the database, or a transaction in it. Parameters are `$1`,
 * `$2`… Without parameters, `text` may hold several statements.
 */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<{ readonly rows: Row[] }>;
}

export interface Database extends Queryable {
  /** Runs `work` in a transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Runs `work` while holding a lock named `key`, which no other work of
   * any node holds meanwhile (ADR 0082); or each of several, taken in the
   * order given and held together, so work holding one never waits for a
   * connection to take the next. The work runs outside any transaction,
   * and may take its own.
   */
  lock<T>(key: string | readonly string[], work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Locks by name within one process: each key's work after the one before
 * it, as a database with one connection, PGlite, has them.
 */
export function processLocks(): Database["lock"] {
  const turns = new Map<string, Promise<unknown>>();
  const one = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (turns.get(key) ?? Promise.resolve()).then(work, work);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    turns.set(key, done);
    void done.then(() => {
      if (turns.get(key) === done) turns.delete(key);
    });
    return run;
  };
  // Each key's turn inside the one before.
  const all = <T>(keys: readonly string[], work: () => Promise<T>): Promise<T> => {
    const [first, ...rest] = keys;
    return first === undefined ? work() : one(first, () => all(rest, work));
  };
  return (key, work) => all(typeof key === "string" ? [key] : key, work);
}

/** A pool of connections to the PostgreSQL database at `url`. */
export function connectPostgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Locks hold a connection of their own while their work uses the pool's,
  // so work waiting on a lock never takes every connection its holder needs.
  let lockPool: pg.Pool | undefined;
  // Work of this process for one key waits here, not on a connection each.
  const inProcess = processLocks();
  return {
    async query(text, params) {
      const result = await pool.query<Row>(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows };
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          async query(text, params) {
            const result = await client.query<Row>(
              text,
              params === undefined ? undefined : [...params],
            );
            return { rows: result.rows };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    lock: <T>(key: string | readonly string[], work: () => Promise<T>): Promise<T> =>
      inProcess(key, async () => {
        lockPool ??= new pg.Pool({ connectionString: url, max: 4 });
        const names = (typeof key === "string" ? [key] : key).map((each) => `nether.lock.${each}`);
        // Every lock on one connection, taken in order.
        const client = await lockPool.connect();
        const held: string[] = [];
        let broken: Error | undefined;
        try {
          try {
            for (const name of names) {
              // A session's lock, held until it is let go or the connection ends.
              await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [name]);
              held.push(name);
            }
            return await work();
          } finally {
            for (const name of held.reverse()) {
              await client
                .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name])
                .catch((error: unknown) => {
                  // A connection that could not let go is closed, and its locks with it.
                  broken = error instanceof Error ? error : new Error(String(error));
                });
            }
          }
        } finally {
          client.release(broken);
        }
      }),
    async close() {
      await pool.end();
      await lockPool?.end();
    },
  };
}
