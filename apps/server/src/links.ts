// Share links (ADR 0071). A link opens one page shared on its own, with its
// subpages, to anyone with it, at a level, through the web app at
// /s#<token>. Those with full access to the page make, list and revoke its
// links. Opening one starts a visit: its token in an HttpOnly cookie, kept
// as its hash, which the sync server takes for that page's unit alone, and
// the attachments route for its workspace's files, by their hash.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readCookies } from "./cookies.ts";
import { type Database, type Queryable, readText, readTextOrNull, readTime } from "./db.ts";
import { fail, limitByAddress, passwordField, tokenField, uuidField } from "./http.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { accountOf, newToken, signedIn, tokenHash } from "./sessions.ts";
import { accessible, vaultDocument } from "./units.ts";
import { membership } from "./workspaces.ts";
import { type ServerEvents, accountActor, originOf } from "./events.ts";

export const linkPrefix = "nether_link_";
export const visitPrefix = "nether_visit_";
export const visitCookie = "nether_visit";

/** The levels a link opens its page at: to read, to comment, or to edit. */
const linkLevels = ["view", "comment", "edit"] as const;
export type LinkLevel = "view" | "comment" | "edit";

/** The most links a page has at once. */
export const maxLinks = 20;
/** The longest a visit lasts, in days, when its link lasts longer. */
const visitDays = 30;

/** What a visit opens: a page's unit in a workspace, at its link's level. */
export interface Visit {
  readonly link: string;
  readonly workspace: string;
  readonly unit: string;
  readonly level: LinkLevel;
  /** The note the shared page is. */
  readonly page: string;
}

/** A link as those who manage its page see it. */
export interface LinkInfo {
  readonly id: string;
  readonly url: string;
  readonly level: LinkLevel;
  readonly password: boolean;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

function isLinkLevel(value: unknown): value is LinkLevel {
  return value === "view" || value === "comment" || value === "edit";
}

/** The visit a cookie's token gives, while its link lasts. */
export async function visitOf(
  db: Queryable,
  token: string | undefined,
): Promise<Visit | undefined> {
  if (token?.startsWith(visitPrefix) !== true) return undefined;
  const { rows } = await db.query(
    `SELECT l.id, l.workspace_id, l.unit_id, l.level, u.root_note
       FROM link_visits v
       JOIN share_links l ON l.id = v.link_id
       JOIN units u ON u.id = l.unit_id
       JOIN workspaces w ON w.id = l.workspace_id
      WHERE v.token_hash = $1 AND v.expires_at > now()
        AND (l.expires_at IS NULL OR l.expires_at > now())
        AND w.encryption = 'none'`,
    [tokenHash(token)],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const level = row.level;
  const page = readTextOrNull(row, "root_note");
  if (!isLinkLevel(level) || page === null) return undefined;
  return {
    link: readText(row, "id"),
    workspace: readText(row, "workspace_id"),
    unit: readText(row, "unit_id"),
    level,
    page,
  };
}

/** A request's visit token, from its cookie. */
export function visitToken(cookieHeader: string | null | undefined): string | undefined {
  const token = readCookies(cookieHeader).get(visitCookie);
  return token === undefined || token === "" ? undefined : token;
}

/** Whether a request comes from a page of this server, as a WebSocket's Origin says. */
function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The visit a WebSocket's cookie gives: only from this server's own pages, as a session's. */
export function socketVisitToken(headers: Headers): string | undefined {
  return sameOrigin(headers) ? visitToken(headers.get("cookie")) : undefined;
}

/** A link's address, at the web app's page that opens it. */
function linkUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/s#${token}`;
}

/** The server's address as people reach it: the configured one, or what the request was sent to. */
function baseOf(request: FastifyRequest, publicUrl: string | null): string {
  return publicUrl ?? `${request.protocol}://${request.host}`;
}

const workspaceUnitParams = {
  type: "object",
  required: ["workspace", "unit"],
  properties: { workspace: uuidField, unit: uuidField },
} as const;

const linkParams = {
  type: "object",
  required: ["workspace", "unit", "link"],
  properties: { workspace: uuidField, unit: uuidField, link: uuidField },
} as const;

interface NewLink {
  readonly level: LinkLevel;
  readonly expiresAt?: string;
  readonly password?: string;
}

const newLinkBody = {
  type: "object",
  required: ["level"],
  additionalProperties: false,
  properties: {
    level: { type: "string", enum: linkLevels },
    expiresAt: { type: "string", format: "date-time" },
    password: passwordField,
  },
} as const;

const openBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: tokenField, password: passwordField },
} as const;

export const noPage = "This link opens nothing: it was revoked, or it expired.";
export const needsPassword = "This link takes a password.";
export const wrongLinkPassword = "That password is not this link's.";

/** Sets a visit's cookie, which only the server reads, until it ends. */
function setVisitCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
  expiresAt: Date,
) {
  const secure =
    request.protocol === "https" || ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname);
  reply.header(
    "set-cookie",
    [
      `${visitCookie}=${encodeURIComponent(token)}`,
      "Path=/",
      "SameSite=Strict",
      "HttpOnly",
      `Expires=${expiresAt.toUTCString()}`,
      ...(secure ? ["Secure"] : []),
    ].join("; "),
  );
}

/**
 * The routes of share links: listing, making and revoking a page's, with
 * full access to it, and opening one, which anyone with it may.
 * `disconnect` closes a link's visits' connections when it is revoked.
 */
export function registerLinks(
  app: FastifyInstance,
  db: Database,
  options: {
    readonly publicUrl: string | null;
    readonly webApp: boolean;
    readonly disconnect: (userId: string) => void;
    readonly events: ServerEvents;
  },
): void {
  const { events } = options;
  const account = signedIn(db);

  /** The page's unit, when the account has full access to it; else why not. */
  async function managed(request: FastifyRequest<{ Params: { workspace: string; unit: string } }>) {
    const workspace = request.params.workspace.toLowerCase();
    const unit = request.params.unit.toLowerCase();
    const me = accountOf(request).id;
    const place = await membership(db, me, workspace);
    if (place === undefined) return [404, "This account is in no such workspace."] as const;
    if (place.encryption !== "none") {
      return [409, "An encrypted workspace has no share links yet."] as const;
    }
    const { levels, units } = await accessible(db, me, workspace);
    if (units.get(unit)?.kind !== "page")
      return [404, "This workspace shares no such page."] as const;
    if (levels.get(unit) !== "full") {
      return [403, "Managing a page's links takes full access to it."] as const;
    }
    return { workspace, unit };
  }

  const listed = (request: FastifyRequest, rows: readonly Record<string, unknown>[]): LinkInfo[] =>
    rows.map((row) => {
      const level = row.level;
      const expires = row.expires_at;
      return {
        id: readText(row, "id"),
        url: linkUrl(baseOf(request, options.publicUrl), readText(row, "token")),
        level: isLinkLevel(level) ? level : "view",
        password: row.password_hash !== null,
        expiresAt: expires === null ? null : readTime(row, "expires_at").toISOString(),
        createdAt: readTime(row, "created_at").toISOString(),
        createdBy: readTextOrNull(row, "created_by_name"),
      };
    });

  const linkColumns = `l.id, l.token, l.level, l.password_hash, l.expires_at, l.created_at,
    u.name AS created_by_name`;

  app.get<{ Params: { workspace: string; unit: string } }>(
    "/api/workspaces/:workspace/units/:unit/links",
    { schema: { params: workspaceUnitParams }, preHandler: account },
    async (request, reply) => {
      const found = await managed(request);
      if (!("unit" in found)) return fail(reply, found[0], found[1]);
      const { rows } = await db.query(
        `SELECT ${linkColumns} FROM share_links l LEFT JOIN users u ON u.id = l.created_by
          WHERE l.unit_id = $1 ORDER BY l.created_at, l.id`,
        [found.unit],
      );
      return { links: listed(request, rows) };
    },
  );

  app.post<{ Params: { workspace: string; unit: string }; Body: NewLink }>(
    "/api/workspaces/:workspace/units/:unit/links",
    { schema: { params: workspaceUnitParams, body: newLinkBody }, preHandler: account },
    async (request, reply) => {
      if (!options.webApp) {
        return fail(reply, 409, "This server serves no web app, which is what opens a link.");
      }
      const found = await managed(request);
      if (!("unit" in found)) return fail(reply, found[0], found[1]);
      const expires =
        request.body.expiresAt === undefined ? null : new Date(request.body.expiresAt);
      if (expires !== null && expires.getTime() <= Date.now()) {
        return fail(reply, 400, "A link's expiry is in the future.");
      }
      const password =
        request.body.password === undefined ? null : await hashPassword(request.body.password);
      const id = randomUUID();
      const token = `${linkPrefix}${newToken()}`;
      const made = await db.transaction(async (tx) => {
        // Counted under a lock on the page's unit, so two at once cannot pass the most.
        await tx.query("SELECT id FROM units WHERE id = $1 FOR UPDATE", [found.unit]);
        const { rows: counted } = await tx.query(
          "SELECT count(*)::integer AS count FROM share_links WHERE unit_id = $1",
          [found.unit],
        );
        if (Number(counted[0]?.count ?? 0) >= maxLinks) return false;
        await tx.query(
          `INSERT INTO share_links (id, workspace_id, unit_id, token, level, password_hash, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            found.workspace,
            found.unit,
            token,
            request.body.level,
            password,
            expires,
            accountOf(request).id,
          ],
        );
        await events.emit(
          tx,
          {
            action: "share_link.created",
            actor: accountActor(accountOf(request).id),
            workspace: found.workspace,
            target: { type: "share_link", id },
            details: {
              unit: found.unit,
              level: request.body.level,
              password: password !== null,
              expiresAt: expires === null ? null : expires.toISOString(),
            },
          },
          originOf(request),
        );
        return true;
      });
      if (!made) {
        return fail(reply, 409, `A page has at most ${String(maxLinks)} links: revoke one first.`);
      }
      const { rows } = await db.query(
        `SELECT ${linkColumns} FROM share_links l LEFT JOIN users u ON u.id = l.created_by
          WHERE l.id = $1`,
        [id],
      );
      return reply.code(201).send(listed(request, rows)[0]);
    },
  );

  // Revoking ends the link's visits, and closes what they had open.
  app.delete<{ Params: { workspace: string; unit: string; link: string } }>(
    "/api/workspaces/:workspace/units/:unit/links/:link",
    { schema: { params: linkParams }, preHandler: account },
    async (request, reply) => {
      const found = await managed(request);
      if (!("unit" in found)) return fail(reply, found[0], found[1]);
      const link = request.params.link.toLowerCase();
      const rows = await db.transaction(async (tx) => {
        const revoked = await tx.query(
          "DELETE FROM share_links WHERE id = $1 AND unit_id = $2 RETURNING id, level",
          [link, found.unit],
        );
        const row = revoked.rows[0];
        if (row !== undefined) {
          await events.emit(
            tx,
            {
              action: "share_link.revoked",
              actor: accountActor(accountOf(request).id),
              workspace: found.workspace,
              target: { type: "share_link", id: link },
              details: { unit: found.unit, level: readText(row, "level") },
            },
            originOf(request),
          );
        }
        return revoked.rows;
      });
      if (rows.length === 0) return fail(reply, 404, "This page has no such link.");
      options.disconnect(visitor(link));
      return reply.code(204).send();
    },
  );

  // Opening a link, which anyone with it may: guessing is held back by address.
  app.post<{ Body: { readonly token: string; readonly password?: string } }>(
    "/api/links/open",
    {
      schema: { body: openBody },
      onRequest: limitByAddress(app, "link-open", 30, "15 minutes"),
    },
    async (request, reply) => {
      const { token, password } = request.body;
      /** A link that would not open, told as a visit refused. */
      const refused = async (reason: string, link?: string, workspace?: string) => {
        await events.attempt(
          db,
          {
            action: "share_link.opened",
            outcome: "failure",
            reason,
            actor:
              link === undefined ? { kind: "anonymous" } : { kind: "visitor", link, name: null },
            ...(workspace === undefined ? {} : { workspace }),
            ...(link === undefined ? {} : { target: { type: "share_link", id: link } }),
          },
          originOf(request),
          request.log,
        );
      };
      if (!token.startsWith(linkPrefix)) {
        await refused("no such link");
        return fail(reply, 404, noPage);
      }
      const { rows } = await db.query(
        `SELECT l.id, l.workspace_id, l.unit_id, l.level, l.password_hash, l.expires_at, u.root_note
           FROM share_links l
           JOIN units u ON u.id = l.unit_id
           JOIN workspaces w ON w.id = l.workspace_id
          WHERE l.token = $1 AND (l.expires_at IS NULL OR l.expires_at > now())
            AND w.encryption = 'none'`,
        [token],
      );
      const row = rows[0];
      const page = row === undefined ? null : readTextOrNull(row, "root_note");
      if (row === undefined || page === null) {
        await refused("no such link, or it expired");
        return fail(reply, 404, noPage);
      }
      const hash = readTextOrNull(row, "password_hash");
      if (hash !== null) {
        // Asked for the password first: not a refusal yet.
        if (password === undefined) return fail(reply, 401, needsPassword);
        if (!(await verifyPassword(password, hash))) {
          await refused("wrong password", readText(row, "id"), readText(row, "workspace_id"));
          return fail(reply, 401, wrongLinkPassword);
        }
      }
      const link = readText(row, "id");
      const linkExpires = row.expires_at === null ? undefined : readTime(row, "expires_at");
      const longest = Date.now() + visitDays * 86_400_000;
      const ends = new Date(Math.min(linkExpires?.getTime() ?? longest, longest));
      const visit = `${visitPrefix}${newToken()}`;
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO link_visits (token_hash, link_id, expires_at) VALUES ($1, $2, $3)",
          [tokenHash(visit), link, ends],
        );
        await events.emit(
          tx,
          {
            action: "share_link.opened",
            actor: { kind: "visitor", link, name: null },
            workspace: readText(row, "workspace_id"),
            target: { type: "share_link", id: link },
            details: {
              unit: readText(row, "unit_id"),
              level: isLinkLevel(row.level) ? row.level : "view",
            },
          },
          originOf(request),
        );
      });
      setVisitCookie(reply, request, visit, ends);
      const unit = readText(row, "unit_id");
      return {
        workspace: readText(row, "workspace_id"),
        unit,
        document: vaultDocument(unit),
        level: isLinkLevel(row.level) ? row.level : "view",
        page,
        expiresAt: ends.toISOString(),
      };
    },
  );

  // What the visit a page's cookie carries opens, for the page to show again on reload.
  app.get("/api/links/visit", async (request, reply) => {
    const visit = await visitOf(db, visitToken(request.headers.cookie));
    if (visit === undefined) return fail(reply, 401, noPage);
    return {
      workspace: visit.workspace,
      unit: visit.unit,
      document: vaultDocument(visit.unit),
      level: visit.level,
      page: visit.page,
    };
  });
}

/** The user ID a visit's connections carry, for its link's revoking to close them. */
export function visitor(link: string): string {
  return `visit:${link}`;
}
