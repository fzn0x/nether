// Okta's provisioning, as its SCIM 2.0 guide documents its requests: the
// check for a user by `userName eq`, pages of 100, a create that carries
// `password` and `groups`, updates by `PUT` with the whole user after a
// `GET`, and deactivation by a `PATCH` with no path. Where the guide shows
// nothing, as its reactivation body or whether it slows down for a 429,
// every form is taken, and the tests say the behaviour is assumed.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Test,
  actions,
  addDirectory,
  filtered,
  listSchema,
  patchSchema,
  publicUrl,
  scim,
  start,
  stop,
  userSchema,
} from "./server.ts";

afterEach(stop);

/** A user as Okta's create sends one: with a password Nether never keeps, and its groups. */
function oktaUser(email: string, extra: Record<string, unknown> = {}) {
  return {
    schemas: [userSchema],
    userName: email,
    name: { givenName: "Grace", familyName: "Hopper" },
    emails: [{ primary: true, value: email, type: "work" }],
    displayName: "Grace Hopper",
    locale: "en-US",
    externalId: "00u1grace",
    groups: [],
    // Built here: Okta sends one even when password sync is off.
    password: randomBytes(9).toString("base64url"),
    active: true,
    ...extra,
  };
}

async function okta(test: Test) {
  return addDirectory(test, { id: "okta", name: "Okta", domains: ["corp.example"] });
}

describe("Okta", () => {
  it("finds no one, makes the user without its password, and finds it by userName", async () => {
    const test = await start();
    const directory = await okta(test);
    const email = "grace@corp.example";

    const none = await scim(
      test,
      directory,
      "GET",
      filtered(`userName eq "${email}"`, "&startIndex=1&count=100"),
    );
    expect(none.statusCode).toBe(200);
    expect(none.headers["content-type"]).toBe("application/scim+json; charset=utf-8");
    expect(none.json()).toEqual({
      schemas: [listSchema],
      totalResults: 0,
      itemsPerPage: 0,
      startIndex: 1,
      Resources: [],
    });

    const since = test.told.length;
    const made = await scim(test, directory, "POST", "/Users", oktaUser(email));
    expect(made.statusCode, made.body).toBe(201);
    const user = made.json<{ id: string }>();
    expect(made.headers.location).toBe(`${publicUrl}/api/scim/okta/v2/Users/${user.id}`);
    expect(user).toEqual({
      schemas: [userSchema],
      id: user.id,
      externalId: "00u1grace",
      userName: email,
      name: { givenName: "Grace", familyName: "Hopper" },
      displayName: "Grace Hopper",
      emails: [{ primary: true, value: email, type: "work" }],
      active: true,
      groups: [],
      meta: {
        resourceType: "User",
        created: expect.any(String) as unknown,
        lastModified: expect.any(String) as unknown,
        location: `${publicUrl}/api/scim/okta/v2/Users/${user.id}`,
      },
    });
    // No password and no locale: only what Nether uses is kept.
    const { rows } = await test.db.query(
      `SELECT u.name, u.email, u.password_hash, a.attributes::text AS attributes
         FROM users u JOIN directory_accounts a ON a.user_id = u.id WHERE u.id = $1`,
      [user.id],
    );
    expect(rows[0]).toMatchObject({ name: "Grace Hopper", email, password_hash: null });
    expect(String(rows[0]?.attributes)).not.toMatch(/password|locale/i);
    expect(actions(test, since)).toEqual(["account.created"]);
    expect(test.told[since]).toMatchObject({
      action: "account.created",
      actor: { kind: "directory", id: "okta", name: "Okta" },
      target: { type: "account", id: user.id, name: "Grace Hopper" },
      details: { by: "scim", directory: "okta" },
    });

    const found = await scim(test, directory, "GET", filtered(`userName eq "GRACE@corp.example"`));
    expect(found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: user.id }] });
    const again = await scim(test, directory, "POST", "/Users", oktaUser(email));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
  });

  it("lists its users a page at a time, in the order they were made", async () => {
    const test = await start();
    const directory = await okta(test);
    const ids: string[] = [];
    for (const name of ["ada", "bea", "cal"]) {
      const made = await scim(
        test,
        directory,
        "POST",
        "/Users",
        oktaUser(`${name}@corp.example`, { externalId: `00u1${name}` }),
      );
      ids.push(made.json<{ id: string }>().id);
    }
    const first = await scim(test, directory, "GET", "/Users?startIndex=1&count=100");
    expect(first.json()).toMatchObject({
      totalResults: 3,
      itemsPerPage: 3,
      startIndex: 1,
    });
    expect(first.json<{ Resources: { id: string }[] }>().Resources.map((user) => user.id)).toEqual(
      ids,
    );
    const second = await scim(test, directory, "GET", "/Users?startIndex=2&count=1");
    expect(second.json()).toMatchObject({
      totalResults: 3,
      itemsPerPage: 1,
      startIndex: 2,
      Resources: [{ id: ids[1] }],
    });
    // Past the most a page holds, a count is the most; less than 1, a start is 1.
    const counted = await scim(test, directory, "GET", "/Users?startIndex=0&count=5000");
    expect(counted.json()).toMatchObject({ startIndex: 1, itemsPerPage: 3 });
    const none = await scim(test, directory, "GET", "/Users?count=0");
    expect(none.json()).toMatchObject({ totalResults: 3, itemsPerPage: 0, Resources: [] });
  });

  it("updates by PUT with the whole user, and a PUT with no active leaves it as it is", async () => {
    const test = await start();
    const directory = await okta(test);
    const made = await scim(test, directory, "POST", "/Users", oktaUser("grace@corp.example"));
    const { id } = made.json<{ id: string }>();
    const got = await scim(test, directory, "GET", `/Users/${id}`);
    const user = got.json<Record<string, unknown>>();
    const since = test.told.length;
    const put = await scim(test, directory, "PUT", `/Users/${id}`, {
      ...user,
      name: { givenName: "Grace B.", familyName: "Hopper" },
      displayName: "Grace B. Hopper",
      password: randomBytes(9).toString("base64url"),
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ displayName: "Grace B. Hopper", active: true });
    expect(test.told.slice(since)).toMatchObject([
      {
        action: "account.changed",
        details: {
          from: { name: "Grace Hopper", email: "grace@corp.example" },
          to: { name: "Grace B. Hopper", email: "grace@corp.example" },
        },
      },
    ]);

    await scim(test, directory, "PATCH", `/Users/${id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    const withoutActive = Object.fromEntries(
      Object.entries(put.json<Record<string, unknown>>()).filter(([key]) => key !== "active"),
    );
    const kept = await scim(test, directory, "PUT", `/Users/${id}`, withoutActive);
    expect(kept.json()).toMatchObject({ active: false });
  });

  it("deactivates with a PATCH with no path, ending the account's sessions", async () => {
    const test = await start();
    const directory = await okta(test);
    const made = await scim(test, directory, "POST", "/Users", oktaUser("grace@corp.example"));
    const { id } = made.json<{ id: string }>();
    await test.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, 'a hash', now() + interval '1 day')`,
      [id],
    );
    const since = test.told.length;
    const off = await scim(test, directory, "PATCH", `/Users/${id}`, {
      schemas: [patchSchema],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ id, active: false });
    expect(test.told.slice(since)).toMatchObject([
      {
        action: "account.deactivated",
        actor: { kind: "directory", id: "okta" },
        details: { sessions: 1, tokens: [] },
      },
    ]);
    const sessions = await test.db.query("SELECT 1 FROM sessions WHERE user_id = $1", [id]);
    expect(sessions.rows).toEqual([]);
    const listed = await scim(test, directory, "GET", filtered("active eq false"));
    expect(listed.json()).toMatchObject({ totalResults: 1, Resources: [{ id }] });
  });

  // Okta's guide does not show its reactivation body: every form a
  // deactivation takes is taken, by path or with none, as a boolean or a
  // string in any case. Assumed, not documented.
  it.each([
    ["by its path, as a boolean", { op: "replace", path: "active", value: true }],
    ["with no path, as a boolean", { op: "replace", value: { active: true } }],
    ["by its path, as a string", { op: "replace", path: "active", value: "true" }],
    ["with no path, as a capitalized string", { op: "Replace", value: { active: "True" } }],
    ["added, with no path", { op: "add", value: { active: true } }],
  ])("reactivates %s (assumed)", async (_form, operation) => {
    const test = await start();
    const directory = await okta(test);
    const made = await scim(
      test,
      directory,
      "POST",
      "/Users",
      oktaUser("grace@corp.example", { active: false }),
    );
    const { id } = made.json<{ id: string; active: boolean }>();
    expect(made.json()).toMatchObject({ active: false });
    const on = await scim(test, directory, "PATCH", `/Users/${id}`, {
      schemas: [patchSchema],
      Operations: [operation],
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ active: true });
    expect(actions(test).at(-1)).toBe("account.reactivated");
  });

  // Okta's guide does not say how it meets a 429 during a first sync: a
  // directory's own requests are never limited. Assumed, not documented.
  it("answers a burst of the directory's own requests with no 429 (assumed)", async () => {
    const test = await start();
    const directory = await okta(test);
    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, at) =>
        scim(test, directory, "GET", filtered(`userName eq "user${String(at)}@corp.example"`)),
      ),
    );
    expect(answers.map((answer) => answer.statusCode)).toEqual(answers.map(() => 200));
  });

  it("takes application/json as well, and refuses a body that is not SCIM", async () => {
    const test = await start();
    const directory = await okta(test);
    const made = await scim(
      test,
      directory,
      "POST",
      "/Users",
      oktaUser("grace@corp.example"),
      "application/json",
    );
    expect(made.statusCode).toBe(201);
    const charset = await scim(
      test,
      directory,
      "POST",
      "/Users",
      oktaUser("hal@corp.example", { externalId: "00u1hal" }),
      "application/scim+json; charset=utf-8",
    );
    expect(charset.statusCode, charset.body).toBe(201);
    const broken = await test.server.inject({
      method: "POST",
      url: `${directory.base}/Users`,
      headers: {
        authorization: `Bearer ${directory.token}`,
        "content-type": "application/scim+json",
      },
      payload: "{ not json",
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ status: "400", scimType: "invalidSyntax" });
    const nameless = await scim(test, directory, "POST", "/Users", { schemas: [userSchema] });
    expect(nameless.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
  });
});
