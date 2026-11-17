// A vault's index on the phone (ADR 0087): what the SQLite plugin is asked,
// as Android's executeSet binds no bytes and a write must not join another's
// transaction.
import { describe, expect, it } from "vitest";
import { type SqliteConnection, bound, openMobileIndex } from "../src/mobileIndex.ts";

/** A connection that records each call, and fails a statement whose text says so. */
function recording() {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const db: SqliteConnection = {
    isDBOpen: () => Promise.resolve({ result: true }),
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    execute: (sql) => {
      calls.push(`execute ${sql}`);
      return Promise.resolve();
    },
    run: async (sql, values) => {
      calls.push(`run ${sql} ${JSON.stringify(values)}`);
      if (sql === "SLOW") await new Promise<void>((done) => (release = done));
      if (sql === "FAIL") throw new Error("no such table");
    },
    query: (sql) => {
      calls.push(`query ${sql}`);
      return Promise.resolve({ values: [] });
    },
    executeSet: (set) => {
      calls.push(`executeSet ${set.map((statement) => statement.statement).join("; ")}`);
      return Promise.resolve();
    },
    beginTransaction: () => {
      calls.push("begin");
      return Promise.resolve();
    },
    commitTransaction: () => {
      calls.push("commit");
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      calls.push("rollback");
      return Promise.resolve();
    },
  };
  const connections = { connect: () => Promise.resolve(db), release: () => Promise.resolve() };
  return { calls, connections, release: () => release?.() };
}

describe("the phone's index", () => {
  it("sends a set without bytes in one call", async () => {
    const { calls, connections } = recording();
    const index = await openMobileIndex(connections, "v");
    calls.length = 0;
    await index.transaction([
      { sql: "DELETE FROM files WHERE path = ?", params: ["a.md"] },
      { sql: "INSERT INTO files VALUES (?)", params: ["b.md"] },
    ]);
    expect(calls).toEqual([
      "executeSet DELETE FROM files WHERE path = ?; INSERT INTO files VALUES (?)",
    ]);
  });

  it("runs a set with bytes one by one in a transaction, which run binds as a Buffer", async () => {
    const { calls, connections } = recording();
    const index = await openMobileIndex(connections, "v");
    calls.length = 0;
    await index.transaction([
      { sql: "INSERT INTO document_updates VALUES (?, ?)", params: ["n", Uint8Array.of(1, 4)] },
      { sql: "UPDATE documents SET seq = ?", params: [2] },
    ]);
    expect(calls).toEqual([
      "begin",
      `run INSERT INTO document_updates VALUES (?, ?) ${JSON.stringify(["n", bound(Uint8Array.of(1, 4))])}`,
      "run UPDATE documents SET seq = ? [2]",
      "commit",
    ]);
  });

  it("rolls a set with bytes back when a statement fails, and goes on", async () => {
    const { calls, connections } = recording();
    const index = await openMobileIndex(connections, "v");
    calls.length = 0;
    await expect(
      index.transaction([
        { sql: "INSERT INTO blobs VALUES (?)", params: [Uint8Array.of(9)] },
        { sql: "FAIL" },
      ]),
    ).rejects.toThrow("no such table");
    await index.execute("UPDATE settings SET value = ?", ["x"]);
    expect(calls).toEqual([
      "begin",
      'run INSERT INTO blobs VALUES (?) [{"type":"Buffer","data":[9]}]',
      "run FAIL []",
      "rollback",
      'run UPDATE settings SET value = ? ["x"]',
    ]);
  });

  it("lets no write in while a set with bytes runs", async () => {
    const recorder = recording();
    const index = await openMobileIndex(recorder.connections, "v");
    recorder.calls.length = 0;
    const set = index.transaction([
      { sql: "SLOW", params: [Uint8Array.of(1)] },
      { sql: "AFTER SLOW" },
    ]);
    const write = index.execute("WRITE");
    await new Promise((settle) => setTimeout(settle, 0));
    expect(recorder.calls).toEqual(["begin", 'run SLOW [{"type":"Buffer","data":[1]}]']);
    recorder.release();
    await Promise.all([set, write]);
    expect(recorder.calls).toEqual([
      "begin",
      'run SLOW [{"type":"Buffer","data":[1]}]',
      "run AFTER SLOW []",
      "commit",
      "run WRITE []",
    ]);
  });
});
