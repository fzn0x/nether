// Storing a vault document parses its paths once on each side, for search,
// webhooks and audit logs alike (ADR 0081): with no module wanting events,
// as with audit logs off, nothing more is parsed or found, and with one
// wanting them, the notes it no longer lists are told of from the same
// parse.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { type ServerEvent, ServerEvents } from "../src/events.ts";
import { pathsOf } from "../src/search.ts";
import { storeDocument } from "../src/sync.ts";
import { type SetUp, type TestServer, setUp, startServer } from "./app.ts";

vi.mock("../src/search.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search.ts")>();
  return { ...actual, pathsOf: vi.fn(actual.pathsOf) };
});

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(): Promise<TestServer & SetUp> {
  running = await startServer();
  return { ...running, ...(await setUp(running)) };
}

/** A vault document listing notes by ID and path. */
function vaultState(paths: Record<string, string>): Uint8Array {
  const document = new Y.Doc();
  const notes = document.getMap<string>("notes");
  for (const [id, path] of Object.entries(paths)) notes.set(id, path);
  return Y.encodeStateAsUpdate(document);
}

/** Stores a vault document listing `kept` after one listing `kept` and a note more, and counts the parses. */
async function storeRemoving(test: TestServer & SetUp, events: ServerEvents) {
  const kept = randomUUID();
  const gone = randomUUID();
  await storeDocument(
    test.db,
    test.workspaceId,
    "vault",
    vaultState({ [kept]: "Kept.md", [gone]: "Gone.md" }),
  );
  vi.mocked(pathsOf).mockClear();
  await storeDocument(test.db, test.workspaceId, "vault", vaultState({ [kept]: "Kept.md" }), {
    events,
    changedBy: [],
  });
  return { gone, parses: vi.mocked(pathsOf).mock.calls.length };
}

describe("storing a vault document", () => {
  it("parses each side's paths once, and finds nothing more while no module wants events", async () => {
    const test = await start();
    // No module listening.
    expect((await storeRemoving(test, new ServerEvents())).parses).toBe(2);
    // A module listening, but off: it is asked, and nothing is found for it.
    const off = new ServerEvents();
    const heard: ServerEvent[] = [];
    const wants = vi.fn(() => Promise.resolve(false));
    off.listen((event) => {
      heard.push(event);
      return Promise.resolve();
    }, wants);
    expect((await storeRemoving(test, off)).parses).toBe(2);
    expect(wants).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });

  it("tells a module that wants events of the notes it no longer lists, from the same parse", async () => {
    const test = await start();
    const on = new ServerEvents();
    const heard: ServerEvent[] = [];
    on.listen(
      (event) => {
        heard.push(event);
        return Promise.resolve();
      },
      () => Promise.resolve(true),
    );
    const { gone, parses } = await storeRemoving(test, on);
    expect(parses).toBe(2);
    expect(heard).toMatchObject([
      {
        action: "note.deleted",
        actor: { kind: "system" },
        target: { type: "note", id: gone, name: "Gone" },
        details: { path: "Gone.md", via: "server" },
      },
    ]);
  });
});
