// The `policies` enterprise feature (ADR 0079): the policies an
// organization sets for every workspace on its server. The approved AI
// endpoints (ADR 0086), which every Nether app keeps to while this feature
// is on, and the data policies (ADR 0088): public sharing, export,
// retention and legal hold, for every workspace or one set apart. Core
// keeps them and enforces them; this module gives the console its routes,
// and tells of each change, which audit logs record.
import type { Queryable } from "@nether/server/src/db.ts";
import { type DataPolicy, keptDays, shareLinkPolicies } from "@nether/server/src/dataPolicies.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import {
  type EventDetails,
  type EventOrigin,
  type EventTarget,
  type ServerEvents,
  accountActor,
  originOf,
} from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import { SettingRefused } from "@nether/server/src/settings.ts";

const endpointsBody = {
  type: "object",
  required: ["endpoints"],
  additionalProperties: false,
  properties: {
    endpoints: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 2000 },
    },
  },
} as const;

// One type list, not anyOf: Fastify coerces types, and 0 would become null.
const daysField = {
  type: ["integer", "null"],
  minimum: keptDays.min,
  maximum: keptDays.max,
} as const;

const policyBody = {
  type: "object",
  required: ["shareLinks", "sites", "export", "historyDays", "trashDays", "legalHold"],
  additionalProperties: false,
  properties: {
    shareLinks: { type: "string", enum: shareLinkPolicies },
    sites: { type: "boolean" },
    export: { type: "boolean" },
    historyDays: daysField,
    trashDays: daysField,
    legalHold: { type: "boolean" },
  },
} as const;

/** A policy as an event's details hold it. */
function detailsOf(policy: DataPolicy | undefined): EventDetails[string] {
  return policy === undefined ? null : { ...policy };
}

/**
 * Tells of a policy changed, and of legal hold set or taken off, in the
 * change's transaction. `held` is whether hold held before and after, for
 * a workspace as the policy that applies to it says, or for every
 * workspace's policy.
 */
async function tellChange(
  events: ServerEvents,
  tx: Queryable,
  change: {
    readonly actor: string;
    readonly origin: EventOrigin;
    readonly workspace: string | null;
    readonly before: DataPolicy | undefined;
    readonly after: DataPolicy | undefined;
    readonly held: readonly [boolean, boolean];
  },
): Promise<void> {
  const { workspace, before, after, held } = change;
  const target: EventTarget =
    workspace === null
      ? { type: "policy", id: "every", name: "Every workspace" }
      : { type: "workspace", id: workspace };
  const told = {
    actor: accountActor(change.actor),
    workspace,
    target,
  } as const;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await events.emit(
      tx,
      {
        action: "policy.changed",
        ...told,
        details: { before: detailsOf(before), after: detailsOf(after) },
      },
      change.origin,
    );
  }
  if (held[0] !== held[1]) {
    await events.emit(
      tx,
      { action: held[1] ? "policy.hold_set" : "policy.hold_removed", ...told },
      change.origin,
    );
  }
}

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

/** The `policies` feature's module: its routes answer only while it is on, and to instance admins. */
export const policiesModule: EnterpriseModule = {
  feature: "policies",
  plugin: (app, { db, whenOn, aiEndpoints, dataPolicies, events }) => {
    const account = signedIn(db);
    const seeing = [whenOn, account, instanceAdmin("see the data policies")];
    const setting = [whenOn, account, instanceAdmin("change the data policies")];

    app.get("/api/admin/data-policies", { preHandler: seeing }, () => dataPolicies.state());

    app.put<{ Body: DataPolicy }>(
      "/api/admin/data-policies",
      { schema: { body: policyBody }, preHandler: setting },
      async (request) => {
        const after = request.body;
        await dataPolicies.setEvery(after, (tx, before) =>
          tellChange(events, tx, {
            actor: accountOf(request).id,
            origin: originOf(request),
            workspace: null,
            before,
            after,
            held: [before?.legalHold === true, after.legalHold],
          }),
        );
        return dataPolicies.state();
      },
    );

    app.put<{ Params: { workspace: string }; Body: DataPolicy }>(
      "/api/admin/data-policies/workspaces/:workspace",
      { schema: { params: workspaceParams, body: policyBody }, preHandler: setting },
      async (request, reply) => {
        const workspace = request.params.workspace.toLowerCase();
        const after = request.body;
        // What held for it before, when it was not set apart.
        const { every } = await dataPolicies.state();
        const made = await dataPolicies.setApart(workspace, after, (tx, before) =>
          tellChange(events, tx, {
            actor: accountOf(request).id,
            origin: originOf(request),
            workspace,
            before,
            after,
            held: [(before ?? every).legalHold, after.legalHold],
          }),
        );
        if (!made) return fail(reply, 404, "There is no such workspace.");
        return dataPolicies.state();
      },
    );

    app.delete<{ Params: { workspace: string } }>(
      "/api/admin/data-policies/workspaces/:workspace",
      { schema: { params: workspaceParams }, preHandler: setting },
      async (request, reply) => {
        const workspace = request.params.workspace.toLowerCase();
        // What holds for it after: every workspace's policy.
        const { every } = await dataPolicies.state();
        const removed = await dataPolicies.removeApart(workspace, (tx, before) =>
          tellChange(events, tx, {
            actor: accountOf(request).id,
            origin: originOf(request),
            workspace,
            before,
            after: undefined,
            held: [before?.legalHold === true, every.legalHold],
          }),
        );
        if (!removed) return fail(reply, 404, "This workspace is not set apart.");
        return dataPolicies.state();
      },
    );

    app.get(
      "/api/admin/ai-endpoints",
      { preHandler: [whenOn, account, instanceAdmin("see the approved AI endpoints")] },
      () => aiEndpoints.state(),
    );

    app.put<{ Body: { readonly endpoints: readonly string[] } }>(
      "/api/admin/ai-endpoints",
      {
        schema: { body: endpointsBody },
        preHandler: [whenOn, account, instanceAdmin("change the approved AI endpoints")],
      },
      async (request, reply) => {
        try {
          await aiEndpoints.set(request.body.endpoints);
        } catch (error) {
          if (error instanceof SettingRefused) return fail(reply, error.status, error.message);
          throw error;
        }
        return aiEndpoints.state();
      },
    );
    return Promise.resolve();
  },
};
