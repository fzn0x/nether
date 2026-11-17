// Accounts a directory makes or takes (ADR 0085): an account that already
// has the address is taken over at the directory's own domains, keeping
// its password, places and identities; refused anywhere else, or when
// another directory manages it; a directory that may make accounts at
// other domains makes them there but takes none over; and its addresses
// follow the same rules when they change.
import { afterEach, describe, expect, it } from "vitest";
import { addDirectory, admin, join, scim, start, stop, userSchema } from "./server.ts";

afterEach(stop);

function user(userName: string, email = userName) {
  return {
    schemas: [userSchema],
    userName,
    name: { givenName: userName.split("@")[0] ?? "", familyName: "Example" },
    emails: [{ primary: true, type: "work", value: email }],
    active: true,
  };
}

describe("a directory's accounts", () => {
  it("takes over an account at its domains, keeping its password and places", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const ada = await join(test, "Ada@Corp.example", "Ada");
    const since = test.told.length;
    const taken = await scim(test, okta, "POST", "/Users", user("ada@corp.example"));
    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json()).toMatchObject({ id: ada.id, active: true });
    expect(test.told.slice(since).map((event) => event.action)).toEqual([
      "directory.account_linked",
      "account.changed",
    ]);
    // Its password still signs it in, and its place is as it was.
    const signedIn = await test.server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { email: "ada@corp.example", password: ada.password },
    });
    expect(signedIn.statusCode).toBe(201);
    const { rows } = await test.db.query("SELECT role FROM memberships WHERE user_id = $1", [
      ada.id,
    ]);
    expect(rows).toEqual([{ role: "member" }]);
  });

  it("refuses an account at a domain it does not speak for, and one another directory manages", async () => {
    const test = await start();
    const okta = await addDirectory(test, {
      id: "okta",
      domains: ["corp.example"],
      otherDomains: true,
    });
    const entra = await addDirectory(test, { id: "entra", domains: ["sub.corp.example"] });
    await join(test, "bea@partner.example", "Bea");
    // Even a directory that may make accounts elsewhere takes none over there.
    const outside = await scim(test, okta, "POST", "/Users", user("bea@partner.example"));
    expect(outside.statusCode).toBe(409);
    expect(outside.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
    // A new address elsewhere is made, as a guest's at their own address.
    const guest = await scim(test, okta, "POST", "/Users", user("cy@partner.example"));
    expect(guest.statusCode, guest.body).toBe(201);
    // Without the setting, an address outside its domains is refused.
    const refused = await scim(test, entra, "POST", "/Users", user("dee@partner.example"));
    expect(refused.json()).toMatchObject({ status: "400", scimType: "invalidValue" });

    const made = await scim(test, entra, "POST", "/Users", user("eve@sub.corp.example"));
    expect(made.statusCode).toBe(201);
    // Another directory's account is not taken, even at a domain of this one's.
    const other = await addDirectory(test, { id: "other", domains: ["corp.test"] });
    await test.db.query("UPDATE directory_domains SET directory_id = 'other' WHERE domain = $1", [
      "sub.corp.example",
    ]);
    const twice = await scim(test, other, "POST", "/Users", user("eve@sub.corp.example"));
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ detail: string }>().detail).toBe(
      "Another directory manages the account with the address eve@sub.corp.example.",
    );
  });

  it("takes an address from emails, else from a userName that is one, and refuses one with none", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example"] });
    const byName = await scim(test, okta, "POST", "/Users", {
      schemas: [userSchema],
      userName: "fay@corp.example",
      displayName: "Fay",
    });
    expect(byName.statusCode, byName.body).toBe(201);
    const typed = await scim(test, okta, "POST", "/Users", {
      schemas: [userSchema],
      userName: "gus",
      emails: [
        { type: "home", value: "gus@home.example" },
        { type: "work", value: "gus@corp.example" },
      ],
    });
    expect(typed.statusCode, typed.body).toBe(201);
    const { rows } = await test.db.query(
      "SELECT name, email FROM users WHERE email_key IN ('fay@corp.example', 'gus@corp.example') ORDER BY email",
    );
    expect(rows).toEqual([
      { name: "Fay", email: "fay@corp.example" },
      { name: "gus", email: "gus@corp.example" },
    ]);
    const none = await scim(test, okta, "POST", "/Users", {
      schemas: [userSchema],
      userName: "hal",
    });
    expect(none.json()).toMatchObject({ status: "400", scimType: "invalidValue" });
  });

  it("refuses an address another account has, and deactivates no last instance admin", async () => {
    const test = await start();
    const okta = await addDirectory(test, { id: "okta", domains: ["corp.example", "example.org"] });
    await join(test, "ivy@corp.example", "Ivy");
    const made = await scim(test, okta, "POST", "/Users", user("jo@corp.example"));
    const { id } = made.json<{ id: string }>();
    const taken = await scim(
      test,
      okta,
      "PUT",
      `/Users/${id}`,
      user("jo@corp.example", "ivy@corp.example"),
    );
    expect(taken.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
    // The setup's admin, Ada, taken over and then deactivated, is the last active instance admin.
    const ada = await scim(test, okta, "POST", "/Users", user("ada@example.org"));
    expect(ada.statusCode, ada.body).toBe(201);
    const refused = await scim(test, okta, "PATCH", `/Users/${ada.json<{ id: string }>().id}`, {
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ detail: string }>().detail).toMatch(/last active instance admin/);
    expect((await admin(test, "GET", "/api/me")).statusCode).toBe(200);
  });
});
