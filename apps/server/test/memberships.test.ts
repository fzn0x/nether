// A membership's own role and its groups' (ADR 0085): rows made before keep
// what they have; a group mapped to a workspace places its members, raises
// a role, and takes back only what it gave, with the member's sealed keys
// and grants when it was all; owners raise a member above its groups but
// not below, nor remove it, and it may not leave; and accepting an
// invitation makes a group's place the member's own.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterpriseModule, EnterpriseServices } from "../src/enterprise.ts";
import { type ServerEvent, fromServer } from "../src/events.ts";
import { type Settler, settleMembership, settleMemberships } from "../src/members.ts";
import { newToken, tokenHash } from "../src/sessions.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

type Test = TestServer &
  SetUp & {
    readonly services: EnterpriseServices;
    readonly told: ServerEvent[];
  };

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const okta = { kind: "directory", id: "okta", name: "Okta" } as const;

async function start(): Promise<Test> {
  let services: EnterpriseServices | undefined;
  const capture: EnterpriseModule = {
    feature: "scim",
    plugin: (_app, context) => {
      services = context;
      return Promise.resolve();
    },
  };
  running = await startServer({ enterpriseModules: [capture] });
  if (services === undefined) throw new Error("The module was not registered.");
  const told: ServerEvent[] = [];
  services.events.listen((event) => {
    told.push(event);
    return Promise.resolve();
  });
  const test = { ...running, ...(await setUp(running)), services, told };
  await test.db.query("INSERT INTO directories (id, kind, name) VALUES ('okta', 'scim', 'Okta')");
  return test;
}

async function join(test: Test, name: string, role: "admin" | "member" = "member") {
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

/** An account no workspace has yet, as a directory makes one. */
async function account(test: Test, name: string): Promise<string> {
  const id = randomUUID();
  const email = `${name.toLowerCase()}@example.org`;
  await test.db.query("INSERT INTO users (id, email, email_key, name) VALUES ($1, $2, $2, $3)", [
    id,
    email,
    name,
  ]);
  return id;
}

/** A group of the directory's, mapped to the workspace at a role. */
async function group(test: Test, name: string, role: "owner" | "admin" | "member") {
  const id = randomUUID();
  await test.db.query("INSERT INTO groups (id, directory_id, name) VALUES ($1, 'okta', $2)", [
    id,
    name,
  ]);
  await test.db.query(
    "INSERT INTO group_workspaces (group_id, workspace_id, role) VALUES ($1, $2, $3)",
    [id, test.workspaceId, role],
  );
  return { id, name };
}

function by(groupName?: { id: string; name: string }): Settler {
  return {
    actor: okta,
    origin: fromServer,
    ...(groupName === undefined ? {} : { group: groupName }),
  };
}

async function add(test: Test, groupId: string, user: string) {
  await test.db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [
    groupId,
    user,
  ]);
}

async function drop(test: Test, groupId: string, user: string) {
  await test.db.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [
    groupId,
    user,
  ]);
}

function settle(test: Test, user: string, groupName?: { id: string; name: string }) {
  return test.db.transaction((tx) =>
    settleMembership(tx, test.workspaceId, user, by(groupName), test.services.events),
  );
}

async function place(test: Test, user: string) {
  const { rows } = await test.db.query(
    "SELECT role, own_role FROM memberships WHERE workspace_id = $1 AND user_id = $2",
    [test.workspaceId, user],
  );
  return rows[0] ?? null;
}

function call(test: Test, method: "PATCH" | "DELETE", user: string, token: string, role?: string) {
  return test.server.inject({
    method,
    url: `/api/workspaces/${test.workspaceId}/members/${user}`,
    headers: bearer(token),
    ...(role === undefined ? {} : { payload: { role } }),
  });
}

describe("a membership's own role and its groups'", () => {
  it("keeps rows made before as they are, with no group", async () => {
    const test = await start();
    const bea = await join(test, "Bea", "admin");
    expect(await place(test, bea.id)).toEqual({ role: "admin", own_role: null });
    expect(await settle(test, bea.id)).toBe("same");
    expect(await settle(test, test.userId)).toBe("same");
    expect(await place(test, bea.id)).toEqual({ role: "admin", own_role: null });
    // Settling someone with no place and no group gives them none.
    const cal = await account(test, "Cal");
    expect(await settle(test, cal)).toBe("same");
    expect(await place(test, cal)).toBeNull();
    expect(test.told.filter((event) => event.action.startsWith("member."))).toEqual([
      expect.objectContaining({ action: "member.joined" }),
    ]);
  });

  it("places a group's members, raises a role, and takes back only what it gave", async () => {
    const test = await start();
    const staff = await group(test, "Staff", "admin");
    const cal = await join(test, "Cal");
    const dee = await account(test, "Dee");
    test.told.length = 0;

    // Dee joins by the group alone; Cal, a member, is raised to admin.
    await add(test, staff.id, dee);
    await add(test, staff.id, cal.id);
    const changed = await test.db.transaction((tx) =>
      settleMemberships(
        tx,
        [
          { workspace: test.workspaceId, user: dee },
          { workspace: test.workspaceId, user: cal.id },
          { workspace: test.workspaceId, user: dee },
        ],
        by(staff),
        test.services.events,
      ),
    );
    expect([...changed].sort()).toEqual([cal.id, dee].sort());
    expect(await place(test, dee)).toEqual({ role: "admin", own_role: "none" });
    expect(await place(test, cal.id)).toEqual({ role: "admin", own_role: "member" });
    const via = { via: "group", group: { id: staff.id, name: "Staff" } };
    expect(test.told).toEqual(
      expect.arrayContaining([
        {
          action: "member.joined",
          actor: okta,
          workspace: test.workspaceId,
          target: { type: "account", id: dee },
          details: { role: "admin", ...via },
        },
        {
          action: "member.role_changed",
          actor: okta,
          workspace: test.workspaceId,
          target: { type: "account", id: cal.id },
          details: { from: "member", to: "admin", ...via },
        },
      ]),
    );
    expect(test.told).toHaveLength(2);

    // A second group, giving less, changes nothing; the first going leaves Cal his own role.
    const readers = await group(test, "Readers", "member");
    await add(test, readers.id, cal.id);
    expect(await settle(test, cal.id, readers)).toBe("same");
    await drop(test, staff.id, cal.id);
    expect(await settle(test, cal.id, staff)).toBe("changed");
    expect(await place(test, cal.id)).toEqual({ role: "member", own_role: null });
    await drop(test, readers.id, cal.id);
    expect(await settle(test, cal.id, readers)).toBe("same");
    expect(await place(test, cal.id)).toEqual({ role: "member", own_role: null });

    // Dee, placed by the group alone, leaves with it, and so do her keys and grants.
    await test.db.query(
      "INSERT INTO workspace_keys (workspace_id, user_id, version, sealed_key) VALUES ($1, $2, 1, $3)",
      [test.workspaceId, dee, new Uint8Array([1])],
    );
    const teamspace = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/teamspaces`,
      headers: bearer(test.token),
      payload: { name: "Design" },
    });
    const unit = teamspace.json<{ id: string }>().id;
    await test.db.query(
      "INSERT INTO unit_grants (unit_id, user_id, level) VALUES ($1, $2, 'edit')",
      [unit, dee],
    );
    test.told.length = 0;
    await drop(test, staff.id, dee);
    expect(await settle(test, dee, staff)).toBe("removed");
    expect(await place(test, dee)).toBeNull();
    const kept = await test.db.query(
      `SELECT (SELECT count(*)::int FROM workspace_keys WHERE user_id = $1) AS keys,
              (SELECT count(*)::int FROM unit_grants WHERE user_id = $1) AS grants`,
      [dee],
    );
    expect(kept.rows).toEqual([{ keys: 0, grants: 0 }]);
    expect(test.told).toEqual([
      {
        action: "member.removed",
        actor: okta,
        workspace: test.workspaceId,
        target: { type: "account", id: dee },
        details: { role: "admin", ...via },
      },
    ]);
  });

  it("lets owners raise a member above its groups, not lower or remove it, and it may not leave", async () => {
    const test = await start();
    const staff = await group(test, "Staff", "admin");
    const bea = await join(test, "Bea");
    const ann = await join(test, "Ann", "admin");
    await add(test, staff.id, bea.id);
    await settle(test, bea.id, staff);
    expect(await place(test, bea.id)).toEqual({ role: "admin", own_role: "member" });

    const lower = await call(test, "PATCH", bea.id, test.token, "member");
    expect(lower.statusCode).toBe(409);
    expect(lower.json<{ message: string }>().message).toBe(
      "The group Staff gives them the admin role here: only their directory changes that.",
    );
    const removed = await call(test, "DELETE", bea.id, test.token);
    expect(removed.statusCode).toBe(409);
    expect(removed.json<{ message: string }>().message).toBe(
      "The group Staff gives them a place here: only their directory takes it.",
    );
    const left = await call(test, "DELETE", bea.id, bea.token);
    expect(left.statusCode).toBe(409);
    expect(left.json<{ message: string }>().message).toBe(
      "The group Staff gives you a place here: only your directory takes it.",
    );
    // An admin may not touch another admin, group or not.
    expect((await call(test, "PATCH", bea.id, ann.token, "member")).statusCode).toBe(403);

    // Raised above the group, the role is Bea's own, and stays when the group goes.
    expect((await call(test, "PATCH", bea.id, test.token, "owner")).statusCode).toBe(200);
    expect(await place(test, bea.id)).toEqual({ role: "owner", own_role: null });
    await drop(test, staff.id, bea.id);
    expect(await settle(test, bea.id, staff)).toBe("same");
    expect(await place(test, bea.id)).toEqual({ role: "owner", own_role: null });
    // With no group left, she may be removed as anyone is.
    expect((await call(test, "PATCH", bea.id, test.token, "member")).statusCode).toBe(200);
    expect((await call(test, "DELETE", bea.id, test.token)).statusCode).toBe(204);
  });

  it("makes a group's place the member's own when they accept an invitation", async () => {
    const test = await start();
    const staff = await group(test, "Staff", "admin");
    const readers = await group(test, "Readers", "member");
    const bea = await join(test, "Bea");
    // Bea leaves, then comes back by a group alone.
    expect((await call(test, "DELETE", bea.id, bea.token)).statusCode).toBe(204);
    await add(test, readers.id, bea.id);
    expect(await settle(test, bea.id, readers)).toBe("joined");
    expect(await place(test, bea.id)).toEqual({ role: "member", own_role: "none" });

    const accept = async (role: "admin" | "member") => {
      const invited = await test.server.inject({
        method: "POST",
        url: `/api/workspaces/${test.workspaceId}/invitations`,
        headers: bearer(test.token),
        payload: { role },
      });
      const accepted = await test.server.inject({
        method: "POST",
        url: "/api/invitations/accept",
        headers: bearer(bea.token),
        payload: { token: invited.json<{ token: string }>().token },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
    };
    await accept("member");
    expect(await place(test, bea.id)).toEqual({ role: "member", own_role: null });
    await drop(test, readers.id, bea.id);
    expect(await settle(test, bea.id, readers)).toBe("same");
    expect(await place(test, bea.id)).toEqual({ role: "member", own_role: null });

    // Placed higher by a group than an invitation's role, the invitation's is kept as her own.
    const cal = await account(test, "Cal");
    await add(test, staff.id, cal);
    await settle(test, cal, staff);
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    // Cal, made by a directory, has no password: he accepts signed in, by a session of his.
    const token = newToken();
    await test.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), cal, tokenHash(token)],
    );
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      headers: bearer(token),
      payload: { token: invited.json<{ token: string }>().token },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await place(test, cal)).toEqual({ role: "admin", own_role: "member" });
    await drop(test, staff.id, cal);
    expect(await settle(test, cal, staff)).toBe("changed");
    expect(await place(test, cal)).toEqual({ role: "member", own_role: null });
  });
});
