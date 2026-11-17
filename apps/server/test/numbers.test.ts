// Numbers in commit order (ADR 0082): a workspace's stores draw their
// numbers under its lock, held until they commit, so a listing that shows
// a number shows every smaller one of that workspace; and a transaction
// storing two documents and another storing one of them both finish, the
// later numbered after the first. On PGlite transactions take turns
// anyway; on PostgreSQL, as CI runs them, these tests hold the lock's
// order to account.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Database } from "../src/db.ts";
import { storeDocument, storeDocuments } from "../src/sync.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Test = TestServer & SetUp;

async function start(): Promise<Test> {
  running = await startServer();
  return { ...running, ...(await setUp(running)) };
}

function state(text: string): Uint8Array {
  const document = new Y.Doc();
  document.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(document);
}

/**
 * The database, but the next transaction holds its commit, its numbers
 * drawn and its lock taken, until `release` is called.
 */
function holdingNextCommit(db: Database) {
  let held: Promise<void> | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding: Database = {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        const result = await work(tx);
        if (held === undefined) {
          held = gate;
          await gate;
        }
        return result;
      }),
  };
  return { db: holding, release, isHolding: () => held !== undefined };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The documents a workspace lists since nothing, by name. */
async function listed(test: Test): Promise<Map<string, number>> {
  const answer = await test.server.inject({
    method: "GET",
    url: `/api/workspaces/${test.workspaceId}/documents?since=0`,
    headers: bearer(test.token),
  });
  const body = answer.json<{ documents: { name: string; seq: number }[] }>();
  return new Map(body.documents.map((document) => [document.name, document.seq]));
}

describe("numbers in commit order", () => {
  it("never lists a store's number while one numbered before it still commits", async () => {
    const test = await start();
    const first = randomUUID();
    const second = randomUUID();
    const held = holdingNextCommit(test.db);
    const one = storeDocument(held.db, test.workspaceId, first, state("first"));
    await until(held.isHolding);
    const two = storeDocument(test.db, test.workspaceId, second, state("second"));
    // Listed while the first holds its commit, its number drawn, and the
    // second has had time to commit, were it not waiting for the first.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during = listed(test);
    await new Promise((resolve) => setTimeout(resolve, 200));
    held.release();
    const [numberOne, numberTwo] = await Promise.all([one, two]);
    expect(numberOne).toBeLessThan(numberTwo);
    const seen = await during;
    // What it listed is a prefix: had it shown the second, it showed the first.
    if (seen.has(second)) expect(seen.get(first)).toBe(numberOne);
    expect(await listed(test)).toEqual(
      new Map([
        [first, numberOne],
        [second, numberTwo],
      ]),
    );
  });

  it("numbers a transaction storing two documents and another storing one of them in turn", async () => {
    const test = await start();
    for (const fresh of [true, false]) {
      for (const twoFirst of [true, false]) {
        const x = randomUUID();
        const y = randomUUID();
        if (!fresh) {
          // The rows are there already, so the stores update them.
          await storeDocuments(test.db, test.workspaceId, [
            { document: x, state: state("x") },
            { document: y, state: state("y") },
          ]);
        }
        const held = holdingNextCommit(test.db);
        const storeTwo = (db: Database) =>
          storeDocuments(db, test.workspaceId, [
            { document: y, state: state("y, by two") },
            { document: x, state: state("x, by two") },
          ]);
        const storeOne = (db: Database) =>
          storeDocument(db, test.workspaceId, y, state("y, by one"));
        const before = twoFirst ? storeTwo(held.db) : storeOne(held.db);
        await until(held.isHolding);
        const after = twoFirst ? storeOne(test.db) : storeTwo(test.db);
        await new Promise((resolve) => setTimeout(resolve, 100));
        held.release();
        const [earlier, later] = await Promise.all([before, after]);
        const earlierNumbers = typeof earlier === "number" ? [earlier] : earlier;
        const laterNumbers = typeof later === "number" ? [later] : later;
        // Neither waited on the other forever, and the later drew after the earlier committed.
        expect(Math.min(...laterNumbers)).toBeGreaterThan(Math.max(...earlierNumbers));
      }
    }
  });

  it("stores each document of a transaction once", async () => {
    const test = await start();
    const x = randomUUID();
    await expect(
      storeDocuments(test.db, test.workspaceId, [
        { document: x, state: state("a") },
        { document: x, state: state("b") },
      ]),
    ).rejects.toThrow("each document once");
  });
});
