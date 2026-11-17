// The approved AI endpoints (ADR 0086): the console's routes while the
// `policies` feature is on, and the lock they set: the apps read it in
// /api/me, and the server neither keeps nor relays to a provider elsewhere.
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

const approved = "https://llm.corp.example/v1";

function read(test: Test, token = test.token) {
  return test.server.inject({
    method: "GET",
    url: "/api/admin/ai-endpoints",
    headers: bearer(token),
  });
}

function change(test: Test, endpoints: readonly string[], token = test.token) {
  return test.server.inject({
    method: "PUT",
    url: "/api/admin/ai-endpoints",
    headers: bearer(token),
    payload: { endpoints },
  });
}

function provider(test: Test, url: string) {
  return test.server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: bearer(test.token),
    payload: { name: url, kind: "openai", url, model: "a-model" },
  });
}

async function me(test: Test) {
  return (
    await test.server.inject({ method: "GET", url: "/api/me", headers: bearer(test.token) })
  ).json<{ aiEndpoints: string[] | null }>().aiEndpoints;
}

describe("the console's approved AI endpoints", () => {
  it("answer nothing while the policies feature is off, and lock nothing", async () => {
    const test = await start({});
    expect((await read(test)).statusCode).toBe(404);
    expect((await change(test, [approved])).statusCode).toBe(404);
    expect(await me(test)).toBeNull();
  });

  it("are set by an instance admin, compared as the apps compare them", async () => {
    const test = await start();
    expect((await read(test)).json()).toEqual({ endpoints: [], pinnedBy: null });
    const changed = await change(test, ["HTTPS://LLM.corp.example/v1/", "", approved]);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ endpoints: [approved], pinnedBy: null });
    const refused = await change(test, ["llm.corp.example"]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toBe(
      "llm.corp.example is not an http or https address.",
    );
    expect((await read(test)).json()).toEqual({ endpoints: [approved], pinnedBy: null });
  });

  it("are the environment's when it pins them", async () => {
    const test = await start({ NETHER_ENTERPRISE_POLICIES: "on", NETHER_AI_ENDPOINTS: approved });
    expect((await read(test)).json()).toEqual({
      endpoints: [approved],
      pinnedBy: "NETHER_AI_ENDPOINTS",
    });
    expect((await change(test, [])).statusCode).toBe(409);
    expect(await me(test)).toEqual([approved]);
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
    expect((await change(test, [approved], bea)).statusCode).toBe(403);
  });
});

describe("the lock", () => {
  it("is told to the apps, and keeps providers to the approved endpoints", async () => {
    const test = await start();
    // Made before the lock: kept, but not used once it holds.
    const elsewhere = (await provider(test, "https://api.example.com/v1")).json<{ id: string }>();
    await change(test, [approved]);
    expect(await me(test)).toEqual([approved]);

    const refused = await provider(test, "https://api.example.com/v1");
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ message: string }>().message).toBe(
      `This server's admin allows AI only through ${approved}.`,
    );
    expect((await provider(test, `${approved}/team`)).statusCode).toBe(201);

    const listed = (
      await test.server.inject({ method: "GET", url: "/api/ai", headers: bearer(test.token) })
    ).json<{ endpoints: string[]; providers: { url: string; allowed: boolean }[] }>();
    expect(listed.endpoints).toEqual([approved]);
    expect(listed.providers.map((each) => [each.url, each.allowed])).toEqual([
      ["https://api.example.com/v1", false],
      [`${approved}/team`, true],
    ]);

    const relayed = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/ai/${elsewhere.id}/chat/completions`,
      headers: bearer(test.token),
      payload: { messages: [{ role: "user", content: "Hello" }] },
    });
    expect(relayed.statusCode).toBe(403);

    // An empty list unlocks.
    await change(test, []);
    expect(await me(test)).toBeNull();
  });
});
