// Work across the server's nodes (ADR 0082): a job runs once in its period
// across the nodes, and again after it; a job that fails gives its claim
// back.
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ClusterJobs } from "../src/jobs.ts";
import { type SetUp, type TestServer, setUp, startServer } from "./app.ts";

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
