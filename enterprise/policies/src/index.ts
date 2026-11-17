// The `policies` enterprise feature (ADR 0079): the policies an
// organization sets for every workspace on its server. The approved AI
// endpoints (ADR 0086), which every Nether app keeps to while this feature
// is on, and the data policies (ADR 0088): public sharing and export, for
// every workspace or one set apart. Core keeps them and enforces them; this
// module gives the console its routes.
import { type DataPolicy, shareLinkPolicies } from "@nether/server/src/dataPolicies.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import { signedIn } from "@nether/server/src/sessions.ts";
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

const policyBody = {
  type: "object",
  required: ["shareLinks", "sites", "export"],
  additionalProperties: false,
  properties: {
    shareLinks: { type: "string", enum: shareLinkPolicies },
    sites: { type: "boolean" },
    export: { type: "boolean" },
  },
} as const;

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

/** The `policies` feature's module: its routes answer only while it is on, and to instance admins. */
export const policiesModule: EnterpriseModule = {
  feature: "policies",
  plugin: (app, { db, whenOn, aiEndpoints, dataPolicies }) => {
    const account = signedIn(db);
    const seeing = [whenOn, account, instanceAdmin("see the data policies")];
    const setting = [whenOn, account, instanceAdmin("change the data policies")];

    app.get("/api/admin/data-policies", { preHandler: seeing }, () => dataPolicies.state());

    app.put<{ Body: DataPolicy }>(
      "/api/admin/data-policies",
      { schema: { body: policyBody }, preHandler: setting },
      async (request) => {
        await dataPolicies.setEvery(request.body);
        return dataPolicies.state();
      },
    );

    app.put<{ Params: { workspace: string }; Body: DataPolicy }>(
      "/api/admin/data-policies/workspaces/:workspace",
      { schema: { params: workspaceParams, body: policyBody }, preHandler: setting },
      async (request, reply) => {
        const workspace = request.params.workspace.toLowerCase();
        if (!(await dataPolicies.setApart(workspace, request.body))) {
          return fail(reply, 404, "There is no such workspace.");
        }
        return dataPolicies.state();
      },
    );

    app.delete<{ Params: { workspace: string } }>(
      "/api/admin/data-policies/workspaces/:workspace",
      { schema: { params: workspaceParams }, preHandler: setting },
      async (request, reply) => {
        const workspace = request.params.workspace.toLowerCase();
        if (!(await dataPolicies.removeApart(workspace))) {
          return fail(reply, 404, "This workspace is not set apart.");
        }
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
