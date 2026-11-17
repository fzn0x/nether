// AI providers the server keeps for the web app (ADR 0070): an account's
// own and the instance's, the admin's; keys sealed at rest and never given
// back; addresses checked as they are kept; and the admin's settings.
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config.ts";
import { readBytes, readText } from "../src/db.ts";
import { sealWith } from "../src/secrets.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Test = TestServer & SetUp;

export const secretKey = Buffer.alloc(32, 7).toString("base64");

async function start(env: Record<string, string> = {}): Promise<Test> {
  running = await startServer({
    env: { NETHER_SECRET_KEY: secretKey, NETHER_AI_PRIVATE: "loopback", ...env },
  });
  return { ...running, ...(await setUp(running)) };
}

/** Someone in the workspace, with an account of their own. */
async function member(test: Test, name: string): Promise<string> {
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
      name,
      email: `${name.toLowerCase()}@example.org`,
      password: `${name}'s long password`,
    },
  });
  return accepted.json<{ token: string }>().token;
}

function call(
  test: Test,
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) {
  return test.server.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface Listed {
  readonly mode: string;
  readonly keepsKeys: boolean;
  readonly manage: { readonly own: boolean; readonly instance: boolean };
  readonly providers: {
    readonly id: string;
    readonly name: string;
    readonly scope: string;
    readonly hasKey: boolean;
  }[];
  readonly default: string;
}

const local = {
  name: "Team model",
  kind: "openai",
  url: "http://127.0.0.1:11434/v1/",
  model: "llama3.2",
};
const remote = {
  name: "Mine",
  kind: "anthropic",
  url: "https://api.anthropic.com",
  model: "claude-haiku-5-5",
};

describe("the server's AI providers", () => {
  it("keeps the instance's and each account's own, keys sealed and never given back", async () => {
    const test = await start();
    const mia = await member(test, "Mia");
    const empty = (await call(test, test.token, "GET", "/api/ai")).json<Listed>();
    expect(empty).toEqual({
      mode: "on",
      keepsKeys: true,
      manage: { own: true, instance: true },
      providers: [],
      default: "",
    });

    const made = await call(test, test.token, "POST", "/api/ai/providers", {
      ...local,
      scope: "instance",
      key: "sk-team-secret",
    });
    expect(made.statusCode).toBe(201);
    const team = made.json<{ id: string }>();
    expect(made.json()).toEqual({
      id: team.id,
      name: "Team model",
      kind: "openai",
      url: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      hasKey: true,
      scope: "instance",
    });
    const own = await call(test, mia, "POST", "/api/ai/providers", {
      ...remote,
      key: "sk-ant-mia",
    });
    expect(own.statusCode).toBe(201);
    const mine = own.json<{ id: string }>();

    // Mia sees the instance's, then her own; Ada sees no one's but hers and the instance's.
    const listed = (await call(test, mia, "GET", "/api/ai")).json<Listed>();
    expect(listed.manage).toEqual({ own: true, instance: false });
    expect(listed.providers.map((each) => [each.name, each.scope, each.hasKey])).toEqual([
      ["Team model", "instance", true],
      ["Mine", "own", true],
    ]);
    expect(listed.default).toBe(team.id);
    const ada = (await call(test, test.token, "GET", "/api/ai")).json<Listed>();
    expect(ada.providers.map((each) => each.name)).toEqual(["Team model"]);
    expect(JSON.stringify([listed, ada])).not.toContain("sk-");

    // The key is sealed at rest, bound to its provider.
    const { rows } = await test.db.query(
      "SELECT id, key_box FROM ai_providers ORDER BY created_at",
    );
    for (const row of rows) {
      const box = readBytes(row, "key_box");
      expect(Buffer.from(box).toString("utf8")).not.toContain("sk-");
      const opened = sealWith(Buffer.from(secretKey, "base64")).open(box, readText(row, "id"));
      expect(opened.startsWith("sk-")).toBe(true);
    }

    // Her own default, then back to the first when it goes.
    expect(
      (await call(test, mia, "PUT", "/api/ai/default", { provider: mine.id })).statusCode,
    ).toBe(204);
    expect((await call(test, mia, "GET", "/api/ai")).json<Listed>().default).toBe(mine.id);
    expect(
      (await call(test, test.token, "PUT", "/api/ai/default", { provider: mine.id })).statusCode,
    ).toBe(404);
    expect((await call(test, mia, "DELETE", `/api/ai/providers/${mine.id}`)).statusCode).toBe(204);
    expect((await call(test, mia, "GET", "/api/ai")).json<Listed>().default).toBe(team.id);
  });

  it("lets only an account change its own, and only an admin the instance's", async () => {
    const test = await start();
    const mia = await member(test, "Mia");
    const team = (
      await call(test, test.token, "POST", "/api/ai/providers", { ...local, scope: "instance" })
    ).json<{ id: string }>();
    expect(
      (await call(test, mia, "POST", "/api/ai/providers", { ...local, scope: "instance" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(test, mia, "PATCH", `/api/ai/providers/${team.id}`, { model: "x" })).statusCode,
    ).toBe(404);
    expect((await call(test, mia, "DELETE", `/api/ai/providers/${team.id}`)).statusCode).toBe(404);
    // Anyone may use it as their default.
    expect(
      (await call(test, mia, "PUT", "/api/ai/default", { provider: team.id })).statusCode,
    ).toBe(204);

    const own = (
      await call(test, mia, "POST", "/api/ai/providers", { ...remote, key: "sk-1" })
    ).json<{ id: string }>();
    expect(
      (await call(test, test.token, "PATCH", `/api/ai/providers/${own.id}`, { model: "x" }))
        .statusCode,
    ).toBe(404);
    // A change keeps the key, unless it says otherwise.
    const renamed = await call(test, mia, "PATCH", `/api/ai/providers/${own.id}`, {
      model: "claude-sonnet-5-5",
    });
    expect(renamed.json()).toMatchObject({ model: "claude-sonnet-5-5", hasKey: true });
    const keyless = await call(test, mia, "PATCH", `/api/ai/providers/${own.id}`, { key: null });
    expect(keyless.json()).toMatchObject({ hasKey: false });
    const keyed = await call(test, mia, "PATCH", `/api/ai/providers/${own.id}`, { key: "sk-2" });
    expect(keyed.json()).toMatchObject({ hasKey: true });
    expect((await call(test, mia, "PATCH", `/api/ai/providers/${own.id}`, {})).statusCode).toBe(
      400,
    );
  });

  it("keeps an account's own at public addresses over https, and the admin's where allowed", async () => {
    const test = await start();
    const mia = await member(test, "Mia");
    for (const url of [
      "http://api.example.org/v1",
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://10.0.0.2/v1",
      "https://user:pw@api.example.org/v1",
      "https://api.example.org/v1?key=1",
      "ftp://api.example.org",
      "not an address",
    ]) {
      const refused = await call(test, mia, "POST", "/api/ai/providers", { ...remote, url });
      expect(refused.statusCode, url).toBe(400);
    }
    // The admin's may reach the loopback address NETHER_AI_PRIVATE allows, and no other.
    expect(
      (await call(test, test.token, "POST", "/api/ai/providers", { ...local, scope: "instance" }))
        .statusCode,
    ).toBe(201);
    const elsewhere = await call(test, test.token, "POST", "/api/ai/providers", {
      ...local,
      scope: "instance",
      url: "http://10.0.0.2:11434/v1",
    });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json<{ message: string }>().message).toContain("NETHER_AI_PRIVATE");
  });

  it("keeps no keys without NETHER_SECRET_KEY, and follows NETHER_AI", async () => {
    const test = await start({ NETHER_SECRET_KEY: "", NETHER_AI_PRIVATE: "off" });
    expect((await call(test, test.token, "GET", "/api/ai")).json<Listed>().keepsKeys).toBe(false);
    const keyed = await call(test, test.token, "POST", "/api/ai/providers", {
      ...remote,
      key: "sk-1",
    });
    expect(keyed.statusCode).toBe(409);
    expect(keyed.json<{ message: string }>().message).toContain("NETHER_SECRET_KEY");
    expect((await call(test, test.token, "POST", "/api/ai/providers", remote)).statusCode).toBe(
      201,
    );
    // No private address at all without NETHER_AI_PRIVATE, nor plain http.
    expect(
      (await call(test, test.token, "POST", "/api/ai/providers", { ...local, scope: "instance" }))
        .statusCode,
    ).toBe(400);
    await running?.close();

    const adminOnly = await start({ NETHER_AI: "admin" });
    const mia = await member(adminOnly, "Mia");
    expect((await call(adminOnly, mia, "POST", "/api/ai/providers", remote)).statusCode).toBe(403);
    expect((await call(adminOnly, mia, "GET", "/api/ai")).json<Listed>().manage).toEqual({
      own: false,
      instance: false,
    });
    expect(
      (
        await call(adminOnly, adminOnly.token, "POST", "/api/ai/providers", {
          ...local,
          scope: "instance",
        })
      ).statusCode,
    ).toBe(201);
    expect((await call(adminOnly, mia, "GET", "/api/ai")).json<Listed>().providers).toHaveLength(1);
    await running?.close();

    const none = await start({ NETHER_AI: "off" });
    expect((await call(none, none.token, "GET", "/api/ai")).json<Listed>()).toMatchObject({
      mode: "off",
      providers: [],
    });
    expect(
      (await call(none, none.token, "POST", "/api/ai/providers", { ...local, scope: "instance" }))
        .statusCode,
    ).toBe(403);
    running = undefined;
    await none.close();
  });
});

describe("the server's AI settings", () => {
  const database = { NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether" };

  it("reads NETHER_AI, NETHER_AI_PRIVATE and NETHER_SECRET_KEY", () => {
    expect(readConfig(database)).toMatchObject({ ai: "on", aiPrivate: false, secretKey: null });
    const read = readConfig({
      ...database,
      NETHER_AI: " Admin ",
      NETHER_AI_PRIVATE: "loopback, 192.168.1.20",
      NETHER_SECRET_KEY: secretKey,
    });
    expect(read.ai).toBe("admin");
    expect(read.aiPrivate).toEqual(["loopback", "192.168.1.20"]);
    expect(read.secretKey?.length).toBe(32);
    expect(readConfig({ ...database, NETHER_AI: "off" }).ai).toBe("off");
  });

  it.each([
    [{ NETHER_AI: "maybe" }, "NETHER_AI must be on, admin or off"],
    [{ NETHER_AI_PRIVATE: "ollama.internal" }, "NETHER_AI_PRIVATE must be on, off"],
    [{ NETHER_SECRET_KEY: "too short" }, "NETHER_SECRET_KEY must be 32 random bytes in base64"],
    [{ NETHER_SECRET_KEY: Buffer.alloc(16).toString("base64") }, "NETHER_SECRET_KEY must be 32"],
  ])("refuses %j", (env, message) => {
    expect(() => readConfig({ ...database, ...env })).toThrow(ConfigError);
    expect(() => readConfig({ ...database, ...env })).toThrow(message);
  });
});
