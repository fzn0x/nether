// Stores across nodes (ADR 0082): a store merges with what is stored only
// when another node stored the document since this one read it, and its
// open document then gets what it lacked; a store of a row no one else
// changed reads no stored state. Making a note through the API takes a
// lock every node shares, so two makes of one path go one after the other.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type Database, type Queryable, connectPostgres, readBytes } from "../src/db.ts";
import { storeDocuments } from "../src/sync.ts";
import { type SetUp, type TestServer, bearer, setUp, signIn, startServer } from "./app.ts";
import { testDatabase } from "./database.ts";
import { freePort } from "./ports.ts";

const running: TestServer[] = [];
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const node of running.splice(0).reverse()) await node.close();
});

async function listen(node: TestServer): Promise<string> {
  await node.server.listen({ host: "127.0.0.1", port: await freePort() });
  return `ws://127.0.0.1:${String((node.server.server.address() as AddressInfo).port)}/api/sync`;
}

function connect(url: string, name: string, token: string): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url,
      name,
      token,
      document: new Y.Doc(),
      onSynced: () => {
        resolve(provider);
      },
      onAuthenticationFailed: ({ reason }) => {
        reject(new Error(reason));
      },
    });
    providers.push(provider);
  });
}

function textOf(document: Y.Doc): string {
  return document.getText("content").toJSON();
}

async function until(check: () => boolean | Promise<boolean>, seconds = 15): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The text a note's stored state holds, or undefined before it is stored. */
async function storedText(db: Database, workspace: string, note: string) {
  const { rows } = await db.query(
    "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
    [workspace, note],
  );
  if (rows[0] === undefined) return undefined;
  const document = new Y.Doc();
  Y.applyUpdate(document, readBytes(rows[0], "state"));
  return textOf(document);
}

describe("stores across nodes", () => {
  it("merge a store with what another node stored since, and give its clients what they lacked", async () => {
    const first = await startServer();
    running.push(first);
    const setup: SetUp = await setUp(first);
    const second = await startServer({ nodeOf: first });
    running.push(second);
    const note = randomUUID();
    const name = `${setup.workspaceId}/${note}`;
    const token = (await signIn(second.server, "ada@example.org", "a long password")).json<{
      token: string;
    }>().token;
    // Each node opens the note, before anything of it is stored.
    const laptop = await connect(await listen(first), name, setup.token);
    const phone = await connect(await listen(second), name, token);

    laptop.document.getText("content").insert(0, "From the laptop.");
    await until(async () => (await storedText(first.db, setup.workspaceId, note)) !== undefined);
    // The second node never saw it; its store merges with it rather than replace it.
    phone.document.getText("content").insert(0, "From the phone. ");
    await until(async () =>
      ((await storedText(first.db, setup.workspaceId, note)) ?? "").includes("From the phone."),
    );
    const stored = (await storedText(first.db, setup.workspaceId, note)) ?? "";
    expect(stored).toContain("From the laptop.");
    // And the phone, on the node that lacked it, gets the laptop's words.
    await until(() => textOf(phone.document).includes("From the laptop."));
  }, 30_000);

  it("read no stored state to store a note no one else stored since", async () => {
    const reads: string[] = [];
    const counted =
      (query: Queryable["query"]): Queryable["query"] =>
      (text, params) => {
        if (text.includes("SELECT state FROM documents")) reads.push(text);
        return query(text, params);
      };
    const first = await startServer({
      wrapDb: (db) => ({
        ...db,
        query: counted((text, params) => db.query(text, params)),
        transaction: (work) =>
          db.transaction((tx) =>
            work({ query: counted((text, params) => tx.query(text, params)) }),
          ),
      }),
    });
    running.push(first);
    const setup: SetUp = await setUp(first);
    const note = randomUUID();
    const laptop = await connect(await listen(first), `${setup.workspaceId}/${note}`, setup.token);
    laptop.document.getText("content").insert(0, "First.");
    await until(async () => (await storedText(first.db, setup.workspaceId, note)) === "First.");
    laptop.document.getText("content").insert(6, " Second.");
    await until(
      async () => (await storedText(first.db, setup.workspaceId, note)) === "First. Second.",
    );
    // The note's state was read once, with its number, as it opened, and never to store it.
    expect(reads).toEqual([]);
  }, 30_000);

  it("replace what is stored when the store keeps no number, and merge when it keeps a stale one", async () => {
    const first = await startServer();
    running.push(first);
    const setup: SetUp = await setUp(first);
    const state = (words: string) => {
      const document = new Y.Doc();
      document.getText("content").insert(0, words);
      return Y.encodeStateAsUpdate(document);
    };
    const note = randomUUID();
    const [made] = await storeDocuments(first.db, setup.workspaceId, [
      { document: note, state: state("Made.") },
    ]);
    // A number the store knows as current: written as given.
    const [kept] = await storeDocuments(first.db, setup.workspaceId, [
      { document: note, state: state("Replaced."), known: made?.seq ?? 0 },
    ]);
    expect(kept?.lacked).toBeUndefined();
    expect(await storedText(first.db, setup.workspaceId, note)).toBe("Replaced.");
    // A stale number: merged, and what the store lacked given back.
    const [merged] = await storeDocuments(first.db, setup.workspaceId, [
      { document: note, state: state("Also."), known: made?.seq ?? 0 },
    ]);
    expect(merged?.lacked).toBeDefined();
    const text = (await storedText(first.db, setup.workspaceId, note)) ?? "";
    expect(text).toContain("Replaced.");
    expect(text).toContain("Also.");
  });
});

describe("making notes on two nodes", () => {
  it("takes one path once, the second make refused", async () => {
    const first = await startServer();
    running.push(first);
    const setup: SetUp = await setUp(first);
    const second = await startServer({ nodeOf: first });
    running.push(second);
    const made = await first.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(setup.token),
      payload: { name: "Script", access: "write", password: "a long password" },
    });
    const secret = made.json<{ token: string }>().token;
    const make = (node: TestServer, words: string) =>
      node.server.inject({
        method: "POST",
        url: `/api/v1/workspaces/${setup.workspaceId}/notes`,
        headers: bearer(secret),
        payload: { path: "Plans.md", markdown: `${words}\n` },
      });
    const answers = await Promise.all([make(first, "One"), make(second, "Two")]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409]);
  }, 30_000);
});

describe("a lock every node shares", () => {
  const url = process.env.NETHER_TEST_DATABASE_URL ?? "";

  /** Two works, each under its key, each saying when it starts and ends. */
  async function twoWorks(
    first: Database,
    second: Database,
    keys: readonly [string, string],
  ): Promise<string[]> {
    const said: string[] = [];
    const work = (name: string) => async () => {
      said.push(`${name} in`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      said.push(`${name} out`);
    };
    await Promise.all([first.lock(keys[0], work("a")), second.lock(keys[1], work("b"))]);
    return said;
  }

  /** Whether one work ended before the other started. */
  function apart(said: readonly string[]): boolean {
    return said[0]?.slice(0, 1) === said[1]?.slice(0, 1) && said[1]?.endsWith("out") === true;
  }

  it("runs works of one key one after the other, of two keys at once, and lets go when one throws", async () => {
    const db = await testDatabase();
    try {
      expect(apart(await twoWorks(db, db, ["one", "one"]))).toBe(true);
      const both = await twoWorks(db, db, ["one", "two"]);
      expect(both.slice(0, 2).every((each) => each.endsWith("in"))).toBe(true);
      await expect(db.lock("one", () => Promise.reject(new Error("No")))).rejects.toThrow("No");
      expect(await db.lock("one", () => Promise.resolve("after"))).toBe("after");
    } finally {
      await db.close();
    }
  });

  it.skipIf(url === "")("holds across two nodes' connections to PostgreSQL", async () => {
    const first = connectPostgres(url);
    const second = connectPostgres(url);
    const key = `test.${randomUUID()}`;
    try {
      expect(apart(await twoWorks(first, second, [key, key]))).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
