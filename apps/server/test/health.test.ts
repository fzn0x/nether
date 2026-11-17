// The probes (ADR 0082): `/health` answers while the process does,
// whatever its database does; `/health/ready` answers 503 while the
// database does not answer or the node drains, and says how Valkey is
// without failing on it.
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db.ts";
import { Readiness, registerReadiness } from "../src/health.ts";
import { type TestServer, startServer, testRedisUrl } from "./app.ts";
import { testDatabase } from "./database.ts";

const running: TestServer[] = [];
const opened: Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
