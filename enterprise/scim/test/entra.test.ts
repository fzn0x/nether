// Microsoft Entra ID's provisioning, as its SCIM guide documents its
// requests, without its aadOptscim062020 flag and with it: the test
// connection's lookup of a random user, filters by userName and
// externalId, a create with the enterprise extension, PATCH with `op`
// capitalized, `"False"` as a string, `emails[type eq "work"].value`,
// paths as keys, and the DELETE that removes a user, 30 days after a soft
// delete, unless a workspace it is in is on legal hold.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Test,
  actions,
  addDirectory,
  admin,
  enterpriseSchema,
  errorSchema,
  filtered,
  join,
  patchSchema,
  scim,
  start,
  stop,
  userSchema,
} from "./server.ts";

afterEach(stop);

/** A user as Entra ID's create sends one, its userName not an address. */
function entraUser(email: string, externalId = randomUUID()) {
  return {
    schemas: [userSchema, enterpriseSchema],
    externalId,
    userName: `Test_User_${randomUUID()}`,
    active: true,
    emails: [{ primary: true, type: "work", value: email }],
    meta: { resourceType: "User" },
    name: { formatted: "Ada Lovelace", familyName: "Lovelace", givenName: "Ada" },
    roles: [],
    title: "Analyst",
    phoneNumbers: [{ type: "work", value: "+44 20 7946 0000" }],
    [enterpriseSchema]: { department: "Engines", employeeNumber: "1815" },
  };
}

async function entra(test: Test) {
  return addDirectory(test, { id: "entra", name: "Entra ID", domains: ["contoso.example"] });
}

async function patch(
  test: Test,
  directory: { token: string; base: string },
  id: string,
  operations: unknown[],
) {
  return scim(test, directory, "PATCH", `/Users/${id}`, {
    schemas: [patchSchema],
    Operations: operations,
  });
}

describe("Entra ID", () => {
  it("passes the test connection's lookup of a random user and group, and finds users by externalId", async () => {
    const test = await start();
    const directory = await entra(test);
    const lookup = await scim(test, directory, "GET", filtered(`userName eq "${randomUUID()}"`));
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ totalResults: 0, Resources: [] });
    const group = await scim(
      test,
      directory,
      "GET",
      `/Groups?excludedAttributes=members&filter=${encodeURIComponent(`displayName eq "${randomUUID()}"`)}`,
    );
    expect(group.statusCode).toBe(200);
    expect(group.json()).toMatchObject({ totalResults: 0, Resources: [] });

    const externalId = randomUUID();
    const made = await scim(
      test,
      directory,
      "POST",
      "/Users",
      entraUser("ada@contoso.example", externalId),
    );
    expect(made.statusCode, made.body).toBe(201);
    // The enterprise extension, its title and phone numbers are taken and not kept.
    const user = made.json<Record<string, unknown>>();
    expect(user).not.toHaveProperty("title");
    expect(user).not.toHaveProperty("phoneNumbers");
    expect(user).not.toHaveProperty(enterpriseSchema);
    expect(user).toMatchObject({ externalId, name: { formatted: "Ada Lovelace" } });
    const { rows } = await test.db.query("SELECT name, email FROM users WHERE id = $1", [user.id]);
    expect(rows).toEqual([{ name: "Ada Lovelace", email: "ada@contoso.example" }]);

    const byExternal = await scim(
      test,
      directory,
      "GET",
      filtered(`externalId eq "${externalId}"`),
    );
    expect(byExternal.json()).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });
    const byWork = await scim(
      test,
      directory,
      "GET",
      filtered(`emails[type eq "work"].value eq "ADA@contoso.example"`),
    );
    expect(byWork.json()).toMatchObject({ totalResults: 1 });
    const byBoth = await scim(
      test,
      directory,
      "GET",
      filtered(`externalId eq "${externalId}" and active eq true`, "&attributes=userName"),
    );
    expect(byBoth.json<{ Resources: Record<string, unknown>[] }>().Resources).toEqual([
      { schemas: [userSchema], id: user.id, userName: user.userName },
    ]);
    const unknown = await scim(test, directory, "GET", filtered(`title eq "Analyst"`));
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({
      schemas: [errorSchema],
      status: "400",
      scimType: "invalidFilter",
      detail:
        'Nether filters users by id, userName, externalId, emails.value, emails[type eq "work"].value and active.',
    });
    const either = await scim(
      test,
      directory,
      "GET",
      filtered(`userName eq "a" or userName eq "b"`),
    );
    expect(either.json()).toMatchObject({ status: "400", scimType: "invalidFilter" });
  });

  it("changes a user by PATCH without its flag: op capitalized, False as a string", async () => {
    const test = await start();
    const directory = await entra(test);
    const made = await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    const { id } = made.json<{ id: string }>();
    const changed = await patch(test, directory, id, [
      { op: "Replace", path: 'emails[type eq "work"].value', value: "ada.l@contoso.example" },
      { op: "Replace", path: "name.familyName", value: "King" },
      { op: "Replace", path: "displayName", value: "Ada King" },
      { op: "Add", path: 'emails[type eq "other"].Value', value: "ada@home.example" },
      { op: "Replace", path: `${enterpriseSchema}:employeeNumber`, value: "1816" },
      { op: "Add", path: 'phoneNumbers[type eq "mobile"].value', value: "+44 7700 900000" },
    ]);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      displayName: "Ada King",
      name: { familyName: "King", givenName: "Ada" },
      emails: [
        { primary: true, type: "work", value: "ada.l@contoso.example" },
        { type: "other", value: "ada@home.example" },
      ],
    });
    const { rows } = await test.db.query("SELECT name, email FROM users WHERE id = $1", [id]);
    expect(rows).toEqual([{ name: "Ada King", email: "ada.l@contoso.example" }]);

    const off = await patch(test, directory, id, [
      { op: "Replace", path: "active", value: "False" },
    ]);
    expect(off.json()).toMatchObject({ active: false });
    expect(actions(test).at(-1)).toBe("account.deactivated");
    // Removing members named in value is for groups; for a user, a remove names its path.
    const noPath = await patch(test, directory, id, [
      { op: "Remove", value: { displayName: "x" } },
    ]);
    expect(noPath.json()).toMatchObject({ status: "400", scimType: "noTarget" });
  });

  it("changes a user by PATCH with its flag: one replace with no path, keys as paths", async () => {
    const test = await start();
    const directory = await entra(test);
    const made = await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    const { id } = made.json<{ id: string }>();
    const changed = await patch(test, directory, id, [
      {
        op: "replace",
        value: {
          "name.givenName": "Augusta",
          "name.formatted": "Augusta Ada King",
          [`${enterpriseSchema}:employeeNumber`]: "1816",
          active: false,
        },
      },
    ]);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      name: { givenName: "Augusta", formatted: "Augusta Ada King", familyName: "Lovelace" },
      active: false,
    });
    const { rows } = await test.db.query("SELECT name FROM users WHERE id = $1", [id]);
    expect(rows).toEqual([{ name: "Augusta Ada King" }]);
    const on = await patch(test, directory, id, [{ op: "replace", path: "active", value: true }]);
    expect(on.json()).toMatchObject({ active: true });
  });

  it("applies a PATCH whole or not at all", async () => {
    const test = await start();
    const directory = await entra(test);
    const made = await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    const { id } = made.json<{ id: string }>();
    const refused = await patch(test, directory, id, [
      { op: "Replace", path: "displayName", value: "Never" },
      { op: "Replace", path: "active", value: "perhaps" },
    ]);
    expect(refused.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
    const kept = await scim(test, directory, "GET", `/Users/${id}`);
    expect(kept.json()).not.toHaveProperty("displayName");
    const badPath = await patch(test, directory, id, [
      { op: "Replace", path: "emails[type eq ", value: "x" },
    ]);
    expect(badPath.json()).toMatchObject({ status: "400", scimType: "invalidPath" });
    const outside = await patch(test, directory, id, [
      { op: "Replace", path: 'emails[type eq "work"].value', value: "ada@elsewhere.example" },
    ]);
    expect(outside.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
  });

  it("removes a user with DELETE: deactivated, out of every workspace, its identities gone, and let go", async () => {
    const test = await start();
    const directory = await entra(test);
    const ada = await join(test, "ada@contoso.example", "Ada");
    await test.db.query(
      "INSERT INTO identities (issuer, subject, user_id) VALUES ('https://idp.example', 'ada-1', $1)",
      [ada.id],
    );
    await test.db.query(
      "INSERT INTO workspace_keys (workspace_id, user_id, version, sealed_key) VALUES ($1, $2, 1, $3)",
      [test.workspaceId, ada.id, new Uint8Array([1])],
    );
    const made = await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    expect(made.json()).toMatchObject({ id: ada.id });
    const since = test.told.length;
    const removed = await scim(test, directory, "DELETE", `/Users/${ada.id}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect(actions(test, since)).toEqual([
      "account.deactivated",
      "member.removed",
      "directory.account_unlinked",
    ]);
    expect(test.told[since + 1]).toMatchObject({
      workspace: test.workspaceId,
      details: { role: "member", via: "scim" },
    });
    expect((await scim(test, directory, "GET", `/Users/${ada.id}`)).statusCode).toBe(404);
    expect((await scim(test, directory, "DELETE", `/Users/${ada.id}`)).statusCode).toBe(404);
    const { rows } = await test.db.query(
      `SELECT u.deactivated_at IS NOT NULL AS deactivated,
              (SELECT count(*)::int FROM memberships WHERE user_id = u.id) AS places,
              (SELECT count(*)::int FROM workspace_keys WHERE user_id = u.id) AS keys,
              (SELECT count(*)::int FROM identities WHERE user_id = u.id) AS identities,
              (SELECT count(*)::int FROM directory_accounts WHERE user_id = u.id) AS managed
         FROM users u WHERE u.id = $1`,
      [ada.id],
    );
    // The account stays, deactivated, as a record.
    expect(rows).toEqual([{ deactivated: true, places: 0, keys: 0, identities: 0, managed: 0 }]);
  });

  it("keeps a user deactivated, and in its workspaces, while one of them is on legal hold", async () => {
    const test = await start();
    const directory = await entra(test);
    const ada = await join(test, "ada@contoso.example", "Ada");
    await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    // The policies are read, and kept a few seconds, before the hold is set.
    const before = await admin(test, "GET", "/api/me");
    expect(before.json()).toMatchObject({ workspaces: [{ policies: { legalHold: false } }] });
    // Set a moment before the removal, the hold still stops it.
    await test.db.query("INSERT INTO workspace_policies (workspace_id, policy) VALUES ($1, $2)", [
      test.workspaceId,
      JSON.stringify({ legalHold: true }),
    ]);
    const held = await scim(test, directory, "DELETE", `/Users/${ada.id}`);
    expect(held.statusCode).toBe(403);
    expect(held.json()).toEqual({
      schemas: [errorSchema],
      status: "403",
      detail:
        "This account is in a workspace under legal hold: it stays deactivated until the hold ends.",
    });
    // Deactivated and kept: Entra ID tries the removal again in a later cycle.
    const kept = await scim(test, directory, "GET", `/Users/${ada.id}`);
    expect(kept.json()).toMatchObject({ id: ada.id, active: false });
    const places = await test.db.query("SELECT role FROM memberships WHERE user_id = $1", [ada.id]);
    expect(places.rows).toEqual([{ role: "member" }]);

    // The hold taken off, and set for every workspace instead: still held.
    await test.db.query("DELETE FROM workspace_policies WHERE workspace_id = $1", [
      test.workspaceId,
    ]);
    await test.db.query("INSERT INTO instance_settings (key, value) VALUES ('policies.data', $1)", [
      JSON.stringify({ legalHold: true }),
    ]);
    expect((await scim(test, directory, "DELETE", `/Users/${ada.id}`)).statusCode).toBe(403);
    // Taken off everywhere, the removal goes through at once.
    await test.db.query("DELETE FROM instance_settings WHERE key = 'policies.data'");
    expect((await scim(test, directory, "DELETE", `/Users/${ada.id}`)).statusCode).toBe(204);
  });

  it("removes a user while the data policies feature is off, whatever its policies say", async () => {
    const test = await start({ NETHER_ENTERPRISE_POLICIES: "off" });
    const directory = await entra(test);
    const ada = await join(test, "ada@contoso.example", "Ada");
    await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    await test.db.query("INSERT INTO workspace_policies (workspace_id, policy) VALUES ($1, $2)", [
      test.workspaceId,
      JSON.stringify({ legalHold: true }),
    ]);
    expect((await scim(test, directory, "DELETE", `/Users/${ada.id}`)).statusCode).toBe(204);
  });
});

describe("a directory's groups, read", () => {
  it("are found by displayName without regard to case, their members left out when asked", async () => {
    const test = await start();
    const directory = await entra(test);
    const made = await scim(test, directory, "POST", "/Users", entraUser("ada@contoso.example"));
    const { id: ada } = made.json<{ id: string }>();
    // A group of the directory's, as the next part's /Groups will make one.
    const group = randomUUID();
    await test.db.query(
      "INSERT INTO groups (id, directory_id, name, external_id) VALUES ($1, 'entra', 'Engines', 'grp-1')",
      [group],
    );
    await test.db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [
      group,
      ada,
    ]);
    const found = await scim(
      test,
      directory,
      "GET",
      `/Groups?filter=${encodeURIComponent('displayName eq "ENGINES"')}&excludedAttributes=members`,
    );
    expect(found.json<{ Resources: unknown[] }>().Resources).toEqual([
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        id: group,
        externalId: "grp-1",
        displayName: "Engines",
        meta: expect.objectContaining({ resourceType: "Group" }) as unknown,
      },
    ]);
    const one = await scim(test, directory, "GET", `/Groups/${group}`);
    expect(one.json()).toMatchObject({ members: [{ value: ada, display: "Ada Lovelace" }] });
    const byMember = await scim(
      test,
      directory,
      "GET",
      `/Groups?filter=${encodeURIComponent(`members.value eq "${ada}"`)}`,
    );
    expect(byMember.json()).toMatchObject({ totalResults: 1 });
    // A user's groups are read only, from the groups.
    const user = await scim(test, directory, "GET", `/Users/${ada}`);
    expect(user.json()).toMatchObject({ groups: [{ value: group, display: "Engines" }] });
    expect((await scim(test, directory, "GET", `/Groups/${randomUUID()}`)).statusCode).toBe(404);
  });
});
