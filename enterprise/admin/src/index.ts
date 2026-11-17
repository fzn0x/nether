// The admin console's pages beyond its features' switches (ADR 0079): the
// `admin` enterprise feature. The server's usage, counted from its database
// when asked; its workspaces, whose members' roles an instance admin may
// set (ADR 0083); and its security settings (ADR 0084). The Features page
// is the server's own, in every build.
import { serverVersion } from "@nether/server/src/app.ts";
import type { Database } from "@nether/server/src/db.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { originOf } from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import { type Role, roles, setRole } from "@nether/server/src/members.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import { SettingRefused } from "@nether/server/src/settings.ts";
import { decodeCursor, listWorkspaces, workspaceWithMembers } from "./workspaces.ts";

export type { Owner, WorkspaceMember, WorkspacePage, WorkspaceSummary } from "./workspaces.ts";

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

const memberParams = {
  type: "object",
  required: ["workspace", "user"],
  properties: { workspace: uuidField, user: uuidField },
} as const;

const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: { type: "string", maxLength: 200 },
    after: { type: "string", minLength: 1, maxLength: 1000 },
    ownerless: { type: "boolean" },
  },
} as const;

const roleBody = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: { role: { type: "string", enum: roles } },
} as const;

// Settings by name. The settings check each name and value themselves: a
// type here would have Fastify coerce values, as false to 0, before they do.
const securityBody = {
  type: "object",
  minProperties: 1,
  maxProperties: 10,
} as const;

/** What the server holds, as the console's Usage page shows it. */
export interface Usage {
  readonly version: string;
  readonly accounts: number;
  /** Accounts with a session used in the last 30 days. */
  readonly activeAccounts: number;
  readonly workspaces: number;
  readonly encryptedWorkspaces: number;
  /** Notes in workspaces the server can read: an encrypted workspace's are not counted. */
  readonly notes: number;
  readonly attachments: number;
  readonly attachmentBytes: number;
}

/** A count from a query's one row, as PostgreSQL gives a bigint: in text. */
async function count(db: Database, sql: string): Promise<number> {
  const { rows } = await db.query(sql);
  return Number(rows[0]?.count ?? 0);
}

/** The server's usage now, counted from its database. */
export async function usage(db: Database): Promise<Usage> {
  const [
    accounts,
    activeAccounts,
    workspaces,
    encryptedWorkspaces,
    notes,
    attachments,
    attachmentBytes,
  ] = await Promise.all([
    count(db, "SELECT count(*) FROM users"),
    count(
      db,
      "SELECT count(DISTINCT user_id) FROM sessions WHERE used_at > now() - interval '30 days'",
    ),
    count(db, "SELECT count(*) FROM workspaces"),
    count(db, "SELECT count(*) FROM workspaces WHERE encryption = 'end-to-end'"),
    // A note's document is named by its ID: the vaults' documents and the
    // notes' comments are not notes.
    count(
      db,
      String.raw`SELECT count(*) FROM documents WHERE name !~ '^vault' AND name !~ '\.comments$'`,
    ),
    count(db, "SELECT count(*) FROM attachments"),
    count(db, "SELECT coalesce(sum(size), 0) AS count FROM attachments"),
  ]);
  return {
    version: serverVersion(),
    accounts,
    activeAccounts,
    workspaces,
    encryptedWorkspaces,
    notes,
    attachments,
    attachmentBytes,
  };
}

/** The `admin` feature's module: its routes answer only while it is on, and to instance admins. */
export const adminModule: EnterpriseModule = {
  feature: "admin",
  plugin: (app, { db, whenOn, disconnect, security, events }) => {
    const account = signedIn(db);
    app.get(
      "/api/admin/usage",
      { preHandler: [whenOn, account, instanceAdmin("see the server's usage")] },
      () => usage(db),
    );

    const seeWorkspaces = instanceAdmin("see the server's workspaces");
    app.get<{ Querystring: { search?: string; after?: string; ownerless?: boolean } }>(
      "/api/admin/workspaces",
      { schema: { querystring: listQuery }, preHandler: [whenOn, account, seeWorkspaces] },
      async (request, reply) => {
        const { search, after, ownerless } = request.query;
        const cursor = after === undefined ? undefined : decodeCursor(after);
        if (after !== undefined && cursor === undefined) {
          return fail(reply, 400, "This is not a page of the list: start from its first.");
        }
        return listWorkspaces(db, {
          ...(search === undefined ? {} : { search }),
          ...(cursor === undefined ? {} : { after: cursor }),
          ...(ownerless === true ? { ownerless } : {}),
        });
      },
    );

    app.get<{ Params: { workspace: string } }>(
      "/api/admin/workspaces/:workspace",
      { schema: { params: workspaceParams }, preHandler: [whenOn, account, seeWorkspaces] },
      async (request, reply) => {
        const found = await workspaceWithMembers(db, request.params.workspace.toLowerCase());
        return found ?? fail(reply, 404, "The server has no such workspace.");
      },
    );

    app.patch<{ Params: { workspace: string; user: string }; Body: { role: Role } }>(
      "/api/admin/workspaces/:workspace/members/:user",
      {
        schema: { params: memberParams, body: roleBody },
        preHandler: [whenOn, account, instanceAdmin("set a workspace member's role")],
      },
      async (request, reply) => {
        const user = request.params.user.toLowerCase();
        const { role } = request.body;
        const outcome = await setRole(
          db,
          request.params.workspace.toLowerCase(),
          user,
          role,
          { account: accountOf(request).id, as: "instance-admin", origin: originOf(request) },
          events,
        );
        if (typeof outcome !== "string") return fail(reply, outcome[0], outcome[1]);
        // As the workspace's own change does: its apps connect again, checked anew.
        if (outcome === "changed") disconnect(user);
        return { id: user, role };
      },
    );

    // The Security page: each setting, its value and what pins it; changes all or none.
    app.get(
      "/api/admin/security",
      { preHandler: [whenOn, account, instanceAdmin("see the server's security settings")] },
      async () => ({ settings: await security.states() }),
    );

    app.put<{ Body: Record<string, unknown> }>(
      "/api/admin/security",
      {
        schema: { body: securityBody },
        preHandler: [whenOn, account, instanceAdmin("change the server's security settings")],
      },
      async (request, reply) => {
        try {
          await security.set(request.body);
        } catch (error) {
          if (error instanceof SettingRefused) return fail(reply, error.status, error.message);
          throw error;
        }
        return { settings: await security.states() };
      },
    );
    return Promise.resolve();
  },
};
