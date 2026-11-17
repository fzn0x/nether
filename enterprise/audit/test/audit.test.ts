// Audit logs (ADR 0081): nothing while the feature is off; then every
// sign-in, permission change, share, export and deletion, recorded in the
// transaction of its change as the next row of a chain that a changed or
// missing row breaks; searched by instance admins, purged when old, with
// its own settings recorded too.
import { randomBytes, randomUUID } from "node:crypto";
import { pkceChallenge } from "@nether/server/src/oidc.ts";
import { storeDocument } from "@nether/server/src/sync.ts";
import { deactivateAccount } from "@nether/server/src/accounts.ts";
import type { EnterpriseModule, EnterpriseServices } from "@nether/server/src/enterprise.ts";
import { fromServer, serverActions } from "@nether/server/src/events.ts";
import {
  type SetUp,
  type TestServer,
  admin,
  bearer,
  setUp,
  signIn,
  startServer,
} from "@nether/server/test/app.ts";
import { type TestProvider, startProvider } from "@nether/server/test/provider.ts";
import { adminModule } from "@nether/enterprise-admin";
import { ssoModule } from "@nether/enterprise-sso";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AuditRow,
  actionGroups,
  chainKey,
  checkLog,
  createAuditModule,
  keepUp,
  purge,
  record,
  searchLog,
} from "../src/index.ts";

/** A server, its setup, and how many rows the log had once it was set up. */
type Test = TestServer & SetUp & { readonly since: number };
let running: Test | undefined;
let provider: TestProvider | undefined;

afterEach(async () => {
  await running?.close();
  await provider?.close();
  running = undefined;
  provider = undefined;
});

const secret = Buffer.alloc(32, 7).toString("base64");

async function start(
  env: Record<string, string> = { NETHER_ENTERPRISE_AUDIT: "on" },
  moduleEnv: Record<string, string> = {},
): Promise<Test> {
  const server = await startServer({
    env,
    // Single sign-on's too, off unless a test turns it on, as in the image.
    enterpriseModules: [createAuditModule(moduleEnv), adminModule, ssoModule],
  });
  const set = await setUp(server);
  const { rows: counted } = await server.db.query("SELECT count(*) AS count FROM audit_events");
  running = { ...server, ...set, since: Number(counted[0]?.count ?? 0) };
  return running;
}

/** The log's rows, oldest first, straight from the table. */
async function rows(test: Test): Promise<AuditRow[]> {
  const all = (await searchLog(test.db, { limit: 1000 })).events.reverse();
  return all.filter((row) => row.seq > test.since);
}

function actions(log: readonly AuditRow[]): string[] {
  return log.map((row) => `${row.action}${row.outcome === "failure" ? " (failed)" : ""}`);
}

function events(test: Test, query = "", token = test.token) {
  return test.server.inject({
    method: "GET",
    url: `/api/audit/events${query}`,
    headers: bearer(token),
  });
}

/** A vault document listing notes by ID and path. */
function vaultState(paths: Record<string, string>): Uint8Array {
  const document = new Y.Doc();
  const notes = document.getMap<string>("notes");
  for (const [id, path] of Object.entries(paths)) notes.set(id, path);
  return Y.encodeStateAsUpdate(document);
}

describe("the audit log", () => {
  it("records nothing while off, and records being turned on", async () => {
    const test = await start({ NETHER_ENTERPRISE_AUDIT: "", NETHER_LOG_LEVEL: "silent" });
    expect((await events(test)).statusCode).toBe(404);
    // Setup and signing in are not recorded while the feature is off.
    expect((await signIn(test.server, admin.email, admin.password)).statusCode).toBe(201);
    expect(await rows(test)).toEqual([]);
    const on = await test.server.inject({
      method: "PUT",
      url: "/api/instance/features/audit",
      headers: bearer(test.token),
      payload: { on: true },
    });
    expect(on.statusCode).toBe(200);
    const log = await rows(test);
    expect(actions(log)).toEqual(["instance.feature_changed"]);
    expect(log[0]).toMatchObject({
      actorType: "account",
      actorId: test.userId,
      actorName: admin.name,
      actorEmail: admin.email,
      targetId: "audit",
      details: { feature: "audit", on: true },
      address: "127.0.0.1",
      seq: 1,
      prevHash: "",
    });
    // Turned off again, that is recorded, and then nothing.
    await test.server.inject({
      method: "PUT",
      url: "/api/instance/features/audit",
      headers: bearer(test.token),
      payload: { on: false },
    });
    await signIn(test.server, admin.email, "a wrong password");
    expect(actions(await rows(test))).toEqual([
      "instance.feature_changed",
      "instance.feature_changed",
    ]);
  });

  it("records the server's setup when the environment turns it on from the start", async () => {
    const test = await start();
    expect(test.since).toBe(3);
    const log = (await searchLog(test.db, { limit: 10 })).events.reverse();
    expect(actions(log)).toEqual(["account.created", "workspace.created", "session.signed_in"]);
    expect(log[0]).toMatchObject({ targetName: admin.name, details: { by: "setup" } });
    expect(log[1]).toMatchObject({ workspaceName: admin.workspace, targetName: admin.workspace });
    expect(log[2]).toMatchObject({ actorId: test.userId, details: { method: "setup" } });
  });

  it("records sign-ins and their failures, with who, from where and how", async () => {
    const test = await start();
    await signIn(test.server, admin.email, "a wrong password", "curl/8");
    await signIn(test.server, "nobody@example.org", "a wrong password");
    const good = await signIn(test.server, admin.email, admin.password, "Firefox");
    const token = good.json<{ token: string }>().token;
    await test.server.inject({
      method: "DELETE",
      url: "/api/sessions/current",
      headers: bearer(token),
    });
    const log = await rows(test);
    expect(actions(log)).toEqual([
      "session.signed_in (failed)",
      "session.signed_in (failed)",
      "session.signed_in",
      "session.signed_out",
    ]);
    expect(log[0]).toMatchObject({
      reason: "wrong password",
      actorId: test.userId,
      userAgent: "curl/8",
      details: { method: "password" },
    });
    // Someone with no account is named by the email they typed.
    expect(log[1]).toMatchObject({
      reason: "no such account",
      actorType: "anonymous",
      actorId: null,
      actorEmail: "nobody@example.org",
    });
    expect(log[2]).toMatchObject({ userAgent: "Firefox", details: { method: "password" } });
  });

  it("records sign-ins through single sign-on's providers as core's, by the provider", async () => {
    const test = await start({
      NETHER_ENTERPRISE_AUDIT: "on",
      NETHER_ENTERPRISE_SSO: "on",
      NETHER_PUBLIC_URL: "https://nether.example.org",
      NETHER_SECRET_KEY: secret,
      NETHER_SSO_PRIVATE: "loopback",
    });
    provider = await startProvider();
    const added = await test.server.inject({
      method: "POST",
      url: "/api/admin/sso/providers",
      headers: bearer(test.token),
      payload: {
        id: "okta",
        name: "Okta",
        domains: ["corp.example"],
        oidc: {
          issuer: provider.issuer,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
        },
      },
    });
    expect(added.statusCode, added.body).toBe(201);
    const idp = provider;
    // A flow as the app runs it, to the address the provider sends the browser back to.
    async function signInThrough() {
      const verifier = randomBytes(32).toString("base64url");
      const started = await test.server.inject({
        method: "POST",
        url: "/api/sso/okta/flows",
        payload: {
          redirect: "http://127.0.0.1:43123/signed-in",
          challenge: pkceChallenge(verifier),
        },
      });
      const callback = new URL(idp.authorize(started.json<{ url: string }>().url));
      const answered = await test.server.inject({
        method: "GET",
        url: callback.pathname + callback.search,
        headers: { "user-agent": "Firefox" },
      });
      const code = new URL(String(answered.headers.location)).searchParams.get("code");
      return { code, verifier };
    }
    const redeem = (code: string, verifier: string) =>
      test.server.inject({ method: "POST", url: "/api/sso/redeem", payload: { code, verifier } });

    // A first sign-in at its domain makes the account, then signs it in.
    idp.person = { sub: "grace-oid", email: "grace@corp.example", name: "Grace" };
    const first = await signInThrough();
    const session = await redeem(first.code ?? "", first.verifier);
    expect(session.statusCode, session.body).toBe(201);
    const grace = session.json<{ user: { id: string } }>().user.id;
    // An address outside its domains that it has not verified links nothing.
    idp.person = { sub: "ada-oid", email: "ada@example.org", name: "Ada" };
    expect((await signInThrough()).code).toBeNull();
    // A code redeemed by an app that did not begin it.
    idp.person = { sub: "grace-oid", email: "grace@corp.example", name: "Grace" };
    const stolen = await signInThrough();
    expect(
      (await redeem(stolen.code ?? "", randomBytes(32).toString("base64url"))).statusCode,
    ).toBe(401);

    const log = await rows(test);
    expect(actions(log)).toEqual([
      "account.created",
      "session.signed_in",
      "session.signed_in (failed)",
      "session.signed_in (failed)",
    ]);
    const by = { method: "sso", provider: "okta" };
    expect(log[0]).toMatchObject({
      actorId: grace,
      targetName: "Grace",
      userAgent: "Firefox",
      details: { by: "sso", provider: "okta" },
    });
    expect(log[1]).toMatchObject({
      actorId: grace,
      actorEmail: "grace@corp.example",
      details: by,
    });
    expect(log[2]).toMatchObject({
      reason: "email not verified",
      actorType: "anonymous",
      actorEmail: "ada@example.org",
      details: by,
    });
    expect(log[3]).toMatchObject({
      reason: "not the app that began it",
      actorId: grace,
      details: by,
    });
  });

  it("records permission changes, shares, exports and deletions", async () => {
    const test = await start();
    const headers = bearer(test.token);
    // An invitation, accepted: a new account, joined, then its role changed.
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers,
      payload: { role: "member" },
    });
    const invitation = invited.json<{ id: string; token: string }>();
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invitation.token,
        name: "Bea",
        email: "bea@example.org",
        password: "another long password",
      },
    });
    const bea = accepted.json<{ user: { id: string } }>().user.id;
    await test.server.inject({
      method: "PATCH",
      url: `/api/workspaces/${test.workspaceId}/members/${bea}`,
      headers,
      payload: { role: "admin" },
    });
    // A token, made, used to read through the API, then revoked.
    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers,
      payload: { name: "Script", access: "write", password: admin.password },
    });
    const apiToken = made.json<{ id: string; token: string }>();
    const note = randomUUID();
    await storeDocument(test.db, test.workspaceId, note, Y.encodeStateAsUpdate(new Y.Doc()));
    await storeDocument(test.db, test.workspaceId, "vault", vaultState({ [note]: "Plans.md" }));
    const read = await test.server.inject({
      method: "GET",
      url: `/api/v1/workspaces/${test.workspaceId}/notes/${note}`,
      headers: bearer(apiToken.token),
    });
    expect(read.statusCode).toBe(200);
    const deleted = await test.server.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${test.workspaceId}/notes/${note}`,
      headers: bearer(apiToken.token),
    });
    expect(deleted.statusCode).toBe(204);
    await test.server.inject({ method: "DELETE", url: `/api/tokens/${apiToken.id}`, headers });

    const log = await rows(test);
    expect(actions(log)).toEqual([
      "invitation.created",
      "account.created",
      "invitation.accepted",
      "member.joined",
      "session.signed_in",
      "member.role_changed",
      "token.created",
      "note.read_by_api",
      "note.deleted",
      "token.revoked",
    ]);
    const by = (action: string) => log.find((row) => row.action === action);
    expect(by("member.role_changed")).toMatchObject({
      workspaceId: test.workspaceId,
      workspaceName: admin.workspace,
      targetType: "account",
      targetId: bea,
      targetName: "Bea",
      details: { from: "member", to: "admin" },
    });
    expect(by("session.signed_in")).toMatchObject({
      actorId: bea,
      details: { method: "invitation" },
    });
    // The API's reads name the token, and the note by its ID and title, never its text.
    expect(by("note.read_by_api")).toMatchObject({
      actorId: test.userId,
      tokenId: apiToken.id,
      tokenName: "Script",
      targetId: note,
      targetName: "Plans",
      details: { notes: [note], more: 0 },
    });
    expect(by("note.deleted")).toMatchObject({
      actorId: test.userId,
      tokenName: "Script",
      targetId: note,
      targetName: "Plans",
      details: { path: "Plans.md", via: "api" },
    });
    expect(by("token.revoked")).toMatchObject({ targetId: apiToken.id, targetName: "Script" });
  });

  it("records a role an instance admin sets from the console, as theirs", async () => {
    const test = await start({ NETHER_ENTERPRISE_AUDIT: "on", NETHER_ENTERPRISE_ADMIN: "on" });
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invited.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "another long password",
      },
    });
    const bea = accepted.json<{ user: { id: string } }>().user.id;
    const set = await test.server.inject({
      method: "PATCH",
      url: `/api/admin/workspaces/${test.workspaceId}/members/${bea}`,
      headers: bearer(test.token),
      payload: { role: "owner" },
    });
    expect(set.statusCode).toBe(200);
    expect((await rows(test)).at(-1)).toMatchObject({
      action: "member.role_changed",
      actorId: test.userId,
      targetId: bea,
      details: { from: "member", to: "owner", as: "instance-admin" },
    });
  });

  it("records a directory as who deactivated an account, and puts every action in one group", async () => {
    let services: EnterpriseServices | undefined;
    // What a module is given, as the scim module will be.
    const capture: EnterpriseModule = {
      feature: "scim",
      plugin: (_app, context) => {
        services = context;
        return Promise.resolve();
      },
    };
    const server = await startServer({
      env: { NETHER_ENTERPRISE_AUDIT: "on" },
      enterpriseModules: [createAuditModule({}), capture],
    });
    const set = await setUp(server);
    const { rows: counted } = await server.db.query("SELECT count(*) AS count FROM audit_events");
    const test: Test = { ...server, ...set, since: Number(counted[0]?.count ?? 0) };
    running = test;
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invited.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "another long password",
      },
    });
    const bea = accepted.json<{ user: { id: string } }>().user.id;
    const events = services?.events;
    if (events === undefined) throw new Error("The module was not registered.");
    await test.db.transaction((tx) =>
      deactivateAccount(
        tx,
        bea,
        { actor: { kind: "directory", id: "okta", name: "Okta" }, origin: fromServer },
        events,
      ),
    );
    expect((await rows(test)).at(-1)).toMatchObject({
      action: "account.deactivated",
      actorType: "directory",
      actorId: "okta",
      actorName: "Okta",
      actorEmail: null,
      targetType: "account",
      targetId: bea,
      targetName: "Bea",
      details: { sessions: 1, tokens: [] },
    });
    const found = await test.server.inject({
      method: "GET",
      url: "/api/audit/events?actor=okta&group=signIns",
      headers: bearer(test.token),
    });
    expect(found.json<{ events: unknown[] }>().events).toMatchObject([
      {
        action: "account.deactivated",
        actor: { type: "directory", id: "okta", name: "Okta", email: null },
      },
    ]);
    const grouped: readonly string[] = Object.values(actionGroups).flat();
    for (const action of serverActions) {
      expect(
        grouped.filter((each) => each === action),
        action,
      ).toHaveLength(1);
    }
  });

  it("keeps a chain that checks, and shows a row changed or missing", async () => {
    const test = await start({ NETHER_ENTERPRISE_AUDIT: "on", NETHER_SECRET_KEY: secret });
    for (const password of ["one wrong", "two wrong", "three wrong"]) {
      await signIn(test.server, admin.email, password);
    }
    const key = chainKey(Buffer.from(secret, "base64"));
    const last = test.since + 3;
    expect(await checkLog(test.db, key)).toMatchObject({
      checked: last,
      from: 1,
      to: last,
      keyed: true,
      broken: null,
    });
    // Without the key, the chain does not check: someone with the database alone cannot remake it.
    expect((await checkLog(test.db, null)).broken).toEqual({
      seq: 1,
      problem: "its fields are not what its hash says",
    });
    // The app's side cannot change or remove a row.
    await expect(
      test.db.query(`UPDATE audit_events SET reason = 'nothing' WHERE seq = ${String(last - 1)}`),
    ).rejects.toThrow("append-only");
    await expect(
      test.db.query(`DELETE FROM audit_events WHERE seq = ${String(last - 1)}`),
    ).rejects.toThrow("append-only");
    await expect(test.db.query("TRUNCATE audit_events")).rejects.toThrow("append-only");
    // Someone who owns the database can; the chain shows where.
    await test.db.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await test.db.query(
      `UPDATE audit_events SET reason = 'nothing' WHERE seq = ${String(last - 1)}`,
    );
    expect((await checkLog(test.db, key)).broken).toEqual({
      seq: last - 1,
      problem: "its fields are not what its hash says",
    });
    await test.db.query(`DELETE FROM audit_events WHERE seq = ${String(last - 1)}`);
    expect((await checkLog(test.db, key)).broken).toEqual({
      seq: last,
      problem: "a row before it is missing",
    });
  });

  it("checks from the console, and records the check with what it found", async () => {
    const test = await start();
    await signIn(test.server, admin.email, "a wrong password");
    const checked = await test.server.inject({
      method: "POST",
      url: "/api/audit/check",
      headers: bearer(test.token),
    });
    expect(checked.statusCode).toBe(200);
    const last = test.since + 1;
    expect(checked.json()).toMatchObject({ checked: last, keyed: false, broken: null });
    const log = await rows(test);
    expect(log.at(-1)).toMatchObject({
      action: "audit.checked",
      outcome: "success",
      actorId: test.userId,
      details: { checked: last, from: 1, to: last, brokenAt: null },
    });
  });

  it("starts a new segment when the key changes", async () => {
    const test = await start();
    await signIn(test.server, admin.email, "a wrong password");
    const key = chainKey(Buffer.from(secret, "base64"));
    await test.db.transaction((tx) =>
      record(
        tx,
        {
          action: "audit.checked",
          actor: { kind: "system" },
          origin: { address: null, userAgent: null },
        },
        key,
      ),
    );
    const log = await rows(test);
    expect(actions(log)).toEqual([
      "session.signed_in (failed)",
      "audit.key_changed",
      "audit.checked",
    ]);
    expect(log[1]?.details).toMatchObject({ from: "none", keyed: true });
    // Its hashes check from the change on; the rows before by their links.
    expect(await checkLog(test.db, key)).toMatchObject({
      broken: null,
      hashesFrom: test.since + 2,
      checked: test.since + 3,
    });
  });

  it("purges old events, never the newest, and the chain still checks from the oldest kept", async () => {
    const test = await start();
    for (const password of ["one wrong", "two wrong", "three wrong"]) {
      await signIn(test.server, admin.email, password);
    }
    const before = await rows(test);
    // Kept no days: every event but the newest goes.
    const last = test.since + 3;
    expect(await purge(test.db, 0, null)).toBe(last - 1);
    const log = await rows(test);
    expect(actions(log)).toEqual(["session.signed_in (failed)", "audit.purged"]);
    expect(log[0]?.seq).toBe(last);
    expect(log[1]?.details).toEqual({
      count: last - 1,
      throughSeq: last - 1,
      throughHash: before[1]?.hash,
      retentionDays: 0,
    });
    expect(await checkLog(test.db, null)).toMatchObject({ broken: null, from: last, checked: 2 });
    expect(await purge(test.db, 365, null)).toBe(0);
  });

  it("purges nothing while a workspace is on legal hold, and checkpoints still", async () => {
    const test = await start();
    for (const password of ["one wrong", "two wrong"]) {
      await signIn(test.server, admin.email, password);
    }
    const before = await rows(test);
    const held = await keepUp(test.db, null, 0, () => Promise.resolve(true));
    expect(held.purged).toBeNull();
    expect(held.head).toBeDefined();
    // Every event is still there, with the checkpoint after them.
    expect((await rows(test)).slice(0, before.length)).toEqual(before);
    const free = await keepUp(test.db, null, 0, () => Promise.resolve(false));
    expect(free.purged).toBeGreaterThan(0);
  });

  it("is searched by instance admins alone: by group, actor, email, outcome and time, a page at a time", async () => {
    const test = await start();
    await signIn(test.server, "nobody@example.org", "a wrong password");
    for (let index = 0; index < 3; index++) {
      await signIn(test.server, admin.email, admin.password);
    }
    await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const first = await events(test, "?group=signIns&limit=2");
    expect(first.statusCode).toBe(200);
    const page = first.json<{ events: { seq: number; action: string }[]; next: number }>();
    const s = test.since;
    expect(page.events.map((event) => event.seq)).toEqual([s + 4, s + 3]);
    expect(page.next).toBe(s + 3);
    const second = (await events(test, `?group=signIns&limit=2&before=${String(page.next)}`)).json<{
      events: { seq: number }[];
      next: number | null;
    }>();
    expect(second.events.map((event) => event.seq)).toEqual([s + 2, s + 1]);
    // Setup's own sign-in comes next.
    expect(second.next).toBe(s + 1);
    const failed = (await events(test, "?outcome=failure")).json<{
      events: { actor: { email: string | null }; reason: string }[];
    }>();
    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]).toMatchObject({
      actor: { email: "nobody@example.org" },
      reason: "no such account",
    });
    expect(
      (await events(test, "?email=NOBODY@example.org")).json<{ events: unknown[] }>().events,
    ).toHaveLength(1);
    expect(
      (await events(test, `?actor=${test.userId}&group=shares`)).json<{
        events: { action: string; workspace: { name: string } }[];
      }>().events,
    ).toMatchObject([{ action: "invitation.created", workspace: { name: admin.workspace } }]);
    // The filter offers accounts by name or email, and the workspaces.
    const offered = await test.server.inject({
      method: "GET",
      url: "/api/audit/actors?q=ad",
      headers: bearer(test.token),
    });
    expect(offered.json()).toEqual({
      actors: [{ id: test.userId, name: admin.name, email: admin.email }],
    });
    const places = await test.server.inject({
      method: "GET",
      url: "/api/audit/workspaces",
      headers: bearer(test.token),
    });
    expect(places.json()).toEqual({
      workspaces: [{ id: test.workspaceId, name: admin.workspace }],
    });
    const later = new Date(Date.now() + 60_000).toISOString();
    expect((await events(test, `?from=${later}`)).json<{ events: unknown[] }>().events).toEqual([]);
    // Someone not an instance admin is refused.
    const bea = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: (
          await test.server.inject({
            method: "POST",
            url: `/api/workspaces/${test.workspaceId}/invitations`,
            headers: bearer(test.token),
            payload: { role: "admin" },
          })
        ).json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "another long password",
      },
    });
    expect((await events(test, "", bea.json<{ token: string }>().token)).statusCode).toBe(403);
  });

  it("keeps its own retention, records a change to it, and lets the environment pin it", async () => {
    const test = await start();
    const read = await test.server.inject({
      method: "GET",
      url: "/api/audit/settings",
      headers: bearer(test.token),
    });
    expect(read.json()).toMatchObject({ retentionDays: 365, pinned: false, keyed: false });
    const changed = await test.server.inject({
      method: "PUT",
      url: "/api/audit/settings",
      headers: bearer(test.token),
      payload: { retentionDays: 90 },
    });
    expect(changed.json()).toEqual({ retentionDays: 90 });
    const tooShort = await test.server.inject({
      method: "PUT",
      url: "/api/audit/settings",
      headers: bearer(test.token),
      payload: { retentionDays: 7 },
    });
    expect(tooShort.statusCode).toBe(400);
    expect((await rows(test)).at(-1)).toMatchObject({
      action: "audit.retention_changed",
      details: { from: 365, to: 90 },
    });
    await running?.close();
    const pinned = await start(
      { NETHER_ENTERPRISE_AUDIT: "on" },
      { NETHER_AUDIT_RETENTION_DAYS: "400" },
    );
    const set = await pinned.server.inject({
      method: "PUT",
      url: "/api/audit/settings",
      headers: bearer(pinned.token),
      payload: { retentionDays: 90 },
    });
    expect(set.statusCode).toBe(409);
    expect(() => createAuditModule({ NETHER_AUDIT_RETENTION_DAYS: "5" })).toThrow(
      "NETHER_AUDIT_RETENTION_DAYS",
    );
  });

  it("fails a change it cannot record, which then does not happen", async () => {
    const test = await start();
    await test.db.query("ALTER TABLE audit_events RENAME TO audit_events_gone");
    const out = await test.server.inject({
      method: "DELETE",
      url: "/api/sessions/current",
      headers: bearer(test.token),
    });
    expect(out.statusCode).toBe(500);
    // The session is still there: its end rolled back with its record.
    const { rows: sessions } = await test.db.query("SELECT 1 FROM sessions WHERE user_id = $1", [
      test.userId,
    ]);
    expect(sessions).toHaveLength(1);
    // A failed attempt still answers as it would.
    expect((await signIn(test.server, admin.email, "a wrong password")).statusCode).toBe(401);
  });
});
