// Personal access tokens (ADR 0059): made with the account's password and
// shown once, kept as hashes, listed and revoked with a session; working on
// the public API alone, until they expire or are revoked.
import { afterEach, describe, expect, it } from "vitest";
import { tokenHash } from "../src/sessions.ts";
import { maxTokens, tokenPrefix } from "../src/tokens.ts";
import { type SetUp, type TestServer, admin, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Test = TestServer & SetUp;

async function start(): Promise<Test> {
  running = await startServer();
  return { ...running, ...(await setUp(running)) };
}

interface Made {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly access: string;
  readonly hint: string;
  readonly workspace: { readonly id: string; readonly name: string } | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly usedAt: string | null;
}

function make(test: Test, payload: object, session = test.token) {
  return test.server.inject({
    method: "POST",
    url: "/api/tokens",
    headers: bearer(session),
    payload: { password: admin.password, ...payload },
  });
}

async function made(test: Test, payload: object): Promise<Made> {
  const response = await make(test, payload);
  expect(response.statusCode).toBe(201);
  return response.json<Made>();
}

function me(test: Test, token: string) {
  return test.server.inject({ method: "GET", url: "/api/v1/me", headers: bearer(token) });
}

describe("tokens", () => {
  it("are made with the password, shown once, and kept as their hash", async () => {
    const test = await start();
    const token = await made(test, { name: " Backups script ", access: "read" });
    expect(token.token.startsWith(tokenPrefix)).toBe(true);
    expect(token.token).toHaveLength(tokenPrefix.length + 43);
    expect(token).toMatchObject({
      name: "Backups script",
      access: "read",
      hint: token.token.slice(-4),
      workspace: null,
      expiresAt: null,
      usedAt: null,
    });
    const { rows } = await test.db.query("SELECT token_hash FROM api_tokens WHERE id = $1", [
      token.id,
    ]);
    expect(rows[0]?.token_hash).toBe(tokenHash(token.token));

    const listed = await test.server.inject({
      method: "GET",
      url: "/api/tokens",
      headers: bearer(test.token),
    });
    const { token: secret, ...shown } = token;
    expect(secret).not.toBe("");
    expect(listed.json()).toEqual({ tokens: [shown] });
    expect(listed.body).not.toContain(token.token);
  });

  it("are refused without the account's password", async () => {
    const test = await start();
    const wrong = await make(test, { name: "Script", access: "read", password: "not it" });
    expect(wrong.statusCode).toBe(403);
    const none = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(test.token),
      payload: { name: "Script", access: "read" },
    });
    expect(none.statusCode).toBe(403);
    const unsigned = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      payload: { name: "Script", access: "read", password: admin.password },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it("take, for an account without a password, a sign-in within the last minutes", async () => {
    const test = await start();
    await test.db.query("UPDATE users SET password_hash = NULL WHERE id = $1", [test.userId]);
    const fresh = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(test.token),
      payload: { name: "Script", access: "write" },
    });
    expect(fresh.statusCode).toBe(201);
    await test.db.query(
      "UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE user_id = $1",
      [test.userId],
    );
    const stale = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(test.token),
      payload: { name: "Script", access: "write" },
    });
    expect(stale.statusCode).toBe(403);
  });

  it("reach one workspace of the account's, or expire after the days asked", async () => {
    const test = await start();
    const one = await made(test, { name: "One", access: "write", workspace: test.workspaceId });
    expect(one.workspace).toEqual({ id: test.workspaceId, name: admin.workspace });
    const elsewhere = await make(test, {
      name: "Elsewhere",
      access: "read",
      workspace: "00000000-0000-4000-8000-000000000000",
    });
    expect(elsewhere.statusCode).toBe(404);

    const before = Date.now();
    const month = await made(test, { name: "Month", access: "read", expiresInDays: 30 });
    const expires = Date.parse(month.expiresAt ?? "");
    expect(expires).toBeGreaterThan(before + 29.9 * 86_400_000);
    expect(expires).toBeLessThan(Date.now() + 30.1 * 86_400_000);
    const tooLong = await make(test, { name: "Long", access: "read", expiresInDays: 367 });
    expect(tooLong.statusCode).toBe(400);
  });

  it("work on the public API until they expire, and are marked used", async () => {
    const test = await start();
    const token = await made(test, { name: "Script", access: "read" });
    const answer = await me(test, token.token);
    expect(answer.statusCode).toBe(200);
    const { token: secret, ...shown } = token;
    expect(secret).not.toBe("");
    expect(answer.json()).toEqual({
      user: { id: test.userId, name: admin.name, email: admin.email },
      token: { ...shown, usedAt: null },
    });
    const { rows } = await test.db.query("SELECT used_at FROM api_tokens WHERE id = $1", [
      token.id,
    ]);
    expect(rows[0]?.used_at).toBeInstanceOf(Date);

    await test.db.query(
      "UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1",
      [token.id],
    );
    const expired = await me(test, token.token);
    expect(expired.statusCode).toBe(401);
    expect(expired.headers["www-authenticate"]).toBe("Bearer");
  });

  it("work nowhere but the public API", async () => {
    const test = await start();
    const token = await made(test, { name: "Script", access: "write" });
    for (const [method, url] of [
      ["GET", "/api/tokens"],
      ["GET", "/api/me"],
      ["GET", "/api/sessions"],
      ["GET", `/api/workspaces/${test.workspaceId}/units`],
      ["GET", `/api/search?q=plan`],
    ] as const) {
      const answer = await test.server.inject({ method, url, headers: bearer(token.token) });
      expect(answer.statusCode, url).toBe(401);
    }
    const making = await make(test, { name: "Another", access: "read" }, token.token);
    expect(making.statusCode).toBe(401);
  });

  it("are revoked at once, each by its own account only", async () => {
    const test = await start();
    const token = await made(test, { name: "Script", access: "read" });
    const missing = await test.server.inject({
      method: "DELETE",
      url: "/api/tokens/00000000-0000-4000-8000-000000000000",
      headers: bearer(test.token),
    });
    expect(missing.statusCode).toBe(404);
    const revoked = await test.server.inject({
      method: "DELETE",
      url: `/api/tokens/${token.id}`,
      headers: bearer(test.token),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await me(test, token.token)).statusCode).toBe(401);
  });

  it("stay when the account signs out or ends its other sessions", async () => {
    const test = await start();
    const token = await made(test, { name: "Script", access: "read" });
    await test.server.inject({
      method: "POST",
      url: "/api/sessions/revoke",
      headers: bearer(test.token),
      payload: { password: admin.password },
    });
    await test.server.inject({
      method: "DELETE",
      url: "/api/sessions/current",
      headers: bearer(test.token),
    });
    expect((await me(test, token.token)).statusCode).toBe(200);
  });

  it(`are at most ${String(maxTokens)} an account`, async () => {
    const test = await start();
    await test.db.query(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, hint, access)
       SELECT gen_random_uuid(), $1, 'Old', md5(n::text), 'abcd', 'read'
         FROM generate_series(1, $2::integer) n`,
      [test.userId, maxTokens],
    );
    const refused = await make(test, { name: "One more", access: "read" });
    expect(refused.statusCode).toBe(409);
  });
});
