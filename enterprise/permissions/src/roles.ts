// A workspace's custom roles (ADR 0089): its owners make, change and
// delete them; anyone who sees its members lists them. Each is a base, set
// when it is made, and its ten settings, which start from the base's. Core
// reads them wherever access is decided, and gives them through its
// members, invitations and group mappings; this module manages them.
import type { Database, Queryable } from "@nether/server/src/db.ts";
import { readNumber, readText } from "@nether/server/src/db.ts";
import type { EnterpriseContext } from "@nether/server/src/enterprise.ts";
import { type EventValue, accountActor, originOf } from "@nether/server/src/events.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import {
  type CustomBase,
  type CustomRole,
  type RoleSettings,
  builtInSettings,
  customBases,
  customRoleOf,
  newlyUnmanaged,
  placeOf,
  readSettings,
  seesMembers,
  settingValues,
  settingsOf,
  settingsProblem,
  unmanagedRefusal,
  unmanagedUnits,
} from "@nether/server/src/places.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** The most custom roles a workspace has. */
export const mostRoles = 30;

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    general: { type: "string", enum: settingValues.general },
    atMost: { type: "string", enum: settingValues.atMost },
    teamspaces: { type: "string", enum: settingValues.teamspaces },
    privateSpace: { type: "boolean" },
    members: { type: "string", enum: settingValues.members },
    guests: { type: "boolean" },
    shareLinks: { type: "boolean" },
    publishing: { type: "boolean" },
    export: { type: "boolean" },
    workspace: { type: "boolean" },
  },
} as const;

const nameField = { type: "string", minLength: 1, maxLength: 60 } as const;

const newRoleBody = {
  type: "object",
  required: ["name", "base"],
  additionalProperties: false,
  properties: {
    name: nameField,
    base: { type: "string", enum: customBases },
    settings: settingsSchema,
  },
} as const;

const changeBody = {
  type: "object",
  additionalProperties: false,
  properties: { name: nameField, settings: settingsSchema },
} as const;

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

const roleParams = {
  type: "object",
  required: ["workspace", "role"],
  properties: { workspace: uuidField, role: uuidField },
} as const;

interface WorkspaceParams {
  readonly workspace: string;
}

interface RoleParams extends WorkspaceParams {
  readonly role: string;
}

interface NewRole {
  readonly name: string;
  readonly base: CustomBase;
  readonly settings?: Partial<RoleSettings>;
}

interface RoleChange {
  readonly name?: string;
  readonly settings?: Partial<RoleSettings>;
}

const noWorkspace = "This account is in no such workspace.";
const noRole = "This workspace has no such custom role.";
const ownersOnly = "Only the workspace's owners make, change and remove its custom roles.";

/** A refusal thrown inside a transaction, so it rolls back what it did. */
class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Whether a text has a control character, below the space. */
function hasControl(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) < 0x20) return true;
  }
  return false;
}

/** A name as kept: trimmed, and not one of the built-in roles'; or why not. */
function nameOf(given: string): string | Refused {
  const name = given.trim();
  if (name === "" || hasControl(name)) {
    return new Refused(400, "A role's name is 1 to 60 characters, with none that do not print.");
  }
  if (Object.hasOwn(builtInSettings, name.toLowerCase())) {
    return new Refused(400, "A custom role's name is not one of the built-in roles'.");
  }
  return name;
}

/** A role's settings as events tell of them. */
function told(settings: RoleSettings): Record<string, EventValue> {
  return { ...settings };
}

/** Who holds a role: members as their own, and members of the groups mapped with it. */
async function holders(tx: Queryable, workspace: string, role: string): Promise<string[]> {
  const { rows } = await tx.query(
    `SELECT user_id FROM memberships WHERE workspace_id = $1 AND custom_role = $2
     UNION
     SELECT gm.user_id FROM group_workspaces gw
       JOIN group_members gm ON gm.group_id = gw.group_id
       JOIN memberships m ON m.workspace_id = gw.workspace_id AND m.user_id = gm.user_id
      WHERE gw.workspace_id = $1 AND gw.custom_role = $2
     ORDER BY user_id`,
    [workspace, role],
  );
  return rows.map((row) => readText(row, "user_id"));
}

/** A role as the routes answer it. */
function shown(role: CustomRole, members: number, groups: number) {
  return {
    id: role.id,
    name: role.name,
    base: role.base,
    settings: role.settings,
    members,
    groups,
  };
}

export function registerRoles(app: FastifyInstance, context: EnterpriseContext): void {
  const { db, whenOn, events, disconnect, permissions } = context;
  const account = signedIn(db);
  const preHandler = [whenOn, account];

  /** The account's place, as an owner of the workspace, or the reply's refusal. */
  async function owner(request: FastifyRequest<{ Params: WorkspaceParams }>, reply: FastifyReply) {
    const workspace = request.params.workspace.toLowerCase();
    const place = await placeOf(db, permissions, accountOf(request).id, workspace);
    if (place === undefined) return fail(reply, 404, noWorkspace);
    if (place.role !== "owner") return fail(reply, 403, ownersOnly);
    return workspace;
  }

  app.get<{ Params: WorkspaceParams }>(
    "/api/workspaces/:workspace/roles",
    { schema: { params: workspaceParams }, preHandler },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const place = await placeOf(db, permissions, accountOf(request).id, workspace);
      if (place === undefined) return fail(reply, 404, noWorkspace);
      if (!seesMembers(place.settings)) {
        return fail(reply, 403, "Your role in this workspace sees no one's role but your own.");
      }
      return { roles: await listRoles(db, workspace), builtIn: builtInSettings };
    },
  );

  app.post<{ Params: WorkspaceParams; Body: NewRole }>(
    "/api/workspaces/:workspace/roles",
    { schema: { params: workspaceParams, body: newRoleBody }, preHandler },
    async (request, reply) => {
      const workspace = await owner(request, reply);
      if (typeof workspace !== "string") return workspace;
      const name = nameOf(request.body.name);
      if (name instanceof Refused) return fail(reply, name.status, name.message);
      const { base } = request.body;
      const settings = readSettings(request.body.settings, settingsOf(base));
      const problem = settingsProblem(settings);
      if (problem !== undefined) return fail(reply, 400, problem);
      return refusing(reply, async () => {
        const id = crypto.randomUUID();
        await db.transaction(async (tx) => {
          // Counted under the workspace's lock, so two at once cannot pass the most.
          await tx.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspace]);
          const { rows: counted } = await tx.query(
            "SELECT count(*)::integer AS count FROM custom_roles WHERE workspace_id = $1",
            [workspace],
          );
          if (readNumber(counted[0], "count") >= mostRoles) {
            throw new Refused(409, `A workspace has at most ${String(mostRoles)} custom roles.`);
          }
          const { rows: taken } = await tx.query(
            "SELECT 1 FROM custom_roles WHERE workspace_id = $1 AND lower(name) = lower($2)",
            [workspace, name],
          );
          if (taken.length > 0) throw new Refused(409, "A custom role here has that name already.");
          await tx.query(
            `INSERT INTO custom_roles (id, workspace_id, name, base, settings)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [id, workspace, name, base, JSON.stringify(settings)],
          );
          await events.emit(
            tx,
            {
              action: "role.created",
              actor: accountActor(accountOf(request).id),
              workspace,
              target: { type: "role", id, name },
              details: { base, settings: told(settings) },
            },
            originOf(request),
          );
        });
        return reply.code(201).send(shown({ id, name, base, settings }, 0, 0));
      });
    },
  );

  app.patch<{ Params: RoleParams; Body: RoleChange }>(
    "/api/workspaces/:workspace/roles/:role",
    { schema: { params: roleParams, body: changeBody }, preHandler },
    async (request, reply) => {
      const workspace = await owner(request, reply);
      if (typeof workspace !== "string") return workspace;
      const id = request.params.role.toLowerCase();
      const given = request.body.name === undefined ? undefined : nameOf(request.body.name);
      if (given instanceof Refused) return fail(reply, given.status, given.message);
      return refusing(reply, async () => {
        const outcome = await db.transaction(async (tx) => {
          const role = await customRoleOf(tx, workspace, id, true);
          if (role === undefined) throw new Refused(404, noRole);
          const name = given ?? role.name;
          const settings = readSettings(request.body.settings, role.settings);
          const problem = settingsProblem(settings);
          if (problem !== undefined) throw new Refused(400, problem);
          const settingsChanged = JSON.stringify(settings) !== JSON.stringify(role.settings);
          if (name === role.name && !settingsChanged) return { role, people: [] };
          if (name.toLowerCase() !== role.name.toLowerCase()) {
            const { rows: taken } = await tx.query(
              `SELECT 1 FROM custom_roles
                WHERE workspace_id = $1 AND lower(name) = lower($2) AND id <> $3`,
              [workspace, name, id],
            );
            if (taken.length > 0)
              throw new Refused(409, "A custom role here has that name already.");
          }
          const people = settingsChanged ? await holders(tx, workspace, id) : [];
          const before = await unmanagedUnits(tx, permissions, workspace, people);
          await tx.query(
            `UPDATE custom_roles SET name = $3, settings = $4::jsonb, updated_at = now()
              WHERE workspace_id = $1 AND id = $2`,
            [workspace, id, name, JSON.stringify(settings)],
          );
          const left = newlyUnmanaged(
            before,
            await unmanagedUnits(tx, permissions, workspace, people),
          );
          if (left !== undefined) throw new Refused(409, unmanagedRefusal(left));
          await events.emit(
            tx,
            {
              action: "role.changed",
              actor: accountActor(accountOf(request).id),
              workspace,
              target: { type: "role", id, name },
              details: {
                base: role.base,
                from: { name: role.name, settings: told(role.settings) },
                to: { name, settings: told(settings) },
              },
            },
            originOf(request),
          );
          return { role: { ...role, name, settings }, people };
        });
        // What its holders may do changed: their apps connect again, checked anew.
        for (const person of outcome.people) disconnect(person);
        const counts = await countsOf(db, workspace, id);
        return shown(outcome.role, counts.members, counts.groups);
      });
    },
  );

  app.delete<{ Params: RoleParams }>(
    "/api/workspaces/:workspace/roles/:role",
    { schema: { params: roleParams }, preHandler },
    async (request, reply) => {
      const workspace = await owner(request, reply);
      if (typeof workspace !== "string") return workspace;
      const id = request.params.role.toLowerCase();
      return refusing(reply, async () => {
        await db.transaction(async (tx) => {
          const role = await customRoleOf(tx, workspace, id, true);
          if (role === undefined) throw new Refused(404, noRole);
          const counts = await countsOf(tx, workspace, id);
          const { rows: open } = await tx.query(
            `SELECT count(*)::integer AS count FROM invitations
              WHERE workspace_id = $1 AND custom_role = $2
                AND accepted_at IS NULL AND expires_at > now()`,
            [workspace, id],
          );
          const invitations = readNumber(open[0], "count");
          if (counts.members > 0 || counts.groups > 0 || invitations > 0) {
            throw new Refused(
              409,
              `${String(counts.members)} members, ${String(counts.groups)} groups and ${String(invitations)} open invitations hold the role ${role.name}: give them another first.`,
            );
          }
          // Invitations accepted or ended keep their record, without the role.
          await tx.query(
            "UPDATE invitations SET custom_role = NULL WHERE workspace_id = $1 AND custom_role = $2",
            [workspace, id],
          );
          await tx.query("DELETE FROM custom_roles WHERE workspace_id = $1 AND id = $2", [
            workspace,
            id,
          ]);
          await events.emit(
            tx,
            {
              action: "role.deleted",
              actor: accountActor(accountOf(request).id),
              workspace,
              target: { type: "role", id, name: role.name },
              details: { base: role.base },
            },
            originOf(request),
          );
        });
        return reply.code(204).send();
      });
    },
  );
}

/** How many members hold a role as their own, and how many groups give it. */
async function countsOf(
  db: Queryable,
  workspace: string,
  role: string,
): Promise<{ readonly members: number; readonly groups: number }> {
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::integer FROM memberships
              WHERE workspace_id = $1 AND custom_role = $2) AS members,
            (SELECT count(*)::integer FROM group_workspaces
              WHERE workspace_id = $1 AND custom_role = $2) AS groups`,
    [workspace, role],
  );
  return { members: readNumber(rows[0], "members"), groups: readNumber(rows[0], "groups") };
}

/** A workspace's custom roles, by name, each with how many hold it. */
async function listRoles(db: Database, workspace: string) {
  const { rows } = await db.query(
    `SELECT r.id AS role_id, r.name AS role_name, r.base AS role_base, r.settings AS role_settings,
            (SELECT count(*)::integer FROM memberships m
              WHERE m.workspace_id = r.workspace_id AND m.custom_role = r.id) AS members,
            (SELECT count(*)::integer FROM group_workspaces gw
              WHERE gw.workspace_id = r.workspace_id AND gw.custom_role = r.id) AS groups
       FROM custom_roles r WHERE r.workspace_id = $1
      ORDER BY lower(r.name), r.id`,
    [workspace],
  );
  return rows.map((row) => {
    const base = customBases.find((each) => each === row.role_base) ?? "guest";
    return shown(
      {
        id: readText(row, "role_id"),
        name: readText(row, "role_name"),
        base,
        settings: readSettings(row.role_settings, settingsOf(base)),
      },
      readNumber(row, "members"),
      readNumber(row, "groups"),
    );
  });
}

/** Runs a route's work, answering a refusal it throws with its status and why. */
async function refusing(
  reply: FastifyReply,
  work: () => Promise<FastifyReply | object>,
): Promise<FastifyReply | object> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused) return fail(reply, error.status, error.message);
    throw error;
  }
}
