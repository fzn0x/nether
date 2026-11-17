// Personal access tokens (ADR 0059). A token belongs to an account and acts
// as it on the public API, under /api/v1, narrowed to reading or to one
// workspace. It is `nether_` and 32 random bytes; the server keeps its
// SHA-256, as it does a session's, and its last four characters for its
// owner to tell it from the others. Making one takes the account's password
// again, so a stolen session cannot make itself a key that outlives it.
// Tokens are managed with a session only: a token never makes, lists or
// revokes tokens. A token keeps how the session that made it began, so a
// guard that would end that session ends the token too (ADR 0080).
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Database, type Row, readBoolean, readText, readTextOrNull, readTime } from "./db.ts";
import { sessionMethodOf } from "./events.ts";
import { fail, limitByAddress, nameField, passwordField, uuidField } from "./http.ts";
import {
  accountOf,
  csrfMissing,
  newToken,
  requestToken,
  sessionAccount,
  signedIn,
  signedInAgain,
  tokenHash,
  wrongPassword,
} from "./sessions.ts";
import { signInGuards } from "./signIns.ts";
import { membership } from "./workspaces.ts";
import { type EventActor, type ServerEvents, accountActor, originOf } from "./events.ts";

/** What tells a token from a session's token, and lets secret scanners find one. */
export const tokenPrefix = "nether_";

export type Access = "read" | "write";

const accesses: readonly Access[] = ["read", "write"];

/** The most tokens an account has at once. */
export const maxTokens = 100;

/** The longest a token may be made to last, in days; it may also never expire. */
export const maxTokenDays = 366;

/** A token, as its owner sees it: never its secret. */
export interface TokenInfo {
  readonly id: string;
  readonly name: string;
  readonly access: Access;
  readonly hint: string;
  readonly workspace: { readonly id: string; readonly name: string } | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly usedAt: string | null;
}

/** Who a request to the public API is from, and how far it reaches. */
export interface ApiCaller {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  /** Read only, or read and write; a session writes. */
  readonly access: Access;
  /** The one workspace a token reaches; null for every one of its account's. */
  readonly workspaceId: string | null;
  /** The token the request came with; null for a session. */
  readonly token: TokenInfo | null;
  /** What the rate limits count it under: the account, for all its tokens and sessions. */
  readonly limitKey: string;
}

function isAccess(value: unknown): value is Access {
  return typeof value === "string" && (accesses as readonly string[]).includes(value);
}

function tokenInfo(row: Row): TokenInfo {
  const workspace = readTextOrNull(row, "workspace_id");
  const expires = row.expires_at;
  const used = row.used_at;
  const access = row.access;
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    access: isAccess(access) ? access : "read",
    hint: readText(row, "hint"),
    workspace: workspace === null ? null : { id: workspace, name: readText(row, "workspace_name") },
    expiresAt: expires === null ? null : readTime(row, "expires_at").toISOString(),
    createdAt: readTime(row, "created_at").toISOString(),
    usedAt: used === null ? null : readTime(row, "used_at").toISOString(),
  };
}

const tokenColumns = `t.id, t.name, t.access, t.hint, t.workspace_id, w.name AS workspace_name,
  t.expires_at, t.created_at, t.used_at`;

/**
 * The caller a personal access token signs in, while it lasts and the
 * server's guards let it, as they let the session that made it.
 */
export async function tokenCaller(db: Database, token: string): Promise<ApiCaller | undefined> {
  const { rows } = await db.query(
    `SELECT ${tokenColumns}, t.method, t.provider,
            u.id AS user_id, u.name AS user_name, u.email, u.instance_admin
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const info = tokenInfo(row);
  const userId = readText(row, "user_id");
  const refusal = await signInGuards(db).check(
    {
      userId,
      email: readText(row, "email"),
      instanceAdmin: readBoolean(row, "instance_admin"),
      method: sessionMethodOf(readTextOrNull(row, "method")),
      provider: readTextOrNull(row, "provider"),
    },
    db,
  );
  if (refusal !== undefined) {
    await db.query("DELETE FROM api_tokens WHERE id = $1", [info.id]);
    return undefined;
  }
  // Marked used every few minutes, not on every request, as sessions are.
  if (info.usedAt === null || Date.parse(info.usedAt) < Date.now() - 5 * 60_000) {
    await db.query("UPDATE api_tokens SET used_at = now() WHERE id = $1", [info.id]);
  }
  return {
    userId,
    name: readText(row, "user_name"),
    email: readText(row, "email"),
    access: info.access,
    workspaceId: info.workspace?.id ?? null,
    token: info,
    limitKey: userId,
  };
}

const callers = new WeakMap<FastifyRequest, ApiCaller>();

export const noCaller = "Send a token as Authorization: Bearer <token>, or sign in.";

/**
 * A public API route's check that its request comes with a personal access
 * token or a session, as a bearer token or, from the web app, a cookie with
 * its CSRF value (ADR 0053). It answers 401 otherwise.
 */
export function apiCaller(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const found = requestToken(request);
    if (found === "csrf") return fail(reply, 403, csrfMissing);
    let caller: ApiCaller | undefined;
    if (found?.token.startsWith(tokenPrefix) === true) {
      caller = await tokenCaller(db, found.token);
    } else if (found !== undefined) {
      const account = await sessionAccount(db, found.token);
      caller =
        account === undefined
          ? undefined
          : {
              userId: account.id,
              name: account.name,
              email: account.email,
              access: "write",
              workspaceId: null,
              token: null,
              limitKey: account.id,
            };
    }
    if (caller === undefined) {
      return fail(reply.header("www-authenticate", "Bearer"), 401, noCaller);
    }
    callers.set(request, caller);
    return undefined;
  };
}

/** The caller of a request an `apiCaller` check let through. */
export function callerOf(request: FastifyRequest): ApiCaller {
  const caller = callers.get(request);
  if (caller === undefined) throw new Error("This route has no apiCaller check.");
  return caller;
}

/** An API caller as an event's actor: its account, through the token it used, if it used one. */
export function callerActor(caller: ApiCaller): EventActor {
  return accountActor(
    caller.userId,
    caller.token === null ? null : { id: caller.token.id, name: caller.token.name },
  );
}

interface NewToken {
  readonly name: string;
  readonly access: Access;
  readonly workspace?: string;
  readonly expiresInDays?: number;
  readonly password?: string;
}

const newTokenBody = {
  type: "object",
  required: ["name", "access"],
  additionalProperties: false,
  properties: {
    name: nameField,
    access: { type: "string", enum: accesses },
    workspace: uuidField,
    expiresInDays: { type: "integer", minimum: 1, maximum: maxTokenDays },
    password: passwordField,
  },
} as const;

const tokenParams = {
  type: "object",
  required: ["token"],
  properties: { token: uuidField },
} as const;

/** The routes of an account's tokens: listing, making and revoking them, with a session. */
export function registerTokens(app: FastifyInstance, db: Database, events: ServerEvents): void {
  const account = signedIn(db);

  app.get("/api/tokens", { preHandler: account }, async (request) => {
    const { rows } = await db.query(
      `SELECT ${tokenColumns} FROM api_tokens t LEFT JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.user_id = $1 ORDER BY t.created_at, t.id`,
      [accountOf(request).id],
    );
    return { tokens: rows.map(tokenInfo) };
  });

  app.post<{ Body: NewToken }>(
    "/api/tokens",
    {
      schema: { body: newTokenBody },
      preHandler: [account, limitByAddress(app, "make-token", 10, "15 minutes")],
    },
    async (request, reply) => {
      const me = accountOf(request);
      if (!(await signedInAgain(db, me, request.body.password))) {
        return fail(reply, 403, wrongPassword);
      }
      const workspace = request.body.workspace?.toLowerCase() ?? null;
      if (workspace !== null && (await membership(db, me.id, workspace)) === undefined) {
        return fail(reply, 404, "This account is in no such workspace.");
      }
      const token = `${tokenPrefix}${newToken()}`;
      const id = randomUUID();
      const days = request.body.expiresInDays ?? null;
      const made = await db.transaction(async (tx) => {
        // Counted under a lock on the account's row, so two at once cannot pass the most.
        await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [me.id]);
        const { rows: counted } = await tx.query(
          "SELECT count(*)::integer AS count FROM api_tokens WHERE user_id = $1",
          [me.id],
        );
        if (Number(counted[0]?.count ?? 0) >= maxTokens) return false;
        await tx.query(
          `INSERT INTO api_tokens
             (id, user_id, name, token_hash, hint, access, workspace_id, method, provider, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $9, $10,
                   CASE WHEN $8::integer IS NULL THEN NULL
                        ELSE now() + $8::integer * interval '1 day' END)`,
          [
            id,
            me.id,
            request.body.name.trim(),
            tokenHash(token),
            token.slice(-4),
            request.body.access,
            workspace,
            days,
            me.method,
            me.provider,
          ],
        );
        await events.emit(
          tx,
          {
            action: "token.created",
            actor: accountActor(me.id),
            workspace,
            target: { type: "token", id, name: request.body.name.trim() },
            details: { access: request.body.access, expiresInDays: days },
          },
          originOf(request),
        );
        return true;
      });
      if (!made) {
        return fail(
          reply,
          409,
          `An account has at most ${String(maxTokens)} tokens: revoke one first.`,
        );
      }
      const { rows } = await db.query(
        `SELECT ${tokenColumns} FROM api_tokens t LEFT JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.id = $1`,
        [id],
      );
      return reply.code(201).send({ ...tokenInfo(rows[0] ?? {}), token });
    },
  );

  // Revoking needs no password: it only takes access away.
  app.delete<{ Params: { token: string } }>(
    "/api/tokens/:token",
    { schema: { params: tokenParams }, preHandler: account },
    async (request, reply) => {
      const me = accountOf(request).id;
      const rows = await db.transaction(async (tx) => {
        const revoked = await tx.query(
          "DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING id, name, workspace_id",
          [request.params.token.toLowerCase(), me],
        );
        const row = revoked.rows[0];
        if (row !== undefined) {
          await events.emit(
            tx,
            {
              action: "token.revoked",
              actor: accountActor(me),
              workspace: readTextOrNull(row, "workspace_id"),
              target: { type: "token", id: readText(row, "id"), name: readText(row, "name") },
            },
            originOf(request),
          );
        }
        return revoked.rows;
      });
      if (rows.length === 0) return fail(reply, 404, "This account has no such token.");
      return reply.code(204).send();
    },
  );
}
