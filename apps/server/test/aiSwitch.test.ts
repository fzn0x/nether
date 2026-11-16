// The switch that turns AI off for a workspace (ADR 0068): on until an
// owner or admin turns it off, told to every member with their workspaces,
// and changed by no one else.
import { afterEach, describe, expect, it } from "vitest";
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

/** Someone invited at a role, with an account of their own. */
async function join(test: Test, role: "admin" | "member", name: string): Promise<string> {
  const invited = await test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/invitations`,
    headers: bearer(test.token),
    payload: { role },
  });
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: invited.json<{ token: string }>().token,
      name,
      email: `${name.toLowerCase()}@example.org`,
      password: `${name}'s long password`,
    },
  });
  return accepted.json<{ token: string }>().token;
}

async function aiOf(test: Test, token: string): Promise<unknown> {
  const me = await test.server.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
  return me
    .json<{ workspaces: { id: string; ai: unknown }[] }>()
    .workspaces.find((workspace) => workspace.id === test.workspaceId)?.ai;
}

function setAi(test: Test, token: string, body: unknown, workspace = test.workspaceId) {
  return test.server.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspace}`,
    headers: bearer(token),
    payload: body as Record<string, unknown>,
  });
}

describe("the AI switch of a workspace", () => {
  it("is on until an owner or admin turns it off, and every member is told", async () => {
    const test = await start();
    const member = await join(test, "member", "Mia");
    const admin = await join(test, "admin", "Abe");
    expect(await aiOf(test, test.token)).toBe(true);
    expect(await aiOf(test, member)).toBe(true);

    const off = await setAi(test, test.token, { ai: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ id: test.workspaceId, ai: false });
    expect(await aiOf(test, member)).toBe(false);
    expect(await aiOf(test, admin)).toBe(false);

    expect((await setAi(test, admin, { ai: true })).statusCode).toBe(200);
    expect(await aiOf(test, member)).toBe(true);

    // A workspace made later starts with it on.
    const made = await test.server.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(test.token),
      payload: { name: "Later" },
    });
    expect(made.json()).toMatchObject({ name: "Later", ai: true });
  });

  it("is changed by no member, guest or outsider, and only to on or off", async () => {
    const test = await start();
    const member = await join(test, "member", "Mia");
    const refused = await setAi(test, member, { ai: false });
    expect(refused.statusCode).toBe(403);
    expect(await aiOf(test, test.token)).toBe(true);

    const elsewhere = await test.server.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(member),
      payload: { name: "Mia's own" },
    });
    const theirs = elsewhere.json<{ id: string }>().id;
    expect((await setAi(test, test.token, { ai: false }, theirs)).statusCode).toBe(404);

    expect((await setAi(test, test.token, { ai: "off" })).statusCode).toBe(400);
    expect((await setAi(test, test.token, {})).statusCode).toBe(400);
    const unsigned = await test.server.inject({
      method: "PATCH",
      url: `/api/workspaces/${test.workspaceId}`,
      payload: { ai: false },
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
