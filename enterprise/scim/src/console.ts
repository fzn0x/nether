// The console's Directories page's routes (ADR 0085), for instance admins
// while the feature is on: each directory with its domains, whether it may
// make accounts at other domains, its SCIM address and its token. A token
// is shown once, when it is made, and replaces the one before at once;
// only its SHA-256 is kept. Removing a directory keeps what its groups
// gave: each place becomes the account's own, and its accounts stay as
// they are, managed by no directory.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import { type Database, type Queryable, readText, readTextOrNull } from "@nether/server/src/db.ts";
import {
  type EventActor,
  type ServerEvents,
  accountActor,
  originOf,
} from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import { type Role, customRolesOff } from "@nether/server/src/members.ts";
import { type Permissions, customRoleOf } from "@nether/server/src/places.ts";
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
import {
  type GroupChanger,
  groupRoles,
  lockGroup,
  removeMapping,
  setMapping,
} from "./groupWrites.ts";
import type { GroupRow } from "./groups.ts";
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

interface MappingParams extends Params {
  readonly group: string;
  readonly workspace: string;
}

const mappingParams = {
  type: "object",
  required: ["id", "group", "workspace"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 32 },
    group: uuidField,
    workspace: uuidField,
  },
} as const;

const mappingBody = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: groupRoles },
    // A custom role of the workspace on `role` as its base (ADR 0089).
    customRole: { type: ["string", "null"], pattern: uuidField.pattern },
  },
} as const;

/** Workspaces the page offers to map a group to, by name. */
const mostWorkspaces = 1000;

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
  /** Closes an account's connections on every node, once a change to its places commits. */
  readonly disconnect: (userId: string) => void;
  readonly whenOn: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
  /** Whether advanced permissions hold, so a group may give a custom role (ADR 0089). */
  readonly permissions: Permissions;
}

/** Days before a token ends that the page warns of it. */
const warnDays = 30;

export function registerConsole(app: FastifyInstance, context: ConsoleContext): void {
  const { db, config, events, security, disconnect, whenOn, permissions } = context;
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
          // What its groups gave becomes each account's own, at the role it has,
          // with the custom role of the group that gave it, unless one gives
          // that role as it is built in, which gives more (ADR 0089).
          await tx.query(
            `UPDATE memberships m SET own_role = NULL,
                custom_role = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM group_workspaces gw
                      JOIN group_members gm ON gm.group_id = gw.group_id
                      JOIN groups g ON g.id = gw.group_id
                     WHERE g.directory_id = $1 AND gw.workspace_id = m.workspace_id
                       AND gm.user_id = m.user_id AND gw.role = m.role AND gw.custom_role IS NULL)
                  THEN NULL
                  ELSE (
                    SELECT gw.custom_role FROM group_workspaces gw
                      JOIN group_members gm ON gm.group_id = gw.group_id
                      JOIN groups g ON g.id = gw.group_id
                     WHERE g.directory_id = $1 AND gw.workspace_id = m.workspace_id
                       AND gm.user_id = m.user_id AND gw.role = m.role
                     ORDER BY lower(g.name), g.id LIMIT 1)
                END
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

  // A directory's groups, each with its members and the workspaces it gives
  // them places in; and every workspace, to map a group to.
  app.get<{ Params: Params }>(
    "/api/admin/directories/:id/groups",
    { ...admins("see directories' groups"), schema: { params } },
    async (request, reply) => {
      const { id } = request.params;
      if ((await findDirectory(db, id)) === undefined) {
        return fail(reply, 404, "There is no such directory.");
      }
      const { rows } = await db.query(
        `SELECT g.id, g.name, g.external_id,
                (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id) AS members,
                coalesce((SELECT json_agg(json_build_object(
                                            'id', w.id, 'name', w.name, 'role', gw.role,
                                            'customRole', CASE WHEN r.id IS NULL THEN NULL
                                              ELSE json_build_object('id', r.id, 'name', r.name) END)
                                          ORDER BY lower(w.name), w.id)
                            FROM group_workspaces gw JOIN workspaces w ON w.id = gw.workspace_id
                            LEFT JOIN custom_roles r
                              ON r.workspace_id = gw.workspace_id AND r.id = gw.custom_role
                           WHERE gw.group_id = g.id), '[]'::json) AS workspaces
           FROM groups g WHERE g.directory_id = $1
          ORDER BY lower(g.name), g.id`,
        [id],
      );
      const workspaces = await db.query(
        `SELECT id, name FROM workspaces ORDER BY lower(name), id LIMIT ${String(mostWorkspaces)}`,
      );
      return {
        groups: rows.map((row) => ({
          id: readText(row, "id"),
          name: readText(row, "name"),
          externalId: readTextOrNull(row, "external_id"),
          members: Number(row.members),
          workspaces: Array.isArray(row.workspaces) ? row.workspaces : [],
        })),
        workspaces: workspaces.rows.map((row) => ({
          id: readText(row, "id"),
          name: readText(row, "name"),
        })),
      };
    },
  );

  /** Runs a change to a group's places in one transaction, then closes the connections of those whose place changed. */
  async function mapping(
    request: FastifyRequest<{ Params: MappingParams }>,
    reply: FastifyReply,
    work: (
      tx: Queryable,
      changer: GroupChanger,
      group: GroupRow,
      workspace: string,
    ) => Promise<Set<string> | undefined>,
  ) {
    const { id, group: groupId } = request.params;
    const workspace = request.params.workspace.toLowerCase();
    return refusing(reply, async () => {
      const closing = await db.transaction(async (tx) => {
        const group = await lockGroup(tx, id, groupId);
        if (group === undefined) throw new Refused(404, "This directory has no such group.");
        const found = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspace]);
        if (found.rows.length === 0) throw new Refused(404, "There is no such workspace.");
        const changer: GroupChanger = {
          directory: id,
          actor: actorOf(request),
          origin: originOf(request),
          events,
        };
        const changed = await work(tx, changer, group, workspace);
        if (changed === undefined)
          throw new Refused(404, "This group gives no place in that workspace.");
        return changed;
      });
      for (const user of closing) disconnect(user);
      return reply.code(204).send();
    });
  }

  app.put<{
    Params: MappingParams;
    Body: { readonly role: Role; readonly customRole?: string | null };
  }>(
    "/api/admin/directories/:id/groups/:group/workspaces/:workspace",
    { ...admins("map groups to workspaces"), schema: { params: mappingParams, body: mappingBody } },
    (request, reply) =>
      mapping(request, reply, async (tx, changer, group, workspace) => {
        const { role } = request.body;
        const customRole = request.body.customRole?.toLowerCase() ?? null;
        // A custom role of the workspace, on the role as its base (ADR 0089).
        if (customRole !== null) {
          if (!(await permissions.on(tx))) throw new Refused(409, customRolesOff);
          const custom = await customRoleOf(tx, workspace, customRole);
          if (custom === undefined) {
            throw new Refused(404, "That workspace has no such custom role.");
          }
          if (custom.base !== role) {
            throw new Refused(
              400,
              `The role ${custom.name} is based on ${custom.base}: map the group as ${custom.base}.`,
            );
          }
        }
        return setMapping(tx, changer, group, workspace, role, customRole);
      }),
  );

  app.delete<{ Params: MappingParams }>(
    "/api/admin/directories/:id/groups/:group/workspaces/:workspace",
    { ...admins("map groups to workspaces"), schema: { params: mappingParams } },
    (request, reply) =>
      mapping(request, reply, (tx, changer, group, workspace) =>
        removeMapping(tx, changer, group, workspace),
      ),
  );
}
