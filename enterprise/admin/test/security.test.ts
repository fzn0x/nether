// The console's Security page (ADR 0084): nothing while the `admin`
// feature is off; then each security setting with what pins it, and an
// instance admin's changes, all or none, refused where the environment
// pins a setting or a value is out of range.
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  startServer,
} from "@nether/server/test/app.ts";
import { afterEach, describe, expect, it } from "vitest";
import { adminModule } from "../src/index.ts";

type Test = TestServer & SetUp & { close(): Promise<void> };
let running: Test | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(env: Record<string, string> = { NETHER_ENTERPRISE_ADMIN: "on" }) {
  const server = await startServer({ env, enterpriseModules: [adminModule] });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

interface State {
  readonly name: string;
  readonly value: number | boolean;
  readonly pinnedBy: string | null;
}

function read(test: Test, token = test.token) {
  return test.server.inject({ method: "GET", url: "/api/admin/security", headers: bearer(token) });
}

function change(test: Test, payload: object, token = test.token) {
  return test.server.inject({
    method: "PUT",
    url: "/api/admin/security",
    headers: bearer(token),
    payload,
  });
}

function valueOf(states: readonly State[], name: string) {
  return states.find((state) => state.name === name);
}

describe("the console's security settings", () => {
  it("answer nothing while the admin console is off", async () => {
    const test = await start({});
    expect((await read(test)).statusCode).toBe(404);
    expect((await change(test, { sessionIdleDays: 7 })).statusCode).toBe(404);
  });

  it("show each setting, and what the environment pins", async () => {
    const test = await start({
      NETHER_ENTERPRISE_ADMIN: "on",
      NETHER_SIGN_IN_TRIES_ACCOUNT: "5",
    });
    const response = await read(test);
    expect(response.statusCode).toBe(200);
    const { settings } = response.json<{ settings: State[] }>();
    expect(settings.map((state) => state.name)).toEqual([
      "sessionIdleDays",
      "sessionLifetimeDays",
      "signInTriesAccount",
      "signInTriesAddress",
      "emailCodes",
    ]);
    expect(valueOf(settings, "sessionIdleDays")).toMatchObject({ value: 30, pinnedBy: null });
    expect(valueOf(settings, "signInTriesAccount")).toMatchObject({
      value: 5,
      pinnedBy: "NETHER_SIGN_IN_TRIES_ACCOUNT",
    });
  });

  it("take an instance admin's changes, all or none", async () => {
    const test = await start({
      NETHER_ENTERPRISE_ADMIN: "on",
      NETHER_SIGN_IN_TRIES_ACCOUNT: "5",
    });
    const changed = await change(test, { sessionIdleDays: 7, emailCodes: false });
    expect(changed.statusCode).toBe(200);
    const { settings } = changed.json<{ settings: State[] }>();
    expect(valueOf(settings, "sessionIdleDays")?.value).toBe(7);
    expect(valueOf(settings, "emailCodes")?.value).toBe(false);

    const pinned = await change(test, { sessionIdleDays: 8, signInTriesAccount: 20 });
    expect(pinned.statusCode).toBe(409);
    expect(pinned.json<{ message: string }>().message).toBe(
      "NETHER_SIGN_IN_TRIES_ACCOUNT sets it: change it there.",
    );
    expect((await change(test, { sessionLifetimeDays: 4000 })).statusCode).toBe(400);
    expect((await change(test, { colour: 1 })).statusCode).toBe(400);
    expect((await change(test, { sessionIdleDays: "seven" })).statusCode).toBe(400);
    expect((await change(test, {})).statusCode).toBe(400);
    // None of the refused changes was kept.
    const after = (await read(test)).json<{ settings: State[] }>().settings;
    expect(valueOf(after, "sessionIdleDays")?.value).toBe(7);
    expect(valueOf(after, "sessionLifetimeDays")?.value).toBe(90);
  });

  it("are an instance admin's alone", async () => {
    const test = await start();
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "admin" },
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
    expect((await read(test, bea)).statusCode).toBe(403);
    expect((await change(test, { sessionIdleDays: 7 }, bea)).statusCode).toBe(403);
    expect(
      (await test.server.inject({ method: "GET", url: "/api/admin/security" })).statusCode,
    ).toBe(401);
  });
});
