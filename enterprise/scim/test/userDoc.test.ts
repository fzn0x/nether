// Paths, filters and PATCH on their own: every form ADR 0085's table
// lists, as both providers send them, and what is refused.
import { describe, expect, it } from "vitest";
import { ScimError } from "../src/errors.ts";
import { enterpriseUserSchema, parseFilter, parsePath } from "../src/paths.ts";
import { type UserDoc, applyPatch, docFromResource, operationsOf } from "../src/userDoc.ts";

const ada: UserDoc = {
  userName: "ada@corp.example",
  externalId: "00u1",
  displayName: null,
  name: { givenName: "Ada", familyName: "Lovelace" },
  emails: [{ value: "ada@corp.example", type: "work", primary: true }],
  active: true,
};

function patched(operations: unknown[], doc: UserDoc = ada): UserDoc {
  return applyPatch(doc, operationsOf({ Operations: operations }));
}

function refusal(work: () => unknown): { status: number; scimType: string | undefined } {
  try {
    work();
  } catch (error) {
    if (error instanceof ScimError) return { status: error.status, scimType: error.scimType };
    throw error;
  }
  throw new Error("Nothing was refused.");
}

describe("paths", () => {
  it("read an attribute, a sub-attribute, a value filter and a schema, in any case", () => {
    expect(parsePath("userName")).toEqual({
      schema: undefined,
      attr: "username",
      filter: undefined,
      sub: undefined,
    });
    expect(parsePath("name.givenName")).toMatchObject({ attr: "name", sub: "givenname" });
    expect(parsePath('emails[type eq "other"].Value')).toMatchObject({
      attr: "emails",
      sub: "value",
      filter: [{ path: { attr: "type" }, value: "other" }],
    });
    expect(parsePath("urn:ietf:params:scim:schemas:core:2.0:User:userName")).toMatchObject({
      schema: "core",
      attr: "username",
    });
    expect(parsePath(`${enterpriseUserSchema}:employeeNumber`)).toMatchObject({
      schema: "enterprise",
      attr: "employeenumber",
    });
    expect(parsePath(enterpriseUserSchema)).toMatchObject({ schema: "enterprise", attr: "" });
    expect(
      parsePath("urn:example:params:scim:schemas:extension:acme:2.0:User:badge"),
    ).toMatchObject({ schema: "other", attr: "badge" });
    expect(refusal(() => parsePath("emails[type eq"))).toEqual({
      status: 400,
      scimType: "invalidPath",
    });
  });

  it("read filters of eq joined by and, and refuse the rest", () => {
    expect(parseFilter('userName eq "ada@corp.example" AND active Eq True')).toEqual([
      { path: expect.objectContaining({ attr: "username" }) as unknown, value: "ada@corp.example" },
      { path: expect.objectContaining({ attr: "active" }) as unknown, value: true },
    ]);
    expect(parseFilter('displayName eq "Say \\"hi\\""')[0]?.value).toBe('Say "hi"');
    expect(parseFilter('emails[type eq "work"].value eq "a@b.c"')[0]?.path).toMatchObject({
      attr: "emails",
      sub: "value",
    });
    for (const text of [
      'userName co "ada"',
      'userName eq "a" or userName eq "b"',
      '(userName eq "a")',
      'not (userName eq "a")',
      "userName pr",
      'userName eq "open',
    ]) {
      expect(
        refusal(() => parseFilter(text)),
        text,
      ).toEqual({
        status: 400,
        scimType: "invalidFilter",
      });
    }
  });
});

describe("a PATCH", () => {
  it("deactivates by path or with no path, with a boolean or a string in any case", () => {
    for (const operation of [
      { op: "replace", value: { active: false } },
      { op: "Replace", path: "active", value: "False" },
      { op: "replace", path: "active", value: false },
      { op: "REPLACE", value: { Active: "false" } },
    ]) {
      expect(patched([operation]).active).toBe(false);
    }
  });

  it("sets the work address by its filter, and makes one where none is typed so", () => {
    expect(
      patched([
        { op: "Replace", path: 'emails[type eq "work"].value', value: "ada.k@corp.example" },
      ]).emails,
    ).toEqual([{ value: "ada.k@corp.example", type: "work", primary: true }]);
    const untyped: UserDoc = { ...ada, emails: [{ value: "ada@corp.example", primary: true }] };
    expect(
      patched(
        [{ op: "replace", path: 'emails[type eq "work"].value', value: "ada.k@corp.example" }],
        untyped,
      ).emails,
    ).toEqual([
      { value: "ada@corp.example", primary: true },
      { type: "work", value: "ada.k@corp.example" },
    ]);
    expect(patched([{ op: "remove", path: 'emails[type eq "work"]' }]).emails).toEqual([]);
  });

  it("takes keys that are paths in a value with no path, and drops what Nether does not keep", () => {
    const next = patched([
      {
        op: "replace",
        value: {
          "name.givenName": "Augusta",
          [`${enterpriseUserSchema}:employeeNumber`]: "1815",
          [enterpriseUserSchema]: { department: "Engines" },
          title: "Countess",
          id: "kept as it is",
        },
      },
      { op: "add", path: 'phoneNumbers[type eq "work"].value', value: "+44" },
      { op: "replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:displayName", value: "A" },
      { op: "add", path: "password", value: "dropped" },
    ]);
    expect(next).toEqual({
      ...ada,
      displayName: "A",
      name: { givenName: "Augusta", familyName: "Lovelace" },
    });
  });

  it("adds, replaces and removes emails, keeping one primary", () => {
    const added = patched([
      {
        op: "add",
        path: "emails",
        value: [{ value: "a@home.example", type: "home", primary: true }],
      },
    ]);
    expect(added.emails).toEqual([
      { value: "ada@corp.example", type: "work", primary: false },
      { value: "a@home.example", type: "home", primary: true },
    ]);
    expect(patched([{ op: "replace", path: "emails", value: [] }]).emails).toEqual([]);
    expect(patched([{ op: "remove", path: "emails" }]).emails).toEqual([]);
    expect(
      patched([{ op: "replace", path: "emails.value", value: "x@corp.example" }]).emails,
    ).toEqual([{ value: "x@corp.example", type: "work", primary: true }]);
  });

  it("refuses a remove with no path, a userName removed, and an op it does not know", () => {
    expect(refusal(() => patched([{ op: "remove", value: { displayName: "x" } }]))).toEqual({
      status: 400,
      scimType: "noTarget",
    });
    expect(refusal(() => patched([{ op: "remove", path: "userName" }]))).toEqual({
      status: 400,
      scimType: "mutability",
    });
    expect(refusal(() => patched([{ op: "move", path: "userName", value: "x" }]))).toEqual({
      status: 400,
      scimType: "invalidSyntax",
    });
    expect(refusal(() => operationsOf({ Operations: [] }))).toEqual({
      status: 400,
      scimType: "invalidSyntax",
    });
    expect(refusal(() => patched([{ op: "replace", path: "displayName" }]))).toEqual({
      status: 400,
      scimType: "invalidValue",
    });
  });
});

describe("a resource", () => {
  it("keeps what it sends of the kept attributes, and active only when it says", () => {
    const doc = docFromResource(
      {
        UserName: " ada@corp.example ",
        NAME: { GivenName: "Ada", nickName: "dropped" },
        emails: { value: "ada@corp.example", primary: "true" },
        password: "dropped",
      },
      false,
    );
    expect(doc).toEqual({
      userName: "ada@corp.example",
      externalId: null,
      displayName: null,
      name: { givenName: "Ada" },
      emails: [{ value: "ada@corp.example", primary: true }],
      active: false,
    });
    expect(docFromResource({ userName: "x", active: "TRUE" }, false).active).toBe(true);
    expect(refusal(() => docFromResource({ userName: "" }, true))).toEqual({
      status: 400,
      scimType: "invalidValue",
    });
    expect(refusal(() => docFromResource([], true))).toEqual({
      status: 400,
      scimType: "invalidSyntax",
    });
  });
});
