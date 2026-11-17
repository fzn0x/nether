// The `policies` enterprise feature (ADR 0079): the policies an
// organization sets for every workspace on its server. First the approved
// AI endpoints (ADR 0086), which every Nether app keeps to while this
// feature is on; core keeps the list and enforces it, and this module gives
// the console its routes.
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail } from "@nether/server/src/http.ts";
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

/** The `policies` feature's module: its routes answer only while it is on, and to instance admins. */
export const policiesModule: EnterpriseModule = {
  feature: "policies",
  plugin: (app, { db, whenOn, aiEndpoints }) => {
    const account = signedIn(db);

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
