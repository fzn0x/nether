// Enterprise features' switches (ADR 0079): off until the console turns
// one on, or the environment pins it; a module's routes answering only
// while its feature is on, from the next request; and the console's
// routes for instance admins alone. High availability is the environment's
// alone, and a module acts as the server starts when its feature is on
// (ADR 0082).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessBus } from "../src/cluster.ts";
import type { Database } from "../src/db.ts";
import {
  type EnterpriseModule,
  EnterpriseSwitches,
  enterpriseFeatures,
} from "../src/enterprise.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

type Test = TestServer & SetUp & { close(): Promise<void> };
let running: Test | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = undefined;
});

/** An audit module of a test's own: one route, answering only while audit is on. */
const audit: EnterpriseModule = {
  feature: "audit",
  plugin: (instance, { whenOn }) => {
    instance.get("/api/audit/ping", { preHandler: whenOn }, () => ({ pong: true }));
    return Promise.resolve();
  },
};

async function start(
  env: Record<string, string> = {},
  modules: readonly EnterpriseModule[] = [audit],
): Promise<Test> {
  const server = await startServer({ env, enterpriseModules: modules });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

function features(test: Test, token = test.token) {
  return test.server.inject({
    method: "GET",
    url: "/api/instance/features",
    headers: bearer(token),
  });
}

function turn(test: Test, feature: string, on: boolean, token = test.token) {
  return test.server.inject({
    method: "PUT",
    url: `/api/instance/features/${feature}`,
    headers: bearer(token),
    payload: { on },
  });
}

/** Someone in the workspace, with an account of their own but no admin's. */
async function member(test: Test): Promise<string> {
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
  return accepted.json<{ token: string }>().token;
}

describe("the console's features", () => {
  it("lists every feature, each off until turned on, and which this build has", async () => {
    const test = await start();
    const response = await features(test);
    expect(response.statusCode).toBe(200);
    const listed = response.json<{ features: { feature: string }[] }>().features;
    expect(listed.map((state) => state.feature)).toEqual([...enterpriseFeatures]);
    expect(listed).toContainEqual({ feature: "audit", on: false, pinned: null, available: true });
    expect(listed).toContainEqual({ feature: "sso", on: false, pinned: null, available: false });
  });

  it("turns a feature on at once, its routes answering, and off again", async () => {
    const test = await start();
    const ping = () => test.server.inject({ method: "GET", url: "/api/audit/ping" });
    expect((await ping()).statusCode).toBe(404);

    const on = await turn(test, "audit", true);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ feature: "audit", on: true, pinned: null, available: true });
    expect((await ping()).json()).toEqual({ pong: true });
    const health = await test.server.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({ enterprise: { audit: true, sso: false } });

    await turn(test, "audit", false);
    expect((await ping()).statusCode).toBe(404);
  });

  it("leaves a feature the environment pins to it", async () => {
    const test = await start({ NETHER_ENTERPRISE_AUDIT: "on" });
    expect((await test.server.inject({ method: "GET", url: "/api/audit/ping" })).statusCode).toBe(
      200,
    );
    const refused = await turn(test, "audit", false);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      message: "NETHER_ENTERPRISE_AUDIT sets it: change it there.",
    });
    expect((await features(test)).json<{ features: unknown[] }>().features).toContainEqual({
      feature: "audit",
      on: true,
      pinned: "on",
      available: true,
    });
  });

  it("turns on no feature this build has no module for, nor one with no name", async () => {
    const test = await start();
    const refused = await turn(test, "sso", true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ message: "This build of Nether has no sso module." });
    expect((await turn(test, "telemetry", true)).statusCode).toBe(404);
  });

  it("are an instance admin's alone", async () => {
    const test = await start();
    const bea = await member(test);
    expect((await features(test, bea)).statusCode).toBe(403);
    expect((await turn(test, "audit", true, bea)).statusCode).toBe(403);
    expect(
      (await test.server.inject({ method: "GET", url: "/api/instance/features" })).statusCode,
    ).toBe(401);
  });
});

describe("EnterpriseSwitches", () => {
  /** A database that answers the switches' read, counting each one. */
  function stub(values: Record<string, boolean>) {
    const reads = { count: 0 };
    const db = {
      query: () => {
        reads.count++;
        return Promise.resolve({
          rows: Object.entries(values).map(([key, value]) => ({ key, value })),
        });
      },
    } as unknown as Database;
    return { db, reads };
  }

  const none = Object.fromEntries(enterpriseFeatures.map((feature) => [feature, undefined]));

  it("keeps the console's choice a few seconds, then reads it again", async () => {
    const { db, reads } = stub({ "enterprise.audit": true });
    const switches = new EnterpriseSwitches(db, { ...none } as never, ["audit"]);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await switches.on("audit")).toBe(true);
    expect(await switches.on("audit")).toBe(true);
    expect(reads.count).toBe(1);
    now.mockReturnValue(1_006_000);
    await switches.on("audit");
    expect(reads.count).toBe(2);
  });

  it("asks the database nothing for a feature pinned, or one with no module", async () => {
    const { db, reads } = stub({});
    const switches = new EnterpriseSwitches(db, { ...none, audit: false } as never, ["audit"]);
    expect(await switches.on("audit")).toBe(false);
    expect(await switches.on("sso")).toBe(false);
    expect(reads.count).toBe(0);
  });
});

describe("high availability and a module's startup", () => {
  /** A module of the `ha` feature that says when it starts and closes. */
  function haOf(said: string[], fails = false): EnterpriseModule {
    return {
      feature: "ha",
      plugin: () => Promise.resolve(),
      startup: ({ config }) => {
        said.push(`started on ${config.nodeName}`);
        if (fails) return Promise.reject(new Error("Several nodes need NETHER_REDIS_URL."));
        return Promise.resolve({
          bus: new ProcessBus(),
          close: () => {
            said.push("closed");
            return Promise.resolve();
          },
        });
      },
    };
  }

  it("is off unless the environment says on, and the console cannot turn it on", async () => {
    const said: string[] = [];
    const test = await start({}, [audit, haOf(said)]);
    expect((await features(test)).json<{ features: unknown[] }>().features).toContainEqual({
      feature: "ha",
      on: false,
      pinned: "off",
      available: true,
    });
    const refused = await turn(test, "ha", true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      message: "NETHER_ENTERPRISE_HA sets it: change it there.",
    });
    expect(said).toEqual([]);
    const none = Object.fromEntries(enterpriseFeatures.map((feature) => [feature, undefined]));
    const switches = new EnterpriseSwitches(test.db, { ...none, ha: false } as never, ["ha"]);
    await expect(switches.set("ha", true)).rejects.toThrow("NETHER_ENTERPRISE_HA sets ha");
  });

  it("runs the module's startup when the environment says on, and closes it as the server closes", async () => {
    const said: string[] = [];
    const test = await start({ NETHER_ENTERPRISE_HA: "on", NETHER_NODE_NAME: "web-1" }, [
      audit,
      haOf(said),
    ]);
    expect(said).toEqual(["started on web-1"]);
    expect((await test.server.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
      enterprise: { ha: true },
    });
    await test.close();
    running = undefined;
    expect(said).toEqual(["started on web-1", "closed"]);
  });

  it("stops the server when the startup fails, saying why", async () => {
    await expect(
      startServer({ env: { NETHER_ENTERPRISE_HA: "on" }, enterpriseModules: [haOf([], true)] }),
    ).rejects.toThrow("Several nodes need NETHER_REDIS_URL.");
  });
});
