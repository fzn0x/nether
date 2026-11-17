// A workspace's webhooks, through the public API (ADR 0060): its owners
// and admins list, make, change and remove them, with a session or a token,
// which must be a write token to change anything. A webhook's secret is
// shown when it is made and when a new one replaces it, never in a list.
// Encrypted workspaces have none: the server cannot name their notes.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  type Database,
  type Queryable,
  type Row,
  readText,
  readTextOrNull,
  readTime,
} from "./db.ts";
import { fail, uuidField } from "./http.ts";
import { type WorkspaceParams, reach, type registerApi, workspaceParams } from "./api.ts";
import { addressProblem, newSecret, type PrivatePolicy } from "./outbound.ts";
import { type EventType, eventTypes } from "./outbox.ts";
import { type ApiCaller, callerActor, callerOf } from "./tokens.ts";
import { membership } from "./workspaces.ts";
import { type EventDetails, type ServerEvents, originOf } from "./events.ts";

/** The most webhooks a workspace has. */
export const maxWebhooks = 20;

const readOnly = "This token only reads: changing webhooks takes a write token.";
const onlyAdmins = "Only a workspace's owners and admins manage its webhooks.";
const noWebhook = "This workspace has no such webhook.";

interface WebhookParams extends WorkspaceParams {
  readonly webhook: string;
}

const webhookParams = {
  type: "object",
  required: ["workspace", "webhook"],
  properties: { workspace: uuidField, webhook: uuidField },
} as const;

const urlField = { type: "string", minLength: 1, maxLength: 2000 } as const;

const eventsField = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: { type: "string", enum: eventTypes },
} as const;

interface NewWebhook {
  readonly url: string;
  readonly events?: readonly EventType[];
}

interface WebhookChange {
  readonly url?: string;
  readonly events?: readonly EventType[];
  readonly enabled?: boolean;
}

const newBody = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: { url: urlField, events: eventsField },
} as const;

const changeBody = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: { url: urlField, events: eventsField, enabled: { type: "boolean" } },
} as const;

const columns = `w.id, w.url, w.events, w.enabled, w.failing_since, w.last_error, w.created_at,
  w.maker_id, u.name AS maker_name`;

/** A webhook as its workspace's admins see it: never its secret. */
function shown(row: Row) {
  return {
    id: readText(row, "id"),
    url: readText(row, "url"),
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    enabled: row.enabled === true,
    failingSince: row.failing_since === null ? null : readTime(row, "failing_since").toISOString(),
    lastError: readTextOrNull(row, "last_error"),
    maker: { id: readText(row, "maker_id"), name: readText(row, "maker_name") },
    createdAt: readTime(row, "created_at").toISOString(),
  };
}

/** The webhooks' routes, with the checks every route of the API runs. */
export function registerWebhooks(
  app: FastifyInstance,
  db: Database,
  policy: PrivatePolicy,
  checks: ReturnType<typeof registerApi>,
  serverEvents: ServerEvents,
): void {
  const preHandler = [checks.caller, checks.limit];

  /** Tells of a change to a webhook, in its transaction: where it sends, by its origin alone. */
  const told = (
    tx: Queryable,
    request: FastifyRequest,
    action: "webhook.created" | "webhook.changed" | "webhook.deleted" | "webhook.secret_changed",
    workspace: string,
    webhook: string,
    details: EventDetails = {},
  ) => {
    const caller = callerOf(request);
    return serverEvents.emit(
      tx,
      {
        action,
        actor: callerActor(caller),
        workspace,
        target: { type: "webhook", id: webhook },
        details,
      },
      originOf(request),
    );
  };

  /** The workspace whose webhooks a caller manages, or why it may not. */
  async function managed(
    caller: ApiCaller,
    workspace: string,
    changing: boolean,
  ): Promise<string | readonly [number, string]> {
    if (changing && caller.access !== "write") return [403, readOnly];
    const reached = await reach(db, caller, workspace);
    if (!("workspace" in reached)) return reached;
    const member = await membership(db, caller.userId, reached.workspace);
    if (member?.role !== "owner" && member?.role !== "admin") return [403, onlyAdmins];
    return reached.workspace;
  }

  async function one(workspace: string, webhook: string): Promise<Row | undefined> {
    const { rows } = await db.query(
      `SELECT ${columns} FROM webhooks w JOIN users u ON u.id = w.maker_id
        WHERE w.workspace_id = $1 AND w.id = $2`,
      [workspace, webhook.toLowerCase()],
    );
    return rows[0];
  }

  app.get<{ Params: WorkspaceParams }>(
    "/api/v1/workspaces/:workspace/webhooks",
    { schema: { params: workspaceParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, false);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const { rows } = await db.query(
        `SELECT ${columns} FROM webhooks w JOIN users u ON u.id = w.maker_id
          WHERE w.workspace_id = $1 ORDER BY w.created_at, w.id`,
        [workspace],
      );
      return { webhooks: rows.map(shown) };
    },
  );

  app.post<{ Params: WorkspaceParams; Body: NewWebhook }>(
    "/api/v1/workspaces/:workspace/webhooks",
    { schema: { params: workspaceParams, body: newBody }, preHandler },
    async (request, reply) => {
      const caller = callerOf(request);
      const workspace = await managed(caller, request.params.workspace, true);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const problem = addressProblem(request.body.url, policy);
      if (problem !== undefined) return fail(reply, 400, problem);
      const secret = newSecret();
      const id = randomUUID();
      const made = await db.transaction(async (tx) => {
        // Counted under a lock on the workspace's row, so two at once cannot pass the most.
        await tx.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspace]);
        const { rows } = await tx.query(
          "SELECT count(*)::integer AS count FROM webhooks WHERE workspace_id = $1",
          [workspace],
        );
        if (Number(rows[0]?.count ?? 0) >= maxWebhooks) return false;
        await tx.query(
          `INSERT INTO webhooks (id, workspace_id, maker_id, url, secret, events)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            workspace,
            caller.userId,
            new URL(request.body.url).href,
            secret,
            request.body.events ?? eventTypes,
          ],
        );
        await told(tx, request, "webhook.created", workspace, id, {
          // Its origin alone: a path or query may hold a secret of its own.
          to: new URL(request.body.url).origin,
          events: [...(request.body.events ?? eventTypes)],
        });
        return true;
      });
      if (!made) {
        return fail(reply, 409, `A workspace has at most ${String(maxWebhooks)} webhooks.`);
      }
      const row = await one(workspace, id);
      return reply.code(201).send({ ...shown(row ?? {}), secret });
    },
  );

  app.get<{ Params: WebhookParams }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook",
    { schema: { params: webhookParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, false);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const row = await one(workspace, request.params.webhook);
      return row === undefined ? fail(reply, 404, noWebhook) : shown(row);
    },
  );

  // Turning one on again starts afresh: its failures are forgotten.
  app.patch<{ Params: WebhookParams; Body: WebhookChange }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook",
    { schema: { params: webhookParams, body: changeBody }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, true);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const { url, events, enabled } = request.body;
      if (url !== undefined) {
        const problem = addressProblem(url, policy);
        if (problem !== undefined) return fail(reply, 400, problem);
      }
      const rows = await db.transaction(async (tx) => {
        const changed = await tx.query(
          `UPDATE webhooks SET
             url = COALESCE($3, url),
             events = COALESCE($4, events),
             enabled = COALESCE($5, enabled),
             failing_since = CASE WHEN $5 IS TRUE AND NOT enabled THEN NULL ELSE failing_since END,
             last_error = CASE WHEN $5 IS TRUE AND NOT enabled THEN NULL ELSE last_error END
           WHERE workspace_id = $1 AND id = $2 RETURNING id`,
          [
            workspace,
            request.params.webhook.toLowerCase(),
            url === undefined ? null : new URL(url).href,
            events ?? null,
            enabled ?? null,
          ],
        );
        if (changed.rows.length > 0) {
          await told(
            tx,
            request,
            "webhook.changed",
            workspace,
            request.params.webhook.toLowerCase(),
            {
              ...(url === undefined ? {} : { to: new URL(url).origin }),
              ...(events === undefined ? {} : { events: [...events] }),
              ...(enabled === undefined ? {} : { enabled }),
            },
          );
        }
        return changed.rows;
      });
      if (rows.length === 0) return fail(reply, 404, noWebhook);
      return shown((await one(workspace, request.params.webhook)) ?? {});
    },
  );

  app.delete<{ Params: WebhookParams }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook",
    { schema: { params: webhookParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, true);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const rows = await db.transaction(async (tx) => {
        const removed = await tx.query(
          "DELETE FROM webhooks WHERE workspace_id = $1 AND id = $2 RETURNING id, url",
          [workspace, request.params.webhook.toLowerCase()],
        );
        const row = removed.rows[0];
        if (row !== undefined) {
          await told(tx, request, "webhook.deleted", workspace, readText(row, "id"), {
            to: new URL(readText(row, "url")).origin,
          });
        }
        return removed.rows;
      });
      if (rows.length === 0) return fail(reply, 404, noWebhook);
      return reply.code(204).send();
    },
  );

  // A new secret replaces the old one at once, shown this once.
  app.post<{ Params: WebhookParams }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook/secret",
    { schema: { params: webhookParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, true);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const secret = newSecret();
      const rows = await db.transaction(async (tx) => {
        const changed = await tx.query(
          "UPDATE webhooks SET secret = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id",
          [workspace, request.params.webhook.toLowerCase(), secret],
        );
        if (changed.rows.length > 0) {
          await told(
            tx,
            request,
            "webhook.secret_changed",
            workspace,
            request.params.webhook.toLowerCase(),
          );
        }
        return changed.rows;
      });
      if (rows.length === 0) return fail(reply, 404, noWebhook);
      return { ...shown((await one(workspace, request.params.webhook)) ?? {}), secret };
    },
  );

  // A test event, `webhook.test`, sent as soon as the worker next runs.
  app.post<{ Params: WebhookParams }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook/test",
    { schema: { params: webhookParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, true);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      const row = await one(workspace, request.params.webhook);
      if (row === undefined) return fail(reply, 404, noWebhook);
      if (row.enabled !== true) return fail(reply, 409, "This webhook is off: turn it on first.");
      const id = randomUUID();
      const webhook = readText(row, "id");
      await db.query(
        `INSERT INTO webhook_deliveries (id, webhook_id, type, body, status, next_at)
         VALUES ($1, $2, 'webhook.test', $3, 'waiting', now())`,
        [
          id,
          webhook,
          JSON.stringify({
            type: "webhook.test",
            timestamp: new Date().toISOString(),
            data: { workspace, webhook },
          }),
        ],
      );
      return reply.code(202).send({ delivery: id });
    },
  );

  app.get<{ Params: WebhookParams }>(
    "/api/v1/workspaces/:workspace/webhooks/:webhook/deliveries",
    { schema: { params: webhookParams }, preHandler },
    async (request, reply) => {
      const workspace = await managed(callerOf(request), request.params.workspace, false);
      if (typeof workspace !== "string") return fail(reply, workspace[0], workspace[1]);
      if ((await one(workspace, request.params.webhook)) === undefined) {
        return fail(reply, 404, noWebhook);
      }
      const { rows } = await db.query(
        `SELECT id, type, status, attempts, answer, error, created_at, next_at, finished_at
           FROM webhook_deliveries WHERE webhook_id = $1
          ORDER BY created_at DESC, id LIMIT 50`,
        [request.params.webhook.toLowerCase()],
      );
      return {
        deliveries: rows.map((row) => ({
          id: readText(row, "id"),
          type: readText(row, "type"),
          status: readText(row, "status"),
          attempts: Number(row.attempts),
          answer: typeof row.answer === "number" ? row.answer : null,
          error: readTextOrNull(row, "error"),
          createdAt: readTime(row, "created_at").toISOString(),
          nextAt: row.next_at === null ? null : readTime(row, "next_at").toISOString(),
          finishedAt: row.finished_at === null ? null : readTime(row, "finished_at").toISOString(),
        })),
      };
    },
  );
}
