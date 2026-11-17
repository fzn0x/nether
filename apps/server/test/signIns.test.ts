// How each session and token began, and the guards a module adds (ADR
// 0080): asked before an account is looked up by its address, when a
// session starts and each time one is used, so a session begun a way its
// account may no longer use ends at its next request. A guard of the
// test's own stands in for single sign-on's.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterpriseModule } from "../src/enterprise.ts";
import { type Message } from "../src/mail.ts";
import { newToken, tokenHash } from "../src/sessions.ts";
import type { RequiredProvider, SignInAttempt } from "../src/signIns.ts";
import {
  type SetUp,
  type TestServer,
  TestMailer,
  admin,
  bearer,
  setUp,
  signIn,
  startServer,
} from "./app.ts";

/** What the test's guard refuses, and the provider it names for an address. */
interface Rules {
  refuse: (attempt: SignInAttempt) => boolean;
  required: (email: string) => RequiredProvider | undefined;
}

type Test = TestServer & SetUp & { mailer: TestMailer; rules: Rules; asked: SignInAttempt[] };

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const corp: RequiredProvider = { id: "corp", name: "Corp SSO" };
const bea = { name: "Bea", email: "bea@corp.example", password: "bea's long password" };

/** Refuses every way in but single sign-on to addresses at corp.example. */
const onlyCorp = (attempt: SignInAttempt) =>
  attempt.email.endsWith("@corp.example") &&
  !(attempt.method === "sso" && attempt.provider === "corp");

async function start(): Promise<Test> {
  const rules: Rules = { refuse: () => false, required: () => undefined };
  const asked: SignInAttempt[] = [];
  const guard: EnterpriseModule = {
    feature: "sso",
    plugin: (app, { guards }) => {
      const remove = guards.add({
        requiredFor: (email) => Promise.resolve(rules.required(email)),
        check: (attempt) => {
          asked.push(attempt);
          return Promise.resolve(
            rules.refuse(attempt) ? { reason: "the test says no" } : undefined,
          );
        },
      });
      app.addHook("onClose", (_instance, done) => {
        remove();
        done();
      });
      return Promise.resolve();
    },
  };
  const mailer = new TestMailer();
  running = await startServer({ mailer, enterpriseModules: [guard] });
  return { ...running, ...(await setUp(running)), mailer, rules, asked };
}

/** Bea's account, made by an invitation she accepts with a password. */
async function addBea(test: Test): Promise<{ token: string; userId: string }> {
  const invited = await test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/invitations`,
    headers: bearer(test.token),
    payload: { role: "member" },
  });
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: { token: invited.json<{ token: string }>().token, ...bea },
  });
  expect(accepted.statusCode, accepted.body).toBe(201);
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { token: body.token, userId: body.user.id };
}

/** A session begun through single sign-on's provider, as its module starts one. */
async function ssoSession(test: Test, userId: string, provider = "corp"): Promise<string> {
  const token = newToken();
  await test.db.query(
    `INSERT INTO sessions (id, user_id, token_hash, method, provider, expires_at)
     VALUES ($1, $2, $3, 'sso', $4, now() + interval '1 day')`,
    [randomUUID(), userId, tokenHash(token), provider],
  );
  return token;
}

function me(test: Test, token: string) {
  return test.server.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
}

function codeIn(message: Message): string {
  const code = /^ {4}(\d{4} \d{4})$/m.exec(message.text)?.[1];
  if (code === undefined) throw new Error(`No code in ${message.text}`);
  return code;
}

describe("how a session began", () => {
  it("is kept for each way in, and a token keeps its session's", async () => {
    const test = await start();
    await addBea(test);
    await signIn(test.server, admin.email, admin.password);
    await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes",
      payload: { email: bea.email },
    });
    const code = codeIn(await test.mailer.next());
    const redeemed = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes/redeem",
      payload: { email: bea.email, code },
    });
    expect(redeemed.statusCode).toBe(201);
    const { rows } = await test.db.query(
      `SELECT u.name, s.method, s.provider FROM sessions s JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at, s.method`,
    );
    expect(rows).toEqual([
      { name: "Ada", method: "setup", provider: null },
      { name: "Bea", method: "invitation", provider: null },
      { name: "Ada", method: "password", provider: null },
      { name: "Bea", method: "code", provider: null },
    ]);

    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(test.token),
      payload: { name: "Script", access: "read", password: admin.password },
    });
    expect(made.statusCode).toBe(201);
    const tokens = await test.db.query("SELECT method, provider FROM api_tokens");
    expect(tokens.rows).toEqual([{ method: "setup", provider: null }]);
    // The guards were asked as each session started, with what it was.
    expect(test.asked).toContainEqual({
      userId: test.userId,
      email: admin.email,
      instanceAdmin: true,
      method: "password",
      provider: null,
    });
  });
});

describe("a guard", () => {
  it("refuses a password as a wrong one, or names the provider an address must use", async () => {
    const test = await start();
    await addBea(test);
    test.rules.refuse = onlyCorp;
    const refused = await signIn(test.server, bea.email, bea.password);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({
      message: "That email address and password do not match an account.",
    });
    // Named by the domain alone, right password or wrong.
    test.rules.required = (email) => (email.endsWith("@corp.example") ? corp : undefined);
    for (const password of [bea.password, "not her password"]) {
      const named = await signIn(test.server, bea.email, password);
      expect(named.statusCode).toBe(403);
      expect(named.json()).toEqual({
        statusCode: 403,
        error: "Forbidden",
        message: "Addresses at corp.example sign in with Corp SSO.",
        sso: corp,
      });
    }
    const unknown = await signIn(test.server, "eve@corp.example", "a long password");
    expect(unknown.json()).toMatchObject({ sso: corp });
    // Others sign in as before.
    expect((await signIn(test.server, admin.email, admin.password)).statusCode).toBe(201);
  });

  it("ends a session and a token at their next use once it refuses them", async () => {
    const test = await start();
    const beaSession = await addBea(test);
    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(beaSession.token),
      payload: { name: "Script", access: "read", password: bea.password },
    });
    const token = made.json<{ token: string }>().token;
    const sso = await ssoSession(test, beaSession.userId);
    const api = () =>
      test.server.inject({ method: "GET", url: "/api/v1/me", headers: bearer(token) });
    expect((await me(test, beaSession.token)).statusCode).toBe(200);
    expect((await api()).statusCode).toBe(200);

    test.rules.refuse = onlyCorp;
    expect((await me(test, beaSession.token)).statusCode).toBe(401);
    expect((await api()).statusCode).toBe(401);
    // Deleted, not paused: no longer refusing revives nothing.
    test.rules.refuse = () => false;
    expect((await me(test, beaSession.token)).statusCode).toBe(401);
    expect((await api()).statusCode).toBe(401);
    // The session through the provider goes on.
    expect((await me(test, sso)).statusCode).toBe(200);
    const { rows } = await test.db.query(
      "SELECT method FROM sessions WHERE user_id = $1 ORDER BY method",
      [beaSession.userId],
    );
    expect(rows).toEqual([{ method: "sso" }]);
    const tokens = await test.db.query("SELECT 1 FROM api_tokens");
    expect(tokens.rows).toEqual([]);
  });

  it("gets no code sent, with the same answer, and a code redeemed answers as a wrong one", async () => {
    const test = await start();
    await addBea(test);
    test.rules.refuse = onlyCorp;
    for (const email of [bea.email, "eve@corp.example"]) {
      const asked = await test.server.inject({
        method: "POST",
        url: "/api/sign-in-codes",
        payload: { email },
      });
      expect(asked.statusCode).toBe(202);
    }
    await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes",
      payload: { email: admin.email },
    });
    // Only Ada's came: Bea's was never sent.
    expect(test.mailer.sent.map((message) => message.to)).toEqual([admin.email]);
    const redeemed = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes/redeem",
      payload: { email: bea.email, code: "1234 5678" },
    });
    expect(redeemed.statusCode).toBe(401);
    test.rules.required = () => corp;
    const named = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes/redeem",
      payload: { email: bea.email, code: "1234 5678" },
    });
    expect(named.statusCode).toBe(403);
    expect(named.json()).toMatchObject({ sso: corp });
  });

  it("refuses an invitation's new account a password, and keeps nothing it made", async () => {
    const test = await start();
    test.rules.refuse = onlyCorp;
    test.rules.required = (email) => (email.endsWith("@corp.example") ? corp : undefined);
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const invitation = invited.json<{ token: string }>().token;
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: { token: invitation, ...bea },
    });
    expect(accepted.statusCode).toBe(403);
    expect(accepted.json()).toMatchObject({ sso: corp });
    const { rows } = await test.db.query("SELECT email FROM users ORDER BY email");
    expect(rows).toEqual([{ email: admin.email }]);
    // The invitation is still open, for the provider's sign-in to accept.
    const open = await test.db.query("SELECT accepted_at FROM invitations");
    expect(open.rows).toEqual([{ accepted_at: null }]);
  });

  it("refuses a new password, and counts a fresh sign-in, not the password, as signing in again", async () => {
    const test = await start();
    const { userId } = await addBea(test);
    test.rules.refuse = onlyCorp;
    const sso = await ssoSession(test, userId);
    const changed = await test.server.inject({
      method: "PUT",
      url: "/api/me/password",
      headers: bearer(sso),
      payload: { current: bea.password, password: "a new long password" },
    });
    expect(changed.statusCode).toBe(403);
    expect(changed.json()).toMatchObject({
      message: "This account signs in with single sign-on: it takes no password.",
    });
    // Signed in through the provider just now, it may make a token with no password.
    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(sso),
      payload: { name: "Script", access: "read" },
    });
    expect(made.statusCode).toBe(201);
    const tokens = await test.db.query("SELECT method, provider FROM api_tokens");
    expect(tokens.rows).toEqual([{ method: "sso", provider: "corp" }]);
    // Ten minutes on, it signs in again first, and its password does not count.
    await test.db.query("UPDATE sessions SET created_at = now() - interval '11 minutes'");
    const later = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(sso),
      payload: { name: "Script", access: "read", password: bea.password },
    });
    expect(later.statusCode).toBe(403);
  });
});
