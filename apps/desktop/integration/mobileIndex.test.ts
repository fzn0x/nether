// A vault's index on the phone (ADR 0087): the SQLite plugin's connection as
// the Database the store takes. Node's own SQLite stands in for the plugin
// here, answering as the plugin does: rows as objects by column, BLOBs as
// arrays of numbers, and bytes bound from a Node Buffer's JSON.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type NoteId, newNoteId } from "@nether/core";
import { parseQuery } from "@nether/search";
import { SqliteStore } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type SqliteConnection,
  type SqliteConnections,
  bound,
  cell,
  openMobileIndex,
  rowsOf,
} from "../src/mobileIndex.ts";

/** A value as the plugin binds it natively: a Buffer's JSON as bytes. */
function native(value: unknown): SQLInputValue {
  if (typeof value === "object" && value !== null && "type" in value && "data" in value) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return value as SQLInputValue;
}

/** The plugin, over Node's SQLite, recording what it was asked. */
function fakePlugin() {
  const asked: string[] = [];
  let open = false;
  let released = false;
  const raw = new DatabaseSync(":memory:");
  const run = (sql: string, values: unknown[] = []) => {
    raw.prepare(sql).run(...values.map(native));
  };
  const connection: SqliteConnection = {
    isDBOpen: () => Promise.resolve({ result: open }),
    open() {
      open = true;
      return Promise.resolve();
    },
    close() {
      open = false;
      return Promise.resolve();
    },
    execute(sql) {
      asked.push(sql);
      raw.exec(sql);
      return Promise.resolve();
    },
    run(sql, values) {
      run(sql, values);
      return Promise.resolve();
    },
    query(sql, values = []) {
      asked.push(sql);
      const rows = raw.prepare(sql).all(...values.map(native));
      return Promise.resolve({
        values: rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? Array.from(value) : value,
            ]),
          ),
        ),
      });
    },
    executeSet(set) {
      // As on Android, a set binds its values as they come: a Buffer's JSON
      // is not bytes there, and is refused.
      for (const { values } of set) {
        const object = values.findIndex((value) => typeof value === "object" && value !== null);
        if (object !== -1) {
          return Promise.reject(new Error(`ExecuteSet: Cannot bind at index ${String(object)}`));
        }
      }
      raw.exec("BEGIN");
      try {
        for (const { statement, values } of set) run(statement, values);
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return Promise.resolve();
    },
    beginTransaction() {
      raw.exec("BEGIN");
      return Promise.resolve();
    },
    commitTransaction() {
      raw.exec("COMMIT");
      return Promise.resolve();
    },
    rollbackTransaction() {
      raw.exec("ROLLBACK");
      return Promise.resolve();
    },
  };
  const connections: SqliteConnections = {
    connect: () => Promise.resolve(connection),
    release() {
      released = true;
      return Promise.resolve();
    },
  };
  return { connections, asked, isOpen: () => open, isReleased: () => released };
}

describe("the mobile index", () => {
  it("binds bytes as a Buffer's JSON, and reads a BLOB's numbers back as bytes", () => {
    expect(bound(new Uint8Array([1, 2, 255]))).toEqual({ type: "Buffer", data: [1, 2, 255] });
    expect(bound(7n)).toBe(7);
    expect(bound("text")).toBe("text");
    expect(bound(undefined)).toBeNull();
    expect(cell([1, 2, 255])).toEqual(new Uint8Array([1, 2, 255]));
    expect(cell(undefined)).toBeNull();
    expect(cell(3)).toBe(3);
  });

  it("reads rows in the statement's order, and none as no columns", () => {
    expect(rowsOf([{ note: "a", size: 2, data: [9] }])).toEqual({
      columns: ["note", "size", "data"],
      rows: [["a", 2, new Uint8Array([9])]],
    });
    expect(rowsOf([])).toEqual({ columns: [], rows: [] });
  });

  it("opens in WAL mode with full syncs, and lets the connection go as it closes", async () => {
    const plugin = fakePlugin();
    const database = await openMobileIndex(plugin.connections, "vault-1");
    expect(plugin.isOpen()).toBe(true);
    expect(plugin.asked).toEqual(["PRAGMA journal_mode = WAL", "PRAGMA synchronous = FULL"]);
    await database.close();
    expect(plugin.isOpen()).toBe(false);
    expect(plugin.isReleased()).toBe(true);
  });

  it("holds the vault's index as the store keeps it: files, documents' bytes and search", async () => {
    const plugin = fakePlugin();
    const store = await SqliteStore.open(await openMobileIndex(plugin.connections, "vault-2"));
    const note: NoteId = newNoteId();

    await store.apply({ upsert: [{ path: "Ideas.md", note, size: 5, modified: 10, hash: "abc" }] });
    expect(await store.files()).toEqual([
      { path: "Ideas.md", note, size: 5, modified: 10, hash: "abc" },
    ]);

    const update = new Uint8Array([1, 0, 200, 7]);
    await store.appendUpdates(note, [update]);
    const stored = await store.document(note);
    expect(stored.updates.map((each) => each.data)).toEqual([update]);

    await store.setSetting("place", new Uint8Array([4, 2]));
    expect(await store.setting("place")).toEqual(new Uint8Array([4, 2]));

    await store.putNoteTexts([{ note, title: "Ideas", body: "a garden of small ideas" }]);
    const hits = await store.searchText(parseQuery("garden"), 10);
    expect(hits.map((hit) => hit.note)).toEqual([note]);
    await store.close();
  });
});
