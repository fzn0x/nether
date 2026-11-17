// The admin console's Usage page (ADR 0079): nothing while the `admin`
// feature is off, then the server's counts, to instance admins alone.
import { randomUUID } from "node:crypto";
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

async function start(env: Record<string, string> = {}): Promise<Test> {
  const server = await startServer({ env, enterpriseModules: [adminModule] });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

function usage(test: Test, token = test.token) {
  return test.server.inject({ method: "GET", url: "/api/admin/usage", headers: bearer(token) });
}

describe("the console's usage", () => {
  it("answers nothing while the admin console is off", async () => {
    const test = await start();
    expect((await usage(test)).statusCode).toBe(404);
  });

  it("counts the server's accounts, workspaces, notes and attachments", async () => {
    const test = await start({ NETHER_ENTERPRISE_ADMIN: "on" });
    // A note, its comments and two vault documents: one note.
    const note = randomUUID();
    for (const name of [note, `${note}.comments`, "vault", `vault.${randomUUID()}`]) {
      await test.db.query(
        "INSERT INTO documents (workspace_id, name, state, seq) VALUES ($1, $2, $3, 1)",
        [test.workspaceId, name, Buffer.from([0])],
      );
    }
    await test.db.query(
      "INSERT INTO attachments (workspace_id, hash, size) VALUES ($1, $2, 2048), ($1, $3, 1024)",
      [test.workspaceId, "a".repeat(64), "b".repeat(64)],
    );
    const response = await usage(test);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accounts: 1,
      activeAccounts: 1,
      workspaces: 1,
      encryptedWorkspaces: 0,
      notes: 1,
      attachments: 2,
      attachmentBytes: 3072,
    });
    expect(response.json<{ version: string }>().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is an instance admin's alone", async () => {
    const test = await start({ NETHER_ENTERPRISE_ADMIN: "on" });
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
    // A workspace's admin is no instance admin.
    expect((await usage(test, accepted.json<{ token: string }>().token)).statusCode).toBe(403);
    expect((await test.server.inject({ method: "GET", url: "/api/admin/usage" })).statusCode).toBe(
      401,
    );
  });
});
