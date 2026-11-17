// A vault's index on the phone (ADR 0087): SQLite through
// @capacitor-community/sqlite, whose native builds are SQLCipher's with FTS5,
// as the `Database` that SqliteStore takes. The databases are not
// encrypted: the phone's own encryption of the app's data covers them. Each
// opens in WAL mode with full syncs, so a commit survives a power cut. The
// plugin gives rows as objects by column, in the statement's order, and
// BLOBs as arrays of numbers; it binds bytes given as a Node Buffer's JSON.
import type { Database, SqlValue, Statement } from "@nether/storage";

/** What the plugin's connection does, of what the index uses. */
export interface SqliteConnection {
  isDBOpen(): Promise<{ result?: boolean }>;
  open(): Promise<void>;
  close(): Promise<void>;
  execute(statements: string, transaction?: boolean): Promise<unknown>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  executeSet(
    set: { statement: string; values: unknown[] }[],
    transaction?: boolean,
  ): Promise<unknown>;
}

/** Opens, or finds open, a connection to a database by name, and lets it go. */
export interface SqliteConnections {
  connect(name: string): Promise<SqliteConnection>;
  release(name: string): Promise<void>;
}

/** A value as the plugin binds it: bytes as a Node Buffer's JSON. */
export function bound(value: SqlValue | undefined): unknown {
  if (value instanceof Uint8Array) return { type: "Buffer", data: Array.from(value) };
  if (typeof value === "bigint") return Number(value);
  return value ?? null;
}

/** A cell as the store reads it: a BLOB's numbers as bytes. */
export function cell(value: unknown): SqlValue {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value === undefined) return null;
  return value as SqlValue;
}

/** The plugin's rows as the store reads them: columns, and each row's cells in their order. */
export function rowsOf(values: readonly unknown[]): {
  columns: string[];
  rows: SqlValue[][];
} {
  const first = values[0];
  const columns = typeof first === "object" && first !== null ? Object.keys(first) : [];
  return {
    columns,
    rows: values.map((row) =>
      columns.map((column) => cell((row as Record<string, unknown>)[column])),
    ),
  };
}

/** The index of a vault, by the vault's ID, in its own database. */
export async function openMobileIndex(
  connections: SqliteConnections,
  vault: string,
): Promise<Database> {
  const name = `index-${vault}`;
  const db = await connections.connect(name);
  // A connection kept from before, as after the page reloads, may be open still.
  if ((await db.isDBOpen()).result !== true) await db.open();
  // WAL keeps readers apart from the writer; FULL syncs each commit to the disk.
  await db.query("PRAGMA journal_mode = WAL");
  await db.execute("PRAGMA synchronous = FULL", false);
  return {
    execute(sql: string, params: readonly SqlValue[] = []) {
      return db.run(sql, params.map(bound), false);
    },
    async query(sql: string, params: readonly SqlValue[] = []) {
      const { values = [] } = await db.query(sql, params.map(bound));
      return rowsOf(values);
    },
    transaction(statements: readonly Statement[]) {
      return db.executeSet(
        statements.map((statement) => ({
          statement: statement.sql,
          values: (statement.params ?? []).map(bound),
        })),
        true,
      );
    },
    async close() {
      await db.close();
      await connections.release(name);
    },
  };
}

/** The plugin's connections, loaded with it. */
export async function pluginConnections(): Promise<SqliteConnections> {
  const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  return {
    async connect(name) {
      const open = (await sqlite.isConnection(name, false)).result === true;
      return open
        ? sqlite.retrieveConnection(name, false)
        : sqlite.createConnection(name, false, "no-encryption", 1, false);
    },
    release: (name) => sqlite.closeConnection(name, false),
  };
}
