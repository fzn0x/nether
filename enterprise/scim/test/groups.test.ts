// A directory's groups (ADR 0085): pushed as Okta and Entra ID document
// it, mapped to workspaces on the console, and the places they give
// settled as their members and mappings change, in one transaction per
// request, the accounts whose place changed disconnected after it.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Test,
  actions,
  addDirectory,
  admin,
  errorSchema,
  join,
  patchSchema,
  scim,
  start,
  stop,
  userSchema,
} from "./server.ts";

afterEach(stop);

const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";

type Directory = Awaited<ReturnType<typeof addDirectory>>;

/** A user the directory makes, by its address. */
async function user(test: Test, directory: Directory, email: string): Promise<string> {
  const made = await scim(test, directory, "POST", "/Users", {
    schemas: [userSchema],
    userName: email,
    displayName: email.split("@")[0],
  });
  if (made.statusCode !== 201) throw new Error(made.body);
  return made.json<{ id: string }>().id;
}

async function group(test: Test, directory: Directory, name: string, members: string[] = []) {
  const made = await scim(test, directory, "POST", "/Groups", {
    schemas: [groupSchema],
    displayName: name,
    members: members.map((value) => ({ value })),
  });
  if (made.statusCode !== 201) throw new Error(made.body);
  return made.json<{ id: string }>().id;
}

function patchGroup(test: Test, directory: Directory, id: string, operations: unknown[]) {
  return scim(test, directory, "PATCH", `/Groups/${id}`, {
    schemas: [patchSchema],
    Operations: operations,
  });
}

function map(test: Test, directory: string, groupId: string, workspace: string, role?: string) {
  return admin(
    test,
    role === undefined ? "DELETE" : "PUT",
    `/api/admin/directories/${directory}/groups/${groupId}/workspaces/${workspace}`,
    role === undefined ? undefined : { role },
  );
}

async function places(test: Test, users: string[]) {
  const { rows } = await test.db.query(
    `SELECT u.name, m.role, m.own_role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = ANY($2::uuid[]) ORDER BY u.name`,
    [test.workspaceId, users],
  );
  return rows.map((row) => [row.name, row.role, row.own_role]);
}

async function members(test: Test, groupId: string, directory: Directory) {
  const got = await scim(test, directory, "GET", `/Groups/${groupId}`);
  return got
    .json<{ members: { value: string }[] }>()
    .members.map((each) => each.value)
    .sort();
}

describe("Okta's group push", () => {
  it("makes, renames, adds, removes by filter, replaces whole and deletes a group", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const ada = await user(test, okta, "ada@corp.example");
    const bea = await user(test, okta, "bea@corp.example");
    const cal = await user(test, okta, "cal@corp.example");
    const id = await group(test, okta, "Engineering");
    expect(await map(test, "okta", id, test.workspaceId, "member")).toMatchObject({
      statusCode: 204,
    });

    // Its rename: no path, the value holding id and displayName.
    const renamed = await patchGroup(test, okta, id, [
      { op: "replace", value: { id, displayName: "Engineers" } },
    ]);
    expect(renamed.statusCode).toBe(204);
    expect((await scim(test, okta, "GET", `/Groups/${id}`)).json()).toMatchObject({
      displayName: "Engineers",
    });

    const since = test.told.length;
    const added = await patchGroup(test, okta, id, [
      { op: "add", path: "members", value: [{ value: ada }, { value: bea }] },
    ]);
    expect(added.statusCode, added.body).toBe(204);
    expect(await places(test, [ada, bea])).toEqual([
      ["ada", "member", "none"],
      ["bea", "member", "none"],
    ]);
    expect(actions(test, since).filter((action) => action.startsWith("member."))).toEqual([
      "member.joined",
      "member.joined",
    ]);
    expect(test.told.find((event) => event.action === "member.joined")).toMatchObject({
      actor: { kind: "directory", id: "okta" },
      details: { role: "member", via: "group", group: { id, name: "Engineers" } },
    });

    // Removed by a value filter, and its place goes with it.
    await patchGroup(test, okta, id, [{ op: "remove", path: `members[value eq "${ada}"]` }]);
    expect(await members(test, id, okta)).toEqual([bea]);
    expect(await places(test, [ada])).toEqual([]);

    // The whole list replaced.
    await patchGroup(test, okta, id, [
      { op: "replace", path: "members", value: [{ value: ada }, { value: cal }] },
    ]);
    expect(await members(test, id, okta)).toEqual([ada, cal].sort());
    expect((await places(test, [ada, bea, cal])).map((place) => place[0])).toEqual(["ada", "cal"]);

    // Deleted: every place it gave goes, and none it did not.
    const deleted = await scim(test, okta, "DELETE", `/Groups/${id}`);
    expect(deleted.statusCode).toBe(204);
    expect(await places(test, [ada, bea, cal])).toEqual([]);
    expect((await scim(test, okta, "GET", `/Groups/${id}`)).statusCode).toBe(404);
    expect(actions(test)).toEqual(
      expect.arrayContaining(["group.created", "group.changed", "group.deleted"]),
    );
  });
});

describe("Entra ID's groups", () => {
  it("are made with their members, added and removed in value, and renamed by path", async () => {
    const test = await start();
    const entra = await addDirectory(test, { id: "entra", domains: ["contoso.example"] });
    const ada = await user(test, entra, "ada@contoso.example");
    const bea = await user(test, entra, "bea@contoso.example");
    const made = await scim(test, entra, "POST", "/Groups", {
      schemas: [groupSchema],
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      displayName: "Group1DisplayName",
      members: [{ value: ada }],
    });
    expect(made.statusCode, made.body).toBe(201);
    const { id } = made.json<{ id: string }>();
    expect(made.json()).toMatchObject({
      schemas: [groupSchema],
      displayName: "Group1DisplayName",
      externalId: "8aa1a0c0-c4c3-4bc0-b4a5-2ef676900159",
      members: [{ value: ada, display: "ada" }],
      meta: { resourceType: "Group" },
    });
    const looked = await scim(
      test,
      entra,
      "GET",
      `/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "group1displayname"')}`,
    );
    expect(looked.json<{ Resources: Record<string, unknown>[] }>().Resources[0]).not.toHaveProperty(
      "members",
    );
    await map(test, "entra", id, test.workspaceId, "admin");
    expect(await places(test, [ada])).toEqual([["ada", "admin", "none"]]);

    expect(
      (await patchGroup(test, entra, id, [{ op: "Add", path: "members", value: [{ value: bea }] }]))
        .statusCode,
    ).toBe(204);
    // Without its flag, Entra ID names the members it removes in value.
    await patchGroup(test, entra, id, [{ op: "Remove", path: "members", value: [{ value: ada }] }]);
    expect(await members(test, id, entra)).toEqual([bea]);
    expect(await places(test, [ada, bea])).toEqual([["bea", "admin", "none"]]);
    // With it, by a filter, as Okta does.
    await patchGroup(test, entra, id, [{ op: "Remove", path: `members[value eq "${bea}"]` }]);
    expect(await members(test, id, entra)).toEqual([]);
    await patchGroup(test, entra, id, [{ op: "Replace", path: "displayName", value: "Renamed" }]);
    expect((await scim(test, entra, "GET", `/Groups/${id}`)).json()).toMatchObject({
      displayName: "Renamed",
    });
  });

  it("refuses a member not of this directory, a group as a member, and a name it has", async () => {
    const test = await start();
    const entra = await addDirectory(test, { id: "entra", domains: ["contoso.example"] });
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const theirs = await user(test, okta, "zed@corp.example");
    const first = await group(test, entra, "Engines");
    const stranger = await scim(test, entra, "POST", "/Groups", {
      displayName: "Strangers",
      members: [{ value: theirs }],
    });
    expect(stranger.statusCode).toBe(400);
    expect(stranger.json()).toMatchObject({ schemas: [errorSchema], scimType: "invalidValue" });
    const nested = await patchGroup(test, entra, first, [
      { op: "Add", path: "members", value: [{ value: first }] },
    ]);
    expect(nested.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
    const twice = await scim(test, entra, "POST", "/Groups", { displayName: "ENGINES" });
    expect(twice.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
    const noName = await scim(test, entra, "POST", "/Groups", { members: [] });
    expect(noName.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
    // Another directory sees none of this one's groups.
    expect((await scim(test, okta, "GET", `/Groups/${first}`)).statusCode).toBe(404);
  });

  it("answers its discovery with Group beside User", async () => {
    const test = await start();
    const entra = await addDirectory(test, { id: "entra", domains: ["contoso.example"] });
    const types = await scim(test, entra, "GET", "/ResourceTypes");
    expect(types.json<{ Resources: { id: string }[] }>().Resources.map((type) => type.id)).toEqual([
      "User",
      "Group",
    ]);
    expect((await scim(test, entra, "GET", "/ResourceTypes/Group")).statusCode).toBe(200);
    expect((await scim(test, entra, "GET", `/Schemas/${groupSchema}`)).json()).toMatchObject({
      id: groupSchema,
    });
  });
});

describe("a group's places", () => {
  it("raise a member above its own role, give way to a higher one, and take back only theirs", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["example.org"] });
    const bea = await join(test, "bea@example.org", "Bea");
    await user(test, okta, "bea@example.org");
    const staff = await group(test, okta, "Staff", [bea.id]);
    const leads = await group(test, okta, "Leads", [bea.id]);
    await map(test, "okta", staff, test.workspaceId, "admin");
    expect(await places(test, [bea.id])).toEqual([["bea", "admin", "member"]]);
    await map(test, "okta", leads, test.workspaceId, "owner");
    expect(await places(test, [bea.id])).toEqual([["bea", "owner", "member"]]);
    // The members list says which group gives the place, the highest first.
    const listed = await admin(test, "GET", `/api/workspaces/${test.workspaceId}/members`);
    expect(
      listed
        .json<{ members: { name: string; groups: { name: string; role: string }[] }[] }>()
        .members.find((each) => each.name === "bea")?.groups,
    ).toEqual([
      { id: leads, name: "Leads", role: "owner" },
      { id: staff, name: "Staff", role: "admin" },
    ]);
    // Its owners cannot lower Bea below them, nor remove her.
    const lowered = await admin(
      test,
      "PATCH",
      `/api/workspaces/${test.workspaceId}/members/${bea.id}`,
      { role: "member" },
    );
    expect(lowered.statusCode).toBe(409);
    expect(lowered.json<{ message: string }>().message).toMatch(/The group Leads gives them/);

    await map(test, "okta", leads, test.workspaceId);
    expect(await places(test, [bea.id])).toEqual([["bea", "admin", "member"]]);
    expect(test.told.at(-1)).toMatchObject({
      action: "member.role_changed",
      actor: { kind: "account", id: test.userId },
      details: { from: "owner", to: "admin", via: "group", group: { id: leads, name: "Leads" } },
    });
    await scim(test, okta, "DELETE", `/Groups/${staff}`);
    expect(await places(test, [bea.id])).toEqual([["bea", "member", null]]);
    // A mapping removed twice, or of a workspace there is not, is not there.
    expect((await map(test, "okta", leads, test.workspaceId)).statusCode).toBe(404);
    expect((await map(test, "okta", leads, randomUUID(), "member")).statusCode).toBe(404);
    expect((await map(test, "okta", leads, test.workspaceId, "guest")).statusCode).toBe(400);
  });

  it("are listed on the console with each group's members and workspaces", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const ada = await user(test, okta, "ada@corp.example");
    const id = await group(test, okta, "Engines", [ada]);
    await map(test, "okta", id, test.workspaceId, "member");
    const listed = await admin(test, "GET", "/api/admin/directories/okta/groups");
    expect(listed.json()).toEqual({
      groups: [
        {
          id,
          name: "Engines",
          externalId: null,
          members: 1,
          workspaces: [{ id: test.workspaceId, name: "Team", role: "member" }],
        },
      ],
      workspaces: [{ id: test.workspaceId, name: "Team" }],
    });
    expect((await admin(test, "GET", "/api/admin/directories/none/groups")).statusCode).toBe(404);
  });
});
