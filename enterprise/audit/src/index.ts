// Audit logs (ADR 0081), the `audit` enterprise feature: every event the
// server tells of, recorded in the transaction of the change it tells of,
// as the next row of a chained, append-only log; searched, checked and
// kept as long as an instance admin says, in the admin console. While the
// feature is off, nothing is recorded and its routes answer 404; turning
// it on or off is recorded either way.
import type { Database, Queryable } from "@nether/server/src/db.ts";
import type { EnterpriseContext, EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { type ServerEvent, accountActor, originOf } from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import { type ChainKey, chainKey } from "./chain.ts";
import { checkLog } from "./check.ts";
import { record } from "./log.ts";
import {
  keepUp,
  maxRetentionDays,
  minRetentionDays,
  pinnedRetention,
  retentionDays,
  setRetentionDays,
} from "./retention.ts";
import { actionGroups, isActionGroup, searchLog, shownEvent } from "./search.ts";

export { canonical, chainKey, keyFingerprint, rowHash } from "./chain.ts";
export { type CheckResult, checkLog } from "./check.ts";
export { type AuditRow, fieldsOf, record } from "./log.ts";
export { checkpoint, keepUp, purge, retentionDays } from "./retention.ts";
export { actionGroups, searchLog } from "./search.ts";

/** How often the log is purged and its head recorded. */
const upkeepEvery = 3_600_000;

/** Whether an event is recorded even with the feature off: turning audit logs on or off. */
function recordedAlways(event: ServerEvent): boolean {
  return event.action === "instance.feature_changed" && event.details?.feature === "audit";
}

interface EventsQuery {
  readonly actor?: string;
  readonly email?: string;
  readonly action?: string;
  readonly group?: string;
  readonly workspace?: string;
  readonly outcome?: "success" | "failure";
  readonly from?: string;
  readonly to?: string;
  readonly before?: number;
  readonly limit?: number;
}

const eventsQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    actor: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string", minLength: 1, maxLength: 320 },
    action: { type: "string", minLength: 1, maxLength: 64 },
    group: { type: "string", enum: Object.keys(actionGroups) },
    workspace: uuidField,
    outcome: { type: "string", enum: ["success", "failure"] },
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    before: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
} as const;

const settingsBody = {
  type: "object",
  required: ["retentionDays"],
  additionalProperties: false,
  properties: {
    retentionDays: { type: "integer", minimum: minRetentionDays, maximum: maxRetentionDays },
  },
} as const;

/** Records one of the log's own events, in a transaction of its own. */
function recordOwn(
  db: Database,
  key: ChainKey,
  event: Omit<Parameters<typeof record>[1], "origin">,
  request: Parameters<typeof originOf>[0],
) {
  return db.transaction((tx) => record(tx, { ...event, origin: originOf(request) }, key));
}

/** The audit routes and upkeep, and the listener that records each event. */
/** The app a module's plugin is given. */
type ModuleApp = Parameters<EnterpriseModule["plugin"]>[0];

function registerAudit(
  app: ModuleApp,
  db: Database,
  isOn: (db?: Queryable) => Promise<boolean>,
  key: ChainKey,
  pinned: number | undefined,
  whenOn: EnterpriseContext["whenOn"],
  /** Whether a workspace is on legal hold now, which holds the purge. */
  held: () => Promise<boolean>,
): void {
  const account = signedIn(db);
  const admin = instanceAdmin("read and keep the audit log");
  app.get<{ Querystring: EventsQuery }>(
    "/api/audit/events",
    { schema: { querystring: eventsQuery }, preHandler: [whenOn, account, admin] },
    async (request, reply) => {
      const { query } = request;
      if (query.group !== undefined && !isActionGroup(query.group)) {
        return fail(reply, 400, "There is no such group of actions.");
      }
      const page = await searchLog(db, {
        actor: query.actor,
        email: query.email,
        action: query.action,
        group: query.group,
        workspace: query.workspace,
        outcome: query.outcome,
        from: query.from === undefined ? undefined : new Date(query.from),
        to: query.to === undefined ? undefined : new Date(query.to),
        before: query.before,
        limit: query.limit ?? 50,
      });
      return { events: page.events.map(shownEvent), next: page.next };
    },
  );

  // The accounts the console's filter offers, by name or email.
  app.get<{ Querystring: { readonly q?: string } }>(
    "/api/audit/actors",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { q: { type: "string", maxLength: 320 } },
        },
      },
      preHandler: [whenOn, account, admin],
    },
    async (request) => {
      const typed = `%${(request.query.q ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\\%_]/g, "\\$&")}%`;
      const { rows } = await db.query(
        `SELECT id, name, email FROM users
          WHERE lower(name) LIKE $1 OR lower(email) LIKE $1
          ORDER BY lower(name), lower(email) LIMIT 20`,
        [typed],
      );
      return {
        actors: rows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          email: String(row.email),
        })),
      };
    },
  );

  // The workspaces the console's filter offers.
  app.get("/api/audit/workspaces", { preHandler: [whenOn, account, admin] }, async () => {
    const { rows } = await db.query("SELECT id, name FROM workspaces ORDER BY lower(name), id");
    return { workspaces: rows.map((row) => ({ id: String(row.id), name: String(row.name) })) };
  });

  app.get("/api/audit/settings", { preHandler: [whenOn, account, admin] }, async () => {
    const { rows } = await db.query("SELECT count(*) AS count, max(seq) AS head FROM audit_events");
    return {
      retentionDays: await retentionDays(db, pinned),
      pinned: pinned !== undefined,
      keyed: key !== null,
      events: Number(rows[0]?.count ?? 0),
      head: rows[0]?.head === null || rows[0]?.head === undefined ? null : Number(rows[0].head),
    };
  });

  app.put<{ Body: { readonly retentionDays: number } }>(
    "/api/audit/settings",
    { schema: { body: settingsBody }, preHandler: [whenOn, account, admin] },
    async (request, reply) => {
      if (pinned !== undefined) {
        return fail(reply, 409, "NETHER_AUDIT_RETENTION_DAYS sets it: change it there.");
      }
      const days = request.body.retentionDays;
      await db.transaction(async (tx) => {
        const was = await retentionDays(tx, undefined);
        await setRetentionDays(tx, days);
        if (was === days) return;
        await record(
          tx,
          {
            action: "audit.retention_changed",
            actor: accountActor(accountOf(request).id),
            details: { from: was, to: days },
            origin: originOf(request),
          },
          key,
        );
      });
      return { retentionDays: days };
    },
  );

  // Checks the chain, and records that it did, with what it found.
  app.post("/api/audit/check", { preHandler: [whenOn, account, admin] }, async (request) => {
    const result = await checkLog(db, key);
    await recordOwn(
      db,
      key,
      {
        action: "audit.checked",
        outcome: result.broken === null ? "success" : "failure",
        ...(result.broken === null ? {} : { reason: result.broken.problem }),
        actor: accountActor(accountOf(request).id),
        details: {
          checked: result.checked,
          from: result.from,
          to: result.to,
          brokenAt: result.broken?.seq ?? null,
        },
      },
      request,
    );
    return result;
  });

  // Hourly, while the feature is on: the purge, then a checkpoint, written
  // to the server's log too.
  const upkeep = async () => {
    if (!(await isOn())) return;
    const { purged, head } = await keepUp(db, key, pinned, held);
    if (purged === null) {
      app.log.info("A workspace is on legal hold: the audit log purges nothing");
    } else if (purged > 0) {
      app.log.info({ purged }, "Purged the audit log's oldest events");
    }
    if (head !== undefined) app.log.info({ audit: head }, "Audit log checkpoint");
  };
  const timer = setInterval(() => {
    upkeep().catch((error: unknown) => {
      app.log.error({ err: error }, "Could not keep the audit log up");
    });
  }, upkeepEvery);
  timer.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(timer);
    done();
  });
}

/**
 * The audit module, read from `env` as the server's environment holds it:
 * NETHER_AUDIT_RETENTION_DAYS pins the days the log keeps its events.
 */
export function createAuditModule(env: NodeJS.ProcessEnv = process.env): EnterpriseModule {
  const pinned = pinnedRetention(env.NETHER_AUDIT_RETENTION_DAYS);
  return {
    feature: "audit",
    plugin: (app, { db, config, isOn, whenOn, events, dataPolicies }) => {
      const key = chainKey(config.secretKey);
      const stop = events.listen(
        async (event, origin, tx) => {
          if (!recordedAlways(event) && !(await isOn(tx))) return;
          await record(
            tx,
            {
              action: event.action,
              outcome: event.outcome,
              reason: event.reason,
              actor: event.actor,
              workspace: event.workspace,
              target: event.target,
              details: event.details,
              origin,
            },
            key,
          );
        },
        // While off, nothing is found only to be recorded, as the notes a
        // vault document no longer lists.
        (tx) => isOn(tx),
      );
      app.addHook("onClose", (_instance, done) => {
        stop();
        done();
      });
      // While a workspace is on legal hold, the log purges nothing (ADR 0088):
      // its purge cuts the chain's oldest rows, the held workspace's among them.
      registerAudit(app, db, isOn, key, pinned, whenOn, () => dataPolicies.anyHold());
      return Promise.resolve();
    },
  };
}

/** The module as the image runs it, with the server's environment. */
export const auditModule = createAuditModule();
