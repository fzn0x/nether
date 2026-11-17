// Work across the server's nodes (ADR 0082): a job runs once in its period
// across the nodes, and again after it; a job that fails gives its claim
// back. Each node writes its heartbeat, which instance admins list, and a
// node without high availability that sees another says so.
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { ClusterJobs } from "../src/jobs.ts";
import { startHeartbeat } from "../src/nodes.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

const running: TestServer[] = [];

afterEach(async () => {
  for (const node of running.splice(0).reverse()) await node.close();
});

/** A log that keeps what is said in error. */
function logOf(): FastifyBaseLogger & { readonly errors: string[] } {
  const errors: string[] = [];
  const quiet = () => undefined;
  const log = {
    errors,
    error: (_details: unknown, message?: string) => {
      errors.push(message ?? "");
    },
    warn: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    fatal: quiet,
    silent: quiet,
    level: "error",
    child: () => log,
  };
  return log;
}

async function server(): Promise<TestServer & SetUp> {
  const first = await startServer();
  running.push(first);
  return { ...first, ...(await setUp(first)) };
}

describe("jobs across nodes", () => {
  it("run once in their period across the nodes, and again after it", async () => {
    const test = await server();
    const ran: string[] = [];
    const one = new ClusterJobs(test.db, "one", logOf());
    const two = new ClusterJobs(test.db, "two", logOf());
    for (const [jobs, node] of [
      [one, "one"],
      [two, "two"],
    ] as const) {
      jobs.every("count", 1_000, () => {
        ran.push(node);
        return Promise.resolve();
      });
    }
    const [first, second] = await Promise.all([one.runDue(), two.runDue()]);
    expect([...first, ...second]).toEqual(["count"]);
    expect(await two.runDue()).toEqual([]);
    // A period later, the next check of either runs it again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await two.runDue()).toEqual(["count"]);
    expect(ran).toHaveLength(2);
    const { rows } = await test.db.query("SELECT node FROM cluster_jobs WHERE name = 'count'");
    expect(rows).toEqual([{ node: "two" }]);
  });

  it("give a failed job's claim back, so the next check runs it", async () => {
    const test = await server();
    const log = logOf();
    const jobs = new ClusterJobs(test.db, "one", log);
    let tries = 0;
    jobs.every("flaky", 3_600_000, () => {
      tries += 1;
      return tries === 1 ? Promise.reject(new Error("Not yet")) : Promise.resolve();
    });
    expect(await jobs.runDue()).toEqual([]);
    expect(log.errors).toHaveLength(1);
    expect(await jobs.runDue()).toEqual(["flaky"]);
    expect(await jobs.runDue()).toEqual([]);
    expect(tries).toBe(2);
  });

  it("take each name once", async () => {
    const test = await server();
    const jobs = new ClusterJobs(test.db, "one", logOf());
    jobs.every("once", 1_000, () => Promise.resolve());
    expect(() => {
      jobs.every("once", 1_000, () => Promise.resolve());
    }).toThrow("named once already");
  });
});

describe("each node's heartbeat", () => {
  it("lists the server's nodes to instance admins, the one answering marked", async () => {
    const test = await server();
    const second = await startServer({
      nodeOf: test,
      env: { NETHER_NODE_NAME: "second-node" },
    });
    running.push(second);
    await second.server.ready();
    await test.server.ready();
    const answer = await test.server.inject({
      method: "GET",
      url: "/api/instance/nodes",
      headers: bearer(test.token),
    });
    expect(answer.statusCode).toBe(200);
    const { nodes } = answer.json<{
      nodes: { name: string; version: string; current: boolean }[];
    }>();
    expect(nodes).toHaveLength(2);
    expect(nodes.filter((node) => node.current)).toHaveLength(1);
    expect(nodes.find((node) => !node.current)?.name).toBe("second-node");
    expect(nodes.every((node) => node.version.length > 0)).toBe(true);
    // A node that stops is gone from the list at once.
    running.splice(running.indexOf(second), 1);
    await second.close();
    const after = await test.server.inject({
      method: "GET",
      url: "/api/instance/nodes",
      headers: bearer(test.token),
    });
    expect(after.json<{ nodes: unknown[] }>().nodes).toHaveLength(1);
  });

  it("refuses anyone but an instance admin", async () => {
    const test = await server();
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invited.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "Bea's long password",
      },
    });
    const answer = await test.server.inject({
      method: "GET",
      url: "/api/instance/nodes",
      headers: bearer(accepted.json<{ token: string }>().token),
    });
    expect(answer.statusCode).toBe(403);
  });

  it("says so when another node runs beside one without high availability", async () => {
    const test = await server();
    const other = startHeartbeat(
      test.db,
      { id: randomUUID(), name: "other", version: "1" },
      { log: logOf(), highlyAvailable: () => Promise.resolve(true), every: 3_600_000 },
    );
    const log = logOf();
    let highlyAvailable = false;
    const node = startHeartbeat(
      test.db,
      { id: randomUUID(), name: "this", version: "1" },
      {
        log,
        highlyAvailable: () => Promise.resolve(highlyAvailable),
        every: 3_600_000,
        overlapFor: 0,
      },
    );
    await other.beat();
    await node.beat();
    expect(log.errors.some((error) => error.includes("NETHER_ENTERPRISE_HA=on"))).toBe(true);
    // With high availability, others beside it are expected.
    highlyAvailable = true;
    const said = log.errors.length;
    await node.beat();
    expect(log.errors).toHaveLength(said);
    await node.stop();
    await other.stop();
  });

  it("takes its name from NETHER_NODE_NAME, or the machine's", () => {
    const base = { NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether" };
    expect(readConfig({ ...base, NETHER_NODE_NAME: " web-1 " }).nodeName).toBe("web-1");
    expect(readConfig(base).nodeName.length).toBeGreaterThan(0);
  });
});
