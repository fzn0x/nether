// The console's Directories page and the SCIM address's way in (ADR
// 0085): nothing answers while the feature is off; directories, their
// domains and tokens are the instance admins'; a token is shown once, kept
// as its hash, ends, and works only at its own directory's address; wrong
// tokens are limited by address; and removing a directory keeps what its
// groups gave and leaves its accounts as they are.
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { addDirectory, admin, errorSchema, join, scim, start, stop } from "./server.ts";

afterEach(stop);

describe("the console's directories", () => {
  it("answer nothing while the feature is off, and are the instance admins' alone", async () => {
    const off = await start({ NETHER_ENTERPRISE_SCIM: "" });
    expect((await admin(off, "GET", "/api/admin/directories")).statusCode).toBe(404);
    expect(
      (await off.server.inject({ method: "GET", url: "/api/scim/okta/v2/Users" })).statusCode,
    ).toBe(404);
    await stop();

    const test = await start();
    const bea = await join(test, "bea@example.org", "Bea");
    const refused = await admin(test, "GET", "/api/admin/directories", undefined, bea.token);
    expect(refused.statusCode).toBe(403);
    const listed = await admin(test, "GET", "/api/admin/directories");
    expect(listed.json()).toMatchObject({
      directories: [],
      publicUrl: "https://nether.example.org",
      secretKey: false,
      ldapPresets: {
        activeDirectory: { idAttribute: "objectGUID" },
        openLdap: { idAttribute: "entryUUID" },
      },
      signIn: { providers: 0, oidc: false, codes: false },
    });
  });

  it("add, change and remove directories, one directory to a domain", async () => {
    const test = await start();
    const added = await admin(test, "POST", "/api/admin/directories", {
      id: "okta",
      name: "Okta",
      domains: ["Corp.Example", "@corp.example", "sub.corp.example"],
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toEqual({
      id: "okta",
      kind: "scim",
      name: "Okta",
      domains: ["corp.example", "sub.corp.example"],
      otherDomains: false,
      accounts: 0,
      deactivated: 0,
      scimUrl: "https://nether.example.org/api/scim/okta/v2",
      token: null,
      ldap: null,
    });
    const badId = await admin(test, "POST", "/api/admin/directories", { id: "Okta_1", name: "x" });
    expect(badId.statusCode).toBe(400);
    const twice = await admin(test, "POST", "/api/admin/directories", { id: "okta", name: "x" });
    expect(twice.statusCode).toBe(409);
    const taken = await admin(test, "POST", "/api/admin/directories", {
      id: "entra",
      name: "Entra ID",
      domains: ["corp.example"],
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ message: string }>().message).toBe(
      "corp.example belongs to the directory okta: a domain belongs to one at most.",
    );
    const notDomain = await admin(test, "POST", "/api/admin/directories", {
      id: "entra",
      name: "Entra ID",
      domains: ["not a domain"],
    });
    expect(notDomain.statusCode).toBe(400);

    const changed = await admin(test, "PATCH", "/api/admin/directories/okta", {
      name: "Okta Workforce",
      domains: ["corp.example"],
      otherDomains: true,
    });
    expect(changed.json()).toMatchObject({
      name: "Okta Workforce",
      domains: ["corp.example"],
      otherDomains: true,
    });
    expect(test.told.map((event) => event.action)).toEqual(
      expect.arrayContaining(["directory.created", "directory.changed"]),
    );
    expect((await admin(test, "DELETE", "/api/admin/directories/okta")).statusCode).toBe(204);
    expect((await admin(test, "DELETE", "/api/admin/directories/okta")).statusCode).toBe(404);
    expect(test.told.at(-1)).toMatchObject({
      action: "directory.deleted",
      details: { accounts: 0 },
    });
  });

  it("make a token shown once and kept as its hash, which works at its own address alone", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const entra = await addDirectory(test, { id: "entra", domains: ["contoso.example"] });
    expect(okta.token.startsWith("nether_scim_")).toBe(true);
    const { rows } = await test.db.query(
      "SELECT token_hash, token_hint, token_expires_at FROM directories WHERE id = 'okta'",
    );
    expect(rows[0]?.token_hash).toBe(createHash("sha256").update(okta.token).digest("hex"));
    expect(rows[0]?.token_hint).toBe(okta.token.slice(-4));
    const days = (Number(rows[0]?.token_expires_at) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(365);
    const listed = await admin(test, "GET", "/api/admin/directories");
    expect(JSON.stringify(listed.json())).not.toContain(okta.token);
    expect(listed.json<{ directories: { id: string; token: unknown }[] }>().directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "okta",
          token: expect.objectContaining({
            hint: okta.token.slice(-4),
            endsSoon: false,
          }) as unknown,
        }),
      ]),
    );

    expect((await scim(test, okta, "GET", "/Users")).statusCode).toBe(200);
    // Another directory's token, no token, or a wrong one: 401, as SCIM answers.
    const crossed = await scim(test, { token: entra.token, base: okta.base }, "GET", "/Users");
    expect(crossed.statusCode).toBe(401);
    expect(crossed.headers["www-authenticate"]).toBe("Bearer");
    expect(crossed.json()).toEqual({
      schemas: [errorSchema],
      status: "401",
      detail:
        "This token is not this directory's, or has ended: make one on the console's Directories page.",
    });
    const bare = await test.server.inject({ method: "GET", url: `${okta.base}/Users` });
    expect(bare.statusCode).toBe(401);

    // A new token replaces the old at once; a token that ended works no more.
    const again = await admin(test, "POST", "/api/admin/directories/okta/token", { days: 30 });
    const fresh = { token: again.json<{ token: string }>().token, base: okta.base };
    expect((await scim(test, okta, "GET", "/Users")).statusCode).toBe(401);
    expect((await scim(test, fresh, "GET", "/Users")).statusCode).toBe(200);
    expect(
      (await admin(test, "GET", "/api/admin/directories"))
        .json<{ directories: { id: string; token: { endsSoon: boolean } }[] }>()
        .directories.find((each) => each.id === "okta")?.token.endsSoon,
    ).toBe(true);
    const tooLong = await admin(test, "POST", "/api/admin/directories/okta/token", { days: 731 });
    expect(tooLong.statusCode).toBe(400);
    await test.db.query(
      "UPDATE directories SET token_expires_at = now() - interval '1 minute' WHERE id = 'okta'",
    );
    expect((await scim(test, fresh, "GET", "/Users")).statusCode).toBe(401);
    const revoked = await admin(test, "DELETE", "/api/admin/directories/entra/token");
    expect(revoked.statusCode).toBe(204);
    expect((await scim(test, entra, "GET", "/Users")).statusCode).toBe(401);
    expect(test.told.map((event) => event.action)).toContain("directory.token_created");
    expect(JSON.stringify(test.told)).not.toContain(fresh.token);
  });

  it("limit wrong tokens by address, and never the directory's own requests", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const wrong = { token: `nether_scim_${randomUUID()}`, base: okta.base };
    const answers: number[] = [];
    for (let at = 0; at < 31; at++)
      answers.push((await scim(test, wrong, "GET", "/Users")).statusCode);
    expect(answers.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 401));
    expect(answers[30]).toBe(429);
    for (let at = 0; at < 40; at++) {
      expect((await scim(test, okta, "GET", "/ServiceProviderConfig")).statusCode).toBe(200);
    }
  });

  it("keep what a removed directory's groups gave, and its accounts as they are", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["example.org"] });
    const bea = await join(test, "bea@example.org", "Bea");
    const made = await scim(test, okta, "POST", "/Users", {
      userName: "bea@example.org",
      displayName: "Bea",
      active: false,
    });
    expect(made.json()).toMatchObject({ id: bea.id, active: false });
    // A group of the directory's raised Bea to admin, as part 3's groups will.
    const group = randomUUID();
    await test.db.query(
      "INSERT INTO groups (id, directory_id, name) VALUES ($1, 'okta', 'Staff')",
      [group],
    );
    await test.db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [
      group,
      bea.id,
    ]);
    await test.db.query(
      "INSERT INTO group_workspaces (group_id, workspace_id, role) VALUES ($1, $2, 'admin')",
      [group, test.workspaceId],
    );
    await test.db.query(
      "UPDATE memberships SET role = 'admin', own_role = 'member' WHERE user_id = $1",
      [bea.id],
    );
    expect((await admin(test, "DELETE", "/api/admin/directories/okta")).statusCode).toBe(204);
    const { rows } = await test.db.query(
      `SELECT m.role, m.own_role, u.deactivated_at IS NOT NULL AS deactivated,
              (SELECT count(*)::int FROM groups) AS groups,
              (SELECT count(*)::int FROM directory_accounts) AS managed
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1`,
      [bea.id],
    );
    expect(rows).toEqual([
      { role: "admin", own_role: null, deactivated: true, groups: 0, managed: 0 },
    ]);
    expect(test.told.slice(-2).map((event) => event.action)).toEqual([
      "directory.account_unlinked",
      "directory.deleted",
    ]);
  });
});

describe("the discovery endpoints", () => {
  it("say what the server supports, its resource type and its schema, and take no filter", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const config = await scim(test, okta, "GET", "/ServiceProviderConfig");
    expect(config.json()).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 1000 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", primary: true }],
    });
    const types = await scim(test, okta, "GET", "/ResourceTypes");
    expect(types.json()).toMatchObject({
      totalResults: 2,
      Resources: [
        { id: "User", endpoint: "/Users" },
        { id: "Group", endpoint: "/Groups" },
      ],
    });
    expect((await scim(test, okta, "GET", "/ResourceTypes/User")).statusCode).toBe(200);
    expect((await scim(test, okta, "GET", "/ResourceTypes/Device")).statusCode).toBe(404);
    const schemas = await scim(test, okta, "GET", "/Schemas");
    const attributes = schemas
      .json<{ Resources: { attributes: { name: string }[] }[] }>()
      .Resources[0]?.attributes.map((each) => each.name);
    expect(attributes).toEqual(["userName", "name", "displayName", "emails", "active", "groups"]);
    const one = await scim(
      test,
      okta,
      "GET",
      "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    );
    expect(one.json()).toMatchObject({ id: "urn:ietf:params:scim:schemas:core:2.0:User" });
    const asked = await scim(
      test,
      okta,
      "GET",
      `/Schemas?filter=${encodeURIComponent('id eq "x"')}`,
    );
    expect(asked.json()).toMatchObject({ status: "403" });
  });
});
