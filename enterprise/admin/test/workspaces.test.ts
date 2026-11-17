// The console's Workspaces page (ADR 0083): nothing while the `admin`
// feature is off; then every workspace with its owners, members, notes and
// size, a page at a time; its members; and an instance admin setting a
// member's role, keeping an owner and closing that account's connections.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  startServer,
} from "@nether/server/test/app.ts";
import { freePort } from "@nether/server/test/ports.ts";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkspacePage, type WorkspaceSummary, adminModule } from "../src/index.ts";

type Test = TestServer & SetUp & { close(): Promise<void> };
let running: Test | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await running?.close();
  running = undefined;
});

async function start(env: Record<string, string> = { NETHER_ENTERPRISE_ADMIN: "on" }) {
  const server = await startServer({ env, enterpriseModules: [adminModule] });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

/** Someone invited to the setup's workspace at a role, with an account of their own. */
async function join(test: Test, role: "admin" | "member", name: string) {
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
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { token: body.token, id: body.user.id };
}

/** A workspace made straight in the database, owned by `owner`. */
async function workspace(
  test: Test,
  name: string,
  options: { encrypted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await test.db.query("INSERT INTO workspaces (id, name, encryption) VALUES ($1, $2, $3)", [
    id,
    name,
    options.encrypted === true ? "end-to-end" : "none",
  ]);
  await test.db.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [id, test.userId],
  );
  return id;
}

function list(test: Test, query = "", token = test.token) {
  return test.server.inject({
    method: "GET",
    url: `/api/admin/workspaces${query}`,
    headers: bearer(token),
  });
}

function open(test: Test, id: string, token = test.token) {
  return test.server.inject({
    method: "GET",
    url: `/api/admin/workspaces/${id}`,
    headers: bearer(token),
  });
}

function setRole(test: Test, id: string, user: string, role: string, token = test.token) {
  return test.server.inject({
    method: "PATCH",
    url: `/api/admin/workspaces/${id}/members/${user}`,
    headers: bearer(token),
    payload: { role },
  });
}

function named(page: WorkspacePage, name: string): WorkspaceSummary | undefined {
  return page.workspaces.find((each) => each.name === name);
}

describe("the console's workspaces", () => {
  it("answer nothing while the admin console is off", async () => {
    const test = await start({});
    expect((await list(test)).statusCode).toBe(404);
    expect((await open(test, test.workspaceId)).statusCode).toBe(404);
    expect((await setRole(test, test.workspaceId, test.userId, "owner")).statusCode).toBe(404);
  });

  it("are listed with their owners, members by role, notes and size", async () => {
    const test = await start();
    await join(test, "member", "Bea");
    await join(test, "admin", "Cy");

    // A note, its comments and two vault documents, one of them a space's:
    // one note, in 1 + 2 + 3 + 4 bytes.
    const archive = await workspace(test, "Archive");
    const note = randomUUID();
    const documents = [note, `${note}.comments`, "vault", `vault.${randomUUID()}`];
    for (const [at, name] of documents.entries()) {
      await test.db.query(
        "INSERT INTO documents (workspace_id, name, state, seq) VALUES ($1, $2, $3, $4)",
        [archive, name, Buffer.alloc(at + 1), at + 1],
      );
    }
    await test.db.query(
      "INSERT INTO document_versions (workspace_id, name, state) VALUES ($1, $2, $3)",
      [archive, note, Buffer.alloc(20)],
    );
    await test.db.query(
      "INSERT INTO attachments (workspace_id, hash, size) VALUES ($1, $2, 2048), ($1, $3, 1024)",
      [archive, "a".repeat(64), "b".repeat(64)],
    );
    // An encrypted workspace's updates count as its documents, its notes not at all.
    const sealed = await workspace(test, "Sealed", { encrypted: true });
    await test.db.query(
      "INSERT INTO encrypted_updates (workspace_id, name, seq, data) VALUES ($1, $2, 1, $3)",
      [sealed, randomUUID(), Buffer.alloc(30)],
    );

    const response = await list(test);
    expect(response.statusCode).toBe(200);
    const page = response.json<WorkspacePage>();
    expect(page.workspaces.map((each) => each.name)).toEqual(["Archive", "Sealed", "Team"]);
    expect(page.next).toBeNull();
    expect(named(page, "Archive")).toMatchObject({
      encryption: "none",
      owners: [{ id: test.userId, name: "Ada" }],
      roles: { owner: 1, admin: 0, member: 0, guest: 0 },
      notes: 1,
      bytes: { documents: 10, history: 20, attachments: 3072 },
      attachments: 2,
    });
    expect(named(page, "Archive")?.changedAt).not.toBeNull();
    expect(named(page, "Sealed")).toMatchObject({
      encryption: "end-to-end",
      notes: null,
      bytes: { documents: 30, history: 0, attachments: 0 },
    });
    expect(named(page, "Team")).toMatchObject({
      roles: { owner: 1, admin: 1, member: 1, guest: 0 },
    });
  });

  it("come a page at a time, by name, and are found by their names or a member's", async () => {
    const test = await start();
    await join(test, "member", "Bea");
    for (let at = 1; at <= 55; at++) await workspace(test, `W ${String(at).padStart(3, "0")}`);

    const first = (await list(test)).json<WorkspacePage>();
    expect(first.workspaces).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = (await list(test, `?after=${first.next ?? ""}`)).json<WorkspacePage>();
    // The setup's Team and the 55 made here: Team first, six on the second page.
    expect(first.workspaces[0]?.name).toBe("Team");
    expect(second.workspaces.map((each) => each.name)).toEqual([
      "W 050",
      "W 051",
      "W 052",
      "W 053",
      "W 054",
      "W 055",
    ]);
    expect(second.next).toBeNull();

    const byName = (await list(test, "?search=w%2005")).json<WorkspacePage>();
    expect(byName.workspaces).toHaveLength(6);
    // Bea is in the setup's workspace alone.
    const byMember = (await list(test, "?search=BEA%40example")).json<WorkspacePage>();
    expect(byMember.workspaces.map((each) => each.name)).toEqual(["Team"]);

    expect((await list(test, "?after=not-a-page")).statusCode).toBe(400);
  });

  it("open to their members", async () => {
    const test = await start();
    const bea = await join(test, "member", "Bea");
    const response = await open(test, test.workspaceId);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      workspace: WorkspaceSummary;
      members: { id: string; name: string; role: string; joinedAt: string }[];
    }>();
    expect(body.workspace).toMatchObject({ id: test.workspaceId, name: "Team" });
    expect(body.members.map((member) => [member.name, member.role])).toEqual([
      ["Ada", "owner"],
      ["Bea", "member"],
    ]);
    expect(body.members[1]?.id).toBe(bea.id);
    expect((await open(test, randomUUID())).statusCode).toBe(404);
  });

  it("take an instance admin's role changes, keeping an owner and closing connections", async () => {
    const test = await start();
    const bea = await join(test, "member", "Bea");
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const port = String((test.server.server.address() as AddressInfo).port);
    const relay = new WebSocket(`ws://127.0.0.1:${port}/api/relay`);
    sockets.push(relay);
    await new Promise<void>((resolve) => {
      relay.addEventListener("open", () => {
        relay.send(JSON.stringify({ type: "auth", token: bea.token }));
      });
      relay.addEventListener("message", () => {
        resolve();
      });
    });
    const closed = new Promise<void>((resolve) => {
      relay.addEventListener("close", () => {
        resolve();
      });
    });

    const raised = await setRole(test, test.workspaceId, bea.id, "owner");
    expect(raised.statusCode).toBe(200);
    expect(raised.json()).toEqual({ id: bea.id, role: "owner" });
    // Bea's apps connect again, and are checked anew at her new role.
    await closed;

    // The instance admin steps down in it; Bea is then its only owner.
    expect((await setRole(test, test.workspaceId, test.userId, "member")).statusCode).toBe(200);
    const last = await setRole(test, test.workspaceId, bea.id, "member");
    expect(last.statusCode).toBe(409);
    expect(last.json<{ message: string }>().message).toMatch(/at least one owner/);

    expect((await setRole(test, test.workspaceId, randomUUID(), "owner")).statusCode).toBe(404);
    expect((await setRole(test, test.workspaceId, bea.id, "ruler")).statusCode).toBe(400);
  });

  it("are an instance admin's alone", async () => {
    const test = await start();
    // A workspace's admin is no instance admin.
    const cy = await join(test, "admin", "Cy");
    expect((await list(test, "", cy.token)).statusCode).toBe(403);
    expect((await open(test, test.workspaceId, cy.token)).statusCode).toBe(403);
    expect((await setRole(test, test.workspaceId, cy.id, "owner", cy.token)).statusCode).toBe(403);
    expect(
      (await test.server.inject({ method: "GET", url: "/api/admin/workspaces" })).statusCode,
    ).toBe(401);
  });
});
