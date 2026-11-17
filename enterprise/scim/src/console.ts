// The console's Directories page's routes (ADR 0085), for instance admins
// while the feature is on: each directory with its domains, whether it may
// make accounts at other domains, its SCIM address and its token. A token
// is shown once, when it is made, and replaces the one before at once;
// only its SHA-256 is kept. Removing a directory keeps what its groups
// gave: each place becomes the account's own, and its accounts stay as
// they are, managed by no directory.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import { type Database, type Queryable, readText } from "@nether/server/src/db.ts";
import {
  type EventActor,
  type ServerEvents,
  accountActor,
  originOf,
} from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail } from "@nether/server/src/http.ts";
import { accountOf, signedIn, tokenHash } from "@nether/server/src/sessions.ts";
import type { SecuritySettings } from "@nether/server/src/settings.ts";
import {
  type Directory,
  accountCounts,
  directoryIdPattern,
  domainOf,
  domainOwner,
  findDirectory,
  listDirectories,
  mostTokenDays,
  newDirectoryToken,
  setDomains,
  tokenDays,
} from "./directories.ts";
import { scimBase } from "./scim.ts";

interface DirectoryInput {
  readonly id: string;
  readonly kind?: "scim";
  readonly name?: string;
  readonly domains?: readonly string[];
  readonly otherDomains?: boolean;
}

interface Params {
  readonly id: string;
}

const properties = {
  name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
  domains: {
    type: "array",
    maxItems: 100,
    items: { type: "string", minLength: 1, maxLength: 253 },
  },
  otherDomains: { type: "boolean" },
} as const;

const newBody = {
  type: "object",
  required: ["id", "name"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: directoryIdPattern },
    // LDAP directories come with the LDAP pull (ADR 0085, part 4).
    kind: { type: "string", enum: ["scim"] },
    ...properties,
  },
} as const;

const changeBody = { type: "object", additionalProperties: false, properties } as const;

const tokenBody = {
  type: "object",
  additionalProperties: false,
  properties: { days: { type: "integer", minimum: 1, maximum: mostTokenDays } },
} as const;

const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 32 } },
} as const;

/** An input refused, saying why. */
class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function domainsOf(input: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const text of input) {
    const domain = domainOf(text);
    if (domain === undefined) throw new Refused(400, `${text} is not an email domain.`);
    domains.add(domain);
  }
  return [...domains].sort();
}

/** Checks no other directory has one of the domains. */
async function domainsFree(tx: Queryable, id: string, domains: readonly string[]): Promise<void> {
  for (const domain of domains) {
    const owner = await domainOwner(tx, domain);
    if (owner !== undefined && owner !== id) {
      throw new Refused(
        409,
        `${domain} belongs to the directory ${owner}: a domain belongs to one at most.`,
      );
    }
  }
}

export interface ConsoleContext {
  readonly db: Database;
  readonly config: Config;
  readonly events: ServerEvents;
  readonly security: SecuritySettings;
  readonly whenOn: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

/** Days before a token ends that the page warns of it. */
const warnDays = 30;

export function registerConsole(app: FastifyInstance, context: ConsoleContext): void {
  const { db, config, events, security, whenOn } = context;
  const account = signedIn(db);
  const admins = (what: string) => ({ preHandler: [whenOn, account, instanceAdmin(what)] });
  const actorOf = (request: FastifyRequest): EventActor => accountActor(accountOf(request).id);

  /** What the page shows of a directory: never its token, only its last characters. */
  async function view(directory: Directory) {
    const counts = await accountCounts(db, directory.id);
    const ends = directory.token?.expiresAt;
    return {
      id: directory.id,
      kind: directory.kind,
      name: directory.name,
      domains: directory.domains,
      otherDomains: directory.otherDomains,
      ...counts,
      scimUrl: directory.kind === "scim" ? scimBase(config, directory.id) : null,
      token:
        directory.token === null || ends === undefined
          ? null
          : {
              hint: directory.token.hint,
              expiresAt: ends.toISOString(),
              ended: ends.getTime() <= Date.now(),
              endsSoon: ends.getTime() - Date.now() < warnDays * 86_400_000,
            },
    };
  }

  /** Runs a change, answering what it refused with its status. */
  async function refusing<T>(
    reply: FastifyReply,
    work: () => Promise<T>,
  ): Promise<T | FastifyReply> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Refused) return fail(reply, error.status, error.message);
      throw error;
    }
  }

  app.get("/api/admin/directories", admins("see the server's directories"), async () => {
    const sso = await db.query("SELECT count(*)::int AS count FROM sso_providers");
    return {
      directories: await Promise.all((await listDirectories(db)).map(view)),
      publicUrl: config.publicUrl,
      // How the accounts a directory makes, which have no password, sign in.
      signIn: {
        providers: Number(sso.rows[0]?.count ?? 0),
        oidc: config.oidc !== null,
        codes: config.mail !== null && (await security.values()).emailCodes,
      },
    };
  });

  app.post<{ Body: DirectoryInput }>(
    "/api/admin/directories",
    { ...admins("add directories"), schema: { body: newBody } },
    async (request, reply) => {
      const { body } = request;
      return refusing(reply, async () => {
        const domains = domainsOf(body.domains ?? []);
        const name = (body.name ?? "").trim();
        await db.transaction(async (tx) => {
          if ((await findDirectory(tx, body.id)) !== undefined) {
            throw new Refused(409, `There is a directory named ${body.id} already.`);
          }
          await domainsFree(tx, body.id, domains);
          await tx.query(
            "INSERT INTO directories (id, kind, name, other_domains) VALUES ($1, 'scim', $2, $3)",
            [body.id, name, body.otherDomains ?? false],
          );
          await setDomains(tx, body.id, domains);
          await events.emit(
            tx,
            {
              action: "directory.created",
              actor: actorOf(request),
              target: { type: "directory", id: body.id, name },
              details: { kind: "scim", domains, otherDomains: body.otherDomains ?? false },
            },
            originOf(request),
          );
        });
        const made = await findDirectory(db, body.id);
        if (made === undefined) throw new Error("The directory was not kept.");
        return reply.code(201).send(await view(made));
      });
    },
  );

  app.patch<{ Params: Params; Body: Omit<DirectoryInput, "id" | "kind"> }>(
    "/api/admin/directories/:id",
    { ...admins("change directories"), schema: { params, body: changeBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { body } = request;
      return refusing(reply, async () => {
        const domains = body.domains === undefined ? undefined : domainsOf(body.domains);
        await db.transaction(async (tx) => {
          const kept = await findDirectory(tx, id, true);
          if (kept === undefined) throw new Refused(404, "There is no such directory.");
          const name = body.name?.trim() ?? kept.name;
          const otherDomains = body.otherDomains ?? kept.otherDomains;
          if (domains !== undefined) {
            await domainsFree(tx, id, domains);
            await setDomains(tx, id, domains);
          }
          await tx.query(
            "UPDATE directories SET name = $2, other_domains = $3, updated_at = now() WHERE id = $1",
            [id, name, otherDomains],
          );
          await events.emit(
            tx,
            {
              action: "directory.changed",
              actor: actorOf(request),
              target: { type: "directory", id, name },
              details: {
                from: {
                  name: kept.name,
                  domains: [...kept.domains],
                  otherDomains: kept.otherDomains,
                },
                to: { name, domains: domains ?? [...kept.domains], otherDomains },
              },
            },
            originOf(request),
          );
        });
        const changed = await findDirectory(db, id);
        if (changed === undefined) throw new Refused(404, "There is no such directory.");
        return view(changed);
      });
    },
  );

  app.delete<{ Params: Params }>(
    "/api/admin/directories/:id",
    { ...admins("remove directories"), schema: { params } },
    async (request, reply) => {
      const { id } = request.params;
      return refusing(reply, async () => {
        await db.transaction(async (tx) => {
          const kept = await findDirectory(tx, id, true);
          if (kept === undefined) throw new Refused(404, "There is no such directory.");
          // What its groups gave becomes each account's own, at the role it has.
          await tx.query(
            `UPDATE memberships m SET own_role = NULL
              WHERE m.own_role IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM group_workspaces gw
                    JOIN group_members gm ON gm.group_id = gw.group_id
                    JOIN groups g ON g.id = gw.group_id
                   WHERE g.directory_id = $1 AND gw.workspace_id = m.workspace_id
                     AND gm.user_id = m.user_id)`,
            [id],
          );
          const { rows } = await tx.query(
            "SELECT user_id, user_name FROM directory_accounts WHERE directory_id = $1",
            [id],
          );
          for (const row of rows) {
            await events.emit(
              tx,
              {
                action: "directory.account_unlinked",
                actor: actorOf(request),
                target: { type: "account", id: readText(row, "user_id") },
                details: { directory: id, userName: readText(row, "user_name") },
              },
              originOf(request),
            );
          }
          // Its domains, accounts' rows, groups and their mappings go with it.
          await tx.query("DELETE FROM directories WHERE id = $1", [id]);
          await events.emit(
            tx,
            {
              action: "directory.deleted",
              actor: actorOf(request),
              target: { type: "directory", id, name: kept.name },
              details: { accounts: rows.length },
            },
            originOf(request),
          );
        });
        return reply.code(204).send();
      });
    },
  );

  // A new token, shown once; it replaces the one before at once.
  app.post<{ Params: Params; Body: { readonly days?: number } | undefined }>(
    "/api/admin/directories/:id/token",
    { ...admins("make directories' tokens"), schema: { params, body: tokenBody } },
    async (request, reply) => {
      const { id } = request.params;
      const days = request.body?.days ?? tokenDays;
      return refusing(reply, async () => {
        const token = newDirectoryToken();
        const expiresAt = await db.transaction(async (tx) => {
          const kept = await findDirectory(tx, id, true);
          if (kept === undefined) throw new Refused(404, "There is no such directory.");
          if (kept.kind !== "scim") throw new Refused(400, "Only a SCIM directory has a token.");
          const { rows } = await tx.query(
            `UPDATE directories
                SET token_hash = $2, token_hint = $3,
                    token_expires_at = now() + $4 * interval '1 day', updated_at = now()
              WHERE id = $1 RETURNING token_expires_at`,
            [id, tokenHash(token), token.slice(-4), days],
          );
          const ends = rows[0]?.token_expires_at;
          if (!(ends instanceof Date)) throw new Error("The token's end was not kept.");
          await events.emit(
            tx,
            {
              action: "directory.token_created",
              actor: actorOf(request),
              target: { type: "directory", id, name: kept.name },
              details: { expiresAt: ends.toISOString() },
            },
            originOf(request),
          );
          return ends;
        });
        return reply
          .code(201)
          .send({ token, hint: token.slice(-4), expiresAt: expiresAt.toISOString() });
      });
    },
  );

  app.delete<{ Params: Params }>(
    "/api/admin/directories/:id/token",
    { ...admins("revoke directories' tokens"), schema: { params } },
    async (request, reply) => {
      const { id } = request.params;
      return refusing(reply, async () => {
        await db.transaction(async (tx) => {
          const kept = await findDirectory(tx, id, true);
          if (kept === undefined) throw new Refused(404, "There is no such directory.");
          await tx.query(
            `UPDATE directories SET token_hash = NULL, token_hint = NULL, token_expires_at = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [id],
          );
          await events.emit(
            tx,
            {
              action: "directory.changed",
              actor: actorOf(request),
              target: { type: "directory", id, name: kept.name },
              details: { token: "revoked" },
            },
            originOf(request),
          );
        });
        return reply.code(204).send();
      });
    },
  );
}
