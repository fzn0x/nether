// The probes and draining (ADR 0082): `/health` answers while the process
// does, whatever its database does; `/health/ready` answers 503 while the
// database does not answer or the node drains, and says how Valkey is
// without failing on it. A node that drains keeps serving for its seconds,
// then closes its sockets with 1012 and stores its open documents.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { readConfig } from "../src/config.ts";
import { type Database, readBytes } from "../src/db.ts";
import { Readiness, drain, registerReadiness } from "../src/health.ts";
import { type SetUp, type TestServer, setUp, startServer, testRedisUrl } from "./app.ts";
import { testDatabase } from "./database.ts";
import { freePort } from "./ports.ts";

const running: TestServer[] = [];
const providers: HocuspocusProvider[] = [];
const opened: Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const node of running.splice(0)) await node.close();
  for (const db of opened.splice(0)) await db.close();
});

/** What the readiness probe says of Valkey: the tests' own when CI gives one. */
const valkey = testRedisUrl === "" ? "none" : "up";

describe("the probes", () => {
  it("answer /health while the database does not, and /health/ready says so", async () => {
    let broken = false;
    const node = await startServer({
      // A module the console switches, so the health check reads its switch.
      enterpriseModules: [{ feature: "audit", plugin: () => Promise.resolve() }],
      wrapDb: (db) => ({
        ...db,
        query: (text, params) =>
          broken ? Promise.reject(new Error("The database is away")) : db.query(text, params),
      }),
    });
    running.push(node);
    expect((await node.server.inject({ method: "GET", url: "/health/ready" })).json()).toEqual({
      status: "ready",
      database: "up",
      valkey,
    });
    broken = true;
    // Past the few seconds the enterprise switches are kept.
    const later = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const health = await node.server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", enterprise: null });
    const ready = await node.server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "unready", database: "down", valkey });
  });

  it("say Valkey is down without failing on it", async () => {
    const db = await testDatabase();
    opened.push(db);
    const app = Fastify();
    registerReadiness(app, db, { status: "reconnecting" }, new Readiness());
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", database: "up", valkey: "down" });
    await app.close();
  });
});

/** The text of a note as stored, or undefined before it is. */
async function storedText(db: Database, workspace: string, note: string) {
  const { rows } = await db.query(
    "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
    [workspace, note],
  );
  if (rows[0] === undefined) return undefined;
  const document = new Y.Doc();
  Y.applyUpdate(document, readBytes(rows[0], "state"));
  return document.getText("content").toJSON();
}

describe("draining", () => {
  it("answers 503 at readiness at once, serves for its seconds, then closes sockets with 1012 and stores", async () => {
    const readiness = new Readiness();
    const node = await startServer({ readiness });
    running.push(node);
    const setup: SetUp = await setUp(node);
    await node.server.listen({ host: "127.0.0.1", port: await freePort() });
    const port = String((node.server.server.address() as AddressInfo).port);
    const note = randomUUID();

    const closes: number[] = [];
    const provider = await new Promise<HocuspocusProvider>((resolve, reject) => {
      const made = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/api/sync`,
        name: `${setup.workspaceId}/${note}`,
        token: setup.token,
        document: new Y.Doc(),
        onSynced: () => {
          resolve(made);
        },
        onClose: ({ event }) => {
          closes.push(event.code);
        },
        onAuthenticationFailed: ({ reason }) => {
          reject(new Error(reason));
        },
      });
      providers.push(made);
    });
    const relay = new WebSocket(`ws://127.0.0.1:${port}/api/relay`);
    await new Promise<void>((resolve) => {
      relay.addEventListener("open", () => {
        relay.send(JSON.stringify({ type: "auth", token: setup.token }));
      });
      relay.addEventListener("message", () => {
        resolve();
      });
    });
    const relayClosed = new Promise<number>((resolve) => {
      relay.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    // An edit not stored yet when the node starts to drain.
    provider.document.getText("content").insert(0, "Kept as the node stopped.");

    const drained = drain(node.server, readiness, 0.5);
    const ready = await node.server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "draining", database: "up" });
    // Still serving while the load balancer takes it out.
    expect((await node.server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await drained;

    expect(await relayClosed).toBe(1012);
    expect(closes).toContain(1012);
    expect(await storedText(node.db, setup.workspaceId, note)).toBe("Kept as the node stopped.");
  }, 30_000);
});

describe("NETHER_DRAIN_SECONDS", () => {
  const base = { NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether" };

  it("is 5 unless set, and any whole number of seconds to 300", () => {
    expect(readConfig(base).drainSeconds).toBe(5);
    expect(readConfig({ ...base, NETHER_DRAIN_SECONDS: " 0 " }).drainSeconds).toBe(0);
    expect(readConfig({ ...base, NETHER_DRAIN_SECONDS: "30" }).drainSeconds).toBe(30);
    for (const value of ["-1", "301", "five", "1.5"]) {
      expect(() => readConfig({ ...base, NETHER_DRAIN_SECONDS: value })).toThrow(
        "NETHER_DRAIN_SECONDS must be a whole number of seconds from 0 to 300",
      );
    }
  });
});
