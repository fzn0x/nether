// Sessions (ADR 0032). Signing in gives a client a token, which it sends
// back as `Authorization: Bearer <token>`. The server keeps only the
// token's SHA-256, so its database cannot sign anyone in. A session ends
// when its client signs out, or after the days unused or the days since it
// began that the security settings give now (ADR 0084), 30 and 90 unless
// changed, whichever comes first. Each keeps how it began, and a guard
// may end one that began a way its account may no longer use (ADR 0080).
// A deactivated account starts none, and its sessions end with it (ADR
// 0085).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type Database,
  type Queryable,
  readBoolean,
  readText,
  readTextOrNull,
  readTime,
} from "./db.ts";
import { clearSessionCookies, cookieToken, readCookies, sessionCookie } from "./cookies.ts";
import {
  emailKey,
  fail,
  limitBy,
  limitByAddress,
  newPasswordField,
  passwordField,
  uuidField,
} from "./http.ts";
import {
  type ServerEvents,
  type SessionMethod,
  accountActor,
  originOf,
  sessionMethodOf,
} from "./events.ts";
import { deactivatedRefusal } from "./accounts.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import type { AiEndpoints } from "./aiEndpoints.ts";
import { type DataPolicies, appsPolicy } from "./dataPolicies.ts";
import { settingsOf } from "./places.ts";
import { type SecuritySettings, settingSql } from "./settings.ts";
import {
  type RequiredProvider,
  type SignInGuards,
  SignInRefused,
  signInGuards,
} from "./signIns.ts";

/**
 * Where a session still lasts, by the security settings now: used within
 * the days unused, and begun within the days it may last however used.
 * `s` is the sessions table.
 */
const lasting = `s.used_at > now() - ${settingSql("sessionIdleDays")} * interval '1 day'
        AND s.created_at > now() - ${settingSql("sessionLifetimeDays")} * interval '1 day'`;

/** How recent a sign-in counts as signing in again, for an account without a password. */
const freshMinutes = 10;

/** A new secret: 32 random bytes, as base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** How a token is kept: its SHA-256, as hex. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Who a request is from, by its session. */
export interface Account {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly instanceAdmin: boolean;
  readonly sessionId: string;
  readonly signedInAt: Date;
  /** How its session began; null for one begun before sessions kept it. */
  readonly method: SessionMethod | null;
  /** The provider of single sign-on's it came through, for `sso`. */
  readonly provider: string | null;
}

/** How a session begins, who is told of it, and who may refuse it. */
export interface SessionStart {
  readonly method: SessionMethod;
  /** The provider of single sign-on's, for `sso`. */
  readonly provider?: string;
  readonly events: ServerEvents;
  readonly guards: SignInGuards;
}

export interface NewSession {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Starts a session for a user, as signing in does, keeping how it began,
 * and tells of it in the same transaction (ADR 0081): through a single
 * sign-on provider, `provider` is its ID. A deactivated account is
 * refused (ADR 0085), and the server's guards are asked (ADR 0080),
 * through the same transaction: a refusal throws SignInRefused and starts
 * nothing, and the caller tells of it with `refusedSignIn` once its
 * transaction is undone.
 */
export async function startSession(
  db: Queryable,
  userId: string,
  request: FastifyRequest,
  start: SessionStart,
): Promise<NewSession> {
  const { method, provider, events, guards } = start;
  const users = await db.query(
    "SELECT email, instance_admin, deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = $1",
    [userId],
  );
  const attempt = {
    userId,
    email: readText(users.rows[0], "email"),
    instanceAdmin: readBoolean(users.rows[0], "instance_admin"),
    method,
    provider: provider ?? null,
  };
  // A deactivated account starts none, whichever way it came in.
  const refusal = readBoolean(users.rows[0], "deactivated")
    ? deactivatedRefusal
    : await guards.check(attempt, db);
  if (refusal !== undefined) throw new SignInRefused(refusal, attempt);
  const token = newToken();
  const client = (request.headers["user-agent"] ?? "").slice(0, 200);
  // Its end as the lifetime is now; a later setting ends it sooner or later.
  const { rows } = await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, client, method, provider, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ${settingSql("sessionLifetimeDays")} * interval '1 day')
     RETURNING expires_at`,
    [randomUUID(), userId, tokenHash(token), client, method, provider ?? null],
  );
  await events.emit(
    db,
    {
      action: "session.signed_in",
      actor: accountActor(userId),
      details: provider === undefined ? { method } : { method, provider },
    },
    originOf(request),
  );
  return { token, expiresAt: readTime(rows[0], "expires_at").toISOString() };
}

/**
 * Tells the server's events of a sign-in a guard refused, or that a
 * deactivated account tried, as a failure with its reason (ADR 0081),
 * through `db`, not the transaction undone.
 */
export async function refusedSignIn(
  db: Queryable,
  events: ServerEvents,
  request: FastifyRequest,
  refused: SignInRefused,
): Promise<void> {
  const { userId, method, provider } = refused.attempt;
  await events.attempt(
    db,
    {
      action: "session.signed_in",
      outcome: "failure",
      reason: refused.refusal.reason,
      actor: accountActor(userId),
      details: method === null ? {} : provider === null ? { method } : { method, provider },
    },
    originOf(request),
    request.log,
  );
}

/** The token in an `Authorization: Bearer` header. */
export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer +(\S+) *$/i.exec(header ?? "")?.[1];
}

/**
 * The account a token signs in, while its session lasts, its account is
 * not deactivated, and the server's guards let it: one they refuse, as
 * one begun with a password once single sign-on is required, ends here.
 */
export async function sessionAccount(db: Database, token: string): Promise<Account | undefined> {
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.created_at, s.used_at, s.method, s.provider,
            u.id, u.name, u.email, u.instance_admin, u.deactivated_at IS NOT NULL AS deactivated
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND ${lasting}`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const sessionId = readText(row, "session_id");
  const method = sessionMethodOf(readTextOrNull(row, "method"));
  const provider = readTextOrNull(row, "provider");
  // One started as its account was deactivated ends here, as one a guard refuses.
  const refusal = readBoolean(row, "deactivated")
    ? deactivatedRefusal
    : await signInGuards(db).check(
        {
          userId: readText(row, "id"),
          email: readText(row, "email"),
          instanceAdmin: readBoolean(row, "instance_admin"),
          method,
          provider,
        },
        db,
      );
  if (refusal !== undefined) {
    await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    return undefined;
  }
  // Marked used every few minutes, not on every request.
  if (readTime(row, "used_at").getTime() < Date.now() - 5 * 60_000) {
    await db.query("UPDATE sessions SET used_at = now() WHERE id = $1", [sessionId]);
  }
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    email: readText(row, "email"),
    instanceAdmin: readBoolean(row, "instance_admin"),
    sessionId,
    signedInAt: readTime(row, "created_at"),
    method,
    provider,
  };
}

const accounts = new WeakMap<FastifyRequest, Account>();

export const csrfMissing = "This request came without the page's CSRF value.";

/**
 * The session token a request brings: its bearer token or, from the web
 * app, its session's cookie, with the CSRF value a request that changes
 * anything must send back (ADR 0053); "csrf" when that is missing.
 */
export function requestToken(
  request: FastifyRequest,
): { readonly token: string } | "csrf" | undefined {
  const bearer = bearerToken(request.headers.authorization);
  return bearer === undefined ? cookieToken(request) : { token: bearer };
}

/**
 * A route's check that its request is signed in, by a bearer token or, from
 * the web app, the session's cookie with its CSRF value (ADR 0053); it
 * answers 401 otherwise, and 403 to a cookie without the value.
 */
export function signedIn(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const found = requestToken(request);
    if (found === "csrf") return fail(reply, 403, csrfMissing);
    const account = found === undefined ? undefined : await sessionAccount(db, found.token);
    if (account === undefined) {
      return fail(reply.header("www-authenticate", "Bearer"), 401, "Sign in first.");
    }
    accounts.set(request, account);
    return undefined;
  };
}

/** The account of a request a `signedIn` check let through. */
export function accountOf(request: FastifyRequest): Account {
  const account = accounts.get(request);
  if (account === undefined) throw new Error("This route has no signedIn check.");
  return account;
}

let decoy: Promise<string> | undefined;

/** A hash no password matches, to check against when an address has no account. */
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(newToken());
  return decoy;
}

/** Whether an account's password still signs it in, as the server's guards say. */
export async function passwordCounts(db: Database, account: Account): Promise<boolean> {
  const refusal = await signInGuards(db).check(
    {
      userId: account.id,
      email: account.email,
      instanceAdmin: account.instanceAdmin,
      method: "password",
      provider: null,
    },
    db,
  );
  return refusal === undefined;
}

/**
 * Whether the person at a session has just proven who they are again: with
 * the account's password, or, for an account without one or whose password
 * no longer signs it in, by signing in within the last few minutes.
 */
export async function signedInAgain(
  db: Database,
  account: Account,
  password: string | undefined,
): Promise<boolean> {
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [account.id]);
  const hash = readTextOrNull(rows[0], "password_hash");
  if (hash === null || !(await passwordCounts(db, account))) {
    return account.signedInAt.getTime() > Date.now() - freshMinutes * 60_000;
  }
  return password !== undefined && (await verifyPassword(password, hash));
}

/** The answer to an address that signs in through a provider, which says which. */
export function useProvider(reply: FastifyReply, email: string, provider: RequiredProvider) {
  const domain = (email.split("@").at(-1) ?? "").toLowerCase();
  return reply.code(403).send({
    statusCode: 403,
    error: "Forbidden",
    message: `Addresses at ${domain} sign in with ${provider.name}.`,
    sso: provider,
  });
}

interface SignIn {
  readonly email: string;
  readonly password: string;
}

const signInBody = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: { email: { type: "string", minLength: 1, maxLength: 320 }, password: passwordField },
} as const;

interface Revoke {
  readonly password?: string;
  readonly session?: string;
}

const revokeBody = {
  type: "object",
  additionalProperties: false,
  properties: { password: passwordField, session: uuidField },
} as const;

interface PasswordChange {
  readonly current?: string;
  readonly password: string;
}

const passwordBody = {
  type: "object",
  required: ["password"],
  additionalProperties: false,
  properties: { current: passwordField, password: newPasswordField },
} as const;

export const wrongPassword = "That password is not this account's.";

const noMatch = "That email address and password do not match an account.";

/**
 * The routes of signing in and out, of one's sessions, and of one's
 * account. The security settings give the sign-in limits; the account's
 * apps read the approved AI endpoints with its workspaces. Each sign-in,
 * and each that fails, is told of (ADR 0081).
 */
export function registerSessions(
  app: FastifyInstance,
  db: Database,
  security: SecuritySettings,
  aiEndpoints: AiEndpoints,
  events: ServerEvents,
  policies: DataPolicies,
): void {
  const account = signedIn(db);
  const guards = signInGuards(db);

  app.post<{ Body: SignIn }>(
    "/api/sessions",
    {
      schema: { body: signInBody },
      // Per address, before the body is read; then per account, so many
      // addresses cannot guess one password together.
      onRequest: limitByAddress(
        app,
        "sign-in",
        async () => (await security.values()).signInTriesAddress,
        "5 minutes",
      ),
      preHandler: limitBy(
        app,
        "sign-in-account",
        async () => (await security.values()).signInTriesAccount,
        "15 minutes",
        (request) => emailKey((request.body as SignIn).email),
      ),
    },
    async (request, reply) => {
      // Known by the domain alone: an address there signs in with its provider.
      const required = await guards.requiredFor(request.body.email);
      const { rows } = await db.query(
        "SELECT id, name, email, instance_admin, password_hash FROM users WHERE email_key = $1",
        [emailKey(request.body.email)],
      );
      const row = rows[0];
      const hash = row === undefined ? null : readTextOrNull(row, "password_hash");
      // An address without an account takes as long as a wrong password,
      // so the time an answer takes does not tell which addresses have one.
      const matches = await verifyPassword(request.body.password, hash ?? (await decoyHash()));
      // A refusal answers as a wrong password does, or, at a domain whose
      // provider is required, names it, right password or wrong: neither
      // tells whether the password was right.
      const refused = () =>
        required === undefined
          ? fail(reply, 401, noMatch)
          : useProvider(reply, request.body.email, required);
      if (row === undefined || hash === null || !matches) {
        // The log may say which, as only instance admins read it.
        const reason =
          row === undefined
            ? "no such account"
            : hash === null
              ? "the account has no password"
              : "wrong password";
        await events.attempt(
          db,
          {
            action: "session.signed_in",
            outcome: "failure",
            reason,
            actor:
              row === undefined
                ? { kind: "anonymous", email: request.body.email.slice(0, 320) }
                : accountActor(readText(row, "id")),
            details: { method: "password" },
          },
          originOf(request),
          request.log,
        );
        return refused();
      }
      const id = readText(row, "id");
      let session: NewSession;
      try {
        session = await db.transaction((tx) =>
          startSession(tx, id, request, { method: "password", events, guards }),
        );
      } catch (error) {
        // A deactivated account answers as a wrong password does, so a
        // password cannot be tested here.
        if (!(error instanceof SignInRefused)) throw error;
        await refusedSignIn(db, events, request, error);
        return refused();
      }
      return reply.code(201).send({
        ...session,
        user: {
          id,
          name: readText(row, "name"),
          email: readText(row, "email"),
          instanceAdmin: readBoolean(row, "instance_admin"),
        },
      });
    },
  );

  app.get("/api/sessions", { preHandler: account }, async (request) => {
    const me = accountOf(request);
    const { rows } = await db.query(
      `SELECT s.id, s.client, s.created_at, s.used_at FROM sessions s
        WHERE s.user_id = $1 AND ${lasting}
        ORDER BY s.created_at`,
      [me.id],
    );
    return {
      sessions: rows.map((row) => ({
        id: readText(row, "id"),
        client: readText(row, "client"),
        createdAt: readTime(row, "created_at").toISOString(),
        usedAt: readTime(row, "used_at").toISOString(),
        current: readText(row, "id") === me.sessionId,
      })),
    };
  });

  // Signing out.
  app.delete("/api/sessions/current", { preHandler: account }, async (request, reply) => {
    const me = accountOf(request);
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM sessions WHERE id = $1", [me.sessionId]);
      await events.emit(
        tx,
        { action: "session.signed_out", actor: accountActor(me.id) },
        originOf(request),
      );
    });
    if (readCookies(request.headers.cookie).has(sessionCookie)) clearSessionCookies(reply);
    return reply.code(204).send();
  });

  // Ending another session, or every other one, after signing in again.
  app.post<{ Body: Revoke }>(
    "/api/sessions/revoke",
    {
      schema: { body: revokeBody },
      preHandler: [account, limitByAddress(app, "revoke-sessions", 10, "15 minutes")],
    },
    async (request, reply) => {
      const me = accountOf(request);
      if (!(await signedInAgain(db, me, request.body.password))) {
        return fail(reply, 403, wrongPassword);
      }
      const { session } = request.body;
      const ended = await db.transaction(async (tx) => {
        const { rows } =
          session === undefined
            ? await tx.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id", [
                me.id,
                me.sessionId,
              ])
            : await tx.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id", [
                session.toLowerCase(),
                me.id,
              ]);
        if (session !== undefined && rows.length === 0) return false;
        await events.emit(
          tx,
          {
            action: "session.revoked",
            actor: accountActor(me.id),
            details: {
              sessions: rows.map((row) => readText(row, "id")),
              all: session === undefined,
            },
          },
          originOf(request),
        );
        return true;
      });
      if (!ended) return fail(reply, 404, "This account has no such session.");
      return reply.code(204).send();
    },
  );

  app.get("/api/me", { preHandler: account }, async (request) => {
    const me = accountOf(request);
    const { rows } = await db.query(
      `SELECT w.id, w.name, w.encryption, w.ai, m.role
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 ORDER BY w.created_at, w.name`,
      [me.id],
    );
    const policed = await policies.on();
    const workspaces = await Promise.all(
      rows.map(async (row) => {
        const id = readText(row, "id");
        return {
          id,
          name: readText(row, "name"),
          role: readText(row, "role"),
          encryption: readText(row, "encryption"),
          // Whether its members' apps offer AI in it (ADR 0068).
          ai: readBoolean(row, "ai"),
          // What its members' apps keep to of its data policy, or null (ADR 0088).
          policies: policed ? appsPolicy(await policies.of(id)) : null,
          // What the account's role may do there, for its apps to offer only that (ADR 0089).
          may: settingsOf(readText(row, "role")),
        };
      }),
    );
    return {
      user: { id: me.id, name: me.name, email: me.email, instanceAdmin: me.instanceAdmin },
      workspaces,
      // The only addresses every app may send AI requests to, or null (ADR 0086).
      aiEndpoints: await aiEndpoints.locked(),
    };
  });

  // A new password ends every other session, which the old one may have begun.
  app.put<{ Body: PasswordChange }>(
    "/api/me/password",
    {
      schema: { body: passwordBody },
      preHandler: [account, limitByAddress(app, "password-change", 10, "15 minutes")],
    },
    async (request, reply) => {
      const me = accountOf(request);
      if (!(await passwordCounts(db, me))) {
        return fail(reply, 403, "This account signs in with single sign-on: it takes no password.");
      }
      if (!(await signedInAgain(db, me, request.body.current))) {
        return fail(reply, 403, wrongPassword);
      }
      const hash = await hashPassword(request.body.password);
      await db.transaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, me.id]);
        await tx.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [
          me.id,
          me.sessionId,
        ]);
        await events.emit(
          tx,
          { action: "account.password_changed", actor: accountActor(me.id) },
          originOf(request),
        );
      });
      return reply.code(204).send();
    },
  );
}
