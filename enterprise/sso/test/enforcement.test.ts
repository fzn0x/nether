// What single sign-on requires (ADR 0080), rule by rule: a provider's
// domains through it alone, everyone through a provider, instance admins
// exempt unless covered, and nothing while the feature is off or the
// environment pins enforcement off.
import type { SessionMethod } from "@nether/server/src/events.ts";
import type { Database } from "@nether/server/src/db.ts";
import { describe, expect, it } from "vitest";
import { Enforcement, type Rules, covers, refusalOf, requiredBy } from "../src/enforcement.ts";

function rules(change: Partial<Rules> = {}): Rules {
  return {
    everyone: false,
    admins: false,
    domains: new Map([
      ["corp.example", { id: "corp", name: "Corp SSO", required: true }],
      ["partner.example", { id: "partner", name: "Partner", required: false }],
    ]),
    ...change,
  };
}

function attempt(
  email: string,
  method: SessionMethod | null,
  provider: string | null = null,
  instanceAdmin = false,
) {
  return { userId: "u", email, instanceAdmin, method, provider };
}

describe("refusalOf", () => {
  it("lets a required domain's accounts in through its provider alone", () => {
    const required = rules();
    expect(refusalOf(required, attempt("grace@corp.example", "sso", "corp"))).toBeUndefined();
    for (const [method, provider] of [
      ["password", null],
      ["code", null],
      ["invitation", null],
      ["setup", null],
      ["oidc", null],
      ["sso", "partner"],
      [null, null],
    ] as const) {
      expect(refusalOf(required, attempt("Grace@Corp.Example", method, provider))).toEqual({
        reason: "accounts at corp.example sign in through the provider corp alone",
      });
    }
    // Elsewhere, any way in.
    expect(refusalOf(required, attempt("ada@partner.example", "password"))).toBeUndefined();
    expect(refusalOf(required, attempt("ada@example.org", "code"))).toBeUndefined();
  });

  it("covers every account under everyone, each domain through its own provider", () => {
    const everyone = rules({ everyone: true });
    expect(refusalOf(everyone, attempt("ada@partner.example", "password"))).toBeDefined();
    expect(refusalOf(everyone, attempt("ada@partner.example", "sso", "corp"))).toBeDefined();
    expect(refusalOf(everyone, attempt("ada@partner.example", "sso", "partner"))).toBeUndefined();
    // At no provider's domain, any provider, the environment's too.
    expect(refusalOf(everyone, attempt("ada@example.org", "sso", "partner"))).toBeUndefined();
    expect(refusalOf(everyone, attempt("ada@example.org", "oidc"))).toBeUndefined();
    expect(refusalOf(everyone, attempt("ada@example.org", "password"))).toEqual({
      reason: "every account signs in through a provider",
    });
  });

  it("leaves instance admins exempt unless they are covered too", () => {
    const admin = attempt("ada@corp.example", "password", null, true);
    expect(refusalOf(rules(), admin)).toBeUndefined();
    expect(refusalOf(rules({ everyone: true }), admin)).toBeUndefined();
    expect(refusalOf(rules({ admins: true }), admin)).toBeDefined();
    expect(
      refusalOf(rules({ admins: true }), attempt("ada@corp.example", "sso", "corp", true)),
    ).toBeUndefined();
  });
});

describe("requiredBy and covers", () => {
  it("name an address's provider by its domain alone", () => {
    expect(requiredBy(rules(), "grace@corp.example")).toEqual({ id: "corp", name: "Corp SSO" });
    expect(requiredBy(rules(), "ada@partner.example")).toBeUndefined();
    expect(requiredBy(rules({ everyone: true }), "ada@partner.example")).toEqual({
      id: "partner",
      name: "Partner",
    });
    expect(requiredBy(rules({ everyone: true }), "ada@example.org")).toBeUndefined();
    expect(covers(rules(), "grace@corp.example")).toBe(true);
    expect(covers(rules(), "ada@example.org")).toBe(false);
    expect(covers(rules({ everyone: true }), "ada@example.org")).toBe(true);
  });
});

describe("Enforcement", () => {
  /** A database that answers every query with the rules above, and counts them. */
  function database() {
    const asked: string[] = [];
    const deleted: unknown[][] = [];
    const db = {
      query(sql: string, params: unknown[] = []) {
        asked.push(sql);
        if (sql.includes("instance_settings")) {
          return Promise.resolve({ rows: [{ key: "sso.everyone", value: false }] });
        }
        if (sql.startsWith("DELETE")) {
          deleted.push(params);
          return Promise.resolve({ rows: [] });
        }
        // Each session or token, and its account.
        if (sql.includes("JOIN users")) {
          const row = (id: string, user: string, email: string, method: string | null) => ({
            id,
            method,
            provider: method === "sso" ? "corp" : null,
            user_id: user,
            email,
            instance_admin: false,
          });
          return Promise.resolve({
            rows: [
              row("s1", "grace", "grace@corp.example", "password"),
              row("s2", "grace", "grace@corp.example", "sso"),
              row("s3", "ada", "ada@example.org", "password"),
              row("s4", "hal", "hal@corp.example", null),
            ],
          });
        }
        return Promise.resolve({
          rows: [{ domain: "corp.example", id: "corp", name: "Corp SSO", required: true }],
        });
      },
    } as unknown as Database;
    return { db, asked, deleted };
  }

  it("requires nothing while the feature is off, or the environment pins it off", async () => {
    const { db, asked } = database();
    const password = attempt("grace@corp.example", "password");
    const off = new Enforcement(db, () => Promise.resolve(false), true);
    expect(await off.check(password, db)).toBeUndefined();
    expect(await off.requiredFor("grace@corp.example")).toBeUndefined();
    const pinned = new Enforcement(db, () => Promise.resolve(true), false);
    expect(pinned.pinnedOff).toBe(true);
    expect(await pinned.check(password, db)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("reads the rules once in five seconds, and again when told", async () => {
    const { db, asked } = database();
    const on = new Enforcement(db, () => Promise.resolve(true), true);
    expect(await on.requiredFor("grace@corp.example")).toEqual({ id: "corp", name: "Corp SSO" });
    expect(await on.check(attempt("grace@corp.example", "password"), db)).toBeDefined();
    expect(await on.check(attempt("grace@corp.example", "sso", "corp"), db)).toBeUndefined();
    expect(asked).toHaveLength(2);
    on.forget();
    await on.check(attempt("grace@corp.example", "code"), db);
    expect(asked).toHaveLength(4);
  });

  it("ends the sessions and tokens the rules refuse as it sweeps, and closes their accounts' connections", async () => {
    const { db, deleted } = database();
    const on = new Enforcement(db, () => Promise.resolve(true), true);
    const closed: string[] = [];
    expect(
      await on.sweep((userId) => {
        closed.push(userId);
      }),
    ).toEqual({ sessions: 2, tokens: 2 });
    // Grace's password session and Hal's from before methods were kept, in both tables.
    expect(deleted).toEqual([[["s1", "s4"]], [["s1", "s4"]]]);
    expect(closed).toEqual(["grace", "hal"]);
    // Off, it sweeps nothing.
    const off = new Enforcement(db, () => Promise.resolve(false), true);
    expect(await off.sweep(() => undefined)).toEqual({ sessions: 0, tokens: 0 });
  });
});
