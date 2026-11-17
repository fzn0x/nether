// The console's data policies (ADR 0088): the policy for every workspace,
// and each workspace an instance admin sets apart, while the `policies`
// feature is on. What the server does under them is core's, tested in
// apps/server/test/dataPolicies.test.ts.
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  startServer,
} from "@nether/server/test/app.ts";
import { afterEach, describe, expect, it } from "vitest";
import { policiesModule } from "../src/index.ts";

type Test = TestServer & SetUp & { close(): Promise<void> };
let running: Test | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(env: Record<string, string> = { NETHER_ENTERPRISE_POLICIES: "on" }) {
  const server = await startServer({ env, enterpriseModules: [policiesModule] });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

const open = { shareLinks: "on", sites: true, export: true };
const closed = { shareLinks: "off", sites: false, export: false };

function call(test: Test, method: string, url: string, payload?: object, token = test.token) {
  return test.server.inject({
    method: method as "GET",
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface State {
  every: object;
  apart: { workspace: string; name: string; policy: object }[];
  others: { workspace: string; name: string }[];
}

describe("the console's data policies", () => {
  it("answer nothing while the policies feature is off", async () => {
    const test = await start({});
    expect((await call(test, "GET", "/api/admin/data-policies")).statusCode).toBe(404);
    expect((await call(test, "PUT", "/api/admin/data-policies", closed)).statusCode).toBe(404);
  });

  it("set every workspace's policy, and one workspace's apart from it", async () => {
    const test = await start();
    const first = (await call(test, "GET", "/api/admin/data-policies")).json<State>();
    expect(first).toEqual({
      every: open,
      apart: [],
      others: [{ workspace: test.workspaceId, name: expect.any(String) as string }],
    });

    const every = await call(test, "PUT", "/api/admin/data-policies", {
      ...open,
      shareLinks: "view",
    });
    expect(every.statusCode).toBe(200);
    expect(every.json<State>().every).toEqual({ ...open, shareLinks: "view" });

    const apart = await call(
      test,
      "PUT",
      `/api/admin/data-policies/workspaces/${test.workspaceId}`,
      closed,
    );
    expect(apart.statusCode).toBe(200);
    expect(apart.json<State>().apart).toEqual([
      { workspace: test.workspaceId, name: expect.any(String) as string, policy: closed },
    ]);
    expect(apart.json<State>().others).toEqual([]);

    const back = await call(
      test,
      "DELETE",
      `/api/admin/data-policies/workspaces/${test.workspaceId}`,
    );
    expect(back.json<State>().apart).toEqual([]);
    expect(
      (await call(test, "DELETE", `/api/admin/data-policies/workspaces/${test.workspaceId}`))
        .statusCode,
    ).toBe(404);
  });

  it("refuse a policy they do not know, and a workspace there is not", async () => {
    const test = await start();
    const unknown = await call(test, "PUT", "/api/admin/data-policies", {
      ...open,
      shareLinks: "sometimes",
    });
    expect(unknown.statusCode).toBe(400);
    expect(
      (await call(test, "PUT", "/api/admin/data-policies", { shareLinks: "on" })).statusCode,
    ).toBe(400);
    const nowhere = await call(
      test,
      "PUT",
      "/api/admin/data-policies/workspaces/00000000-0000-4000-8000-000000000000",
      open,
    );
    expect(nowhere.statusCode).toBe(404);
  });

  it("are an instance admin's alone", async () => {
    const test = await start();
    // A workspace's admin, not the server's.
    const invited = await call(test, "POST", `/api/workspaces/${test.workspaceId}/invitations`, {
      role: "admin",
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
    const bea = accepted.json<{ token: string }>().token;
    expect(bea).toEqual(expect.any(String));
    expect((await call(test, "GET", "/api/admin/data-policies", undefined, bea)).statusCode).toBe(
      403,
    );
    expect(
      (
        await call(
          test,
          "PUT",
          `/api/admin/data-policies/workspaces/${test.workspaceId}`,
          open,
          bea,
        )
      ).statusCode,
    ).toBe(403);
  });
});
