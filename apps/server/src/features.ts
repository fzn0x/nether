// The console's Features page's routes (ADR 0079): each enterprise feature's
// switch, for instance admins, and turning one on or off where the
// environment does not pin it. They are in every build: without them, a
// feature off could be turned on only by the environment.
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import type { Database } from "./db.ts";
import { type EnterpriseSwitches, isEnterpriseFeature, switchVariable } from "./enterprise.ts";
import { fail } from "./http.ts";
import { accountOf, signedIn } from "./sessions.ts";
import { type ServerEvents, accountActor, originOf } from "./events.ts";

/** A route's check that its account is an instance admin, after `signedIn`. */
export function instanceAdmin(what: string) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    if (accountOf(request).instanceAdmin) {
      done();
      return;
    }
    fail(reply, 403, `Only an instance admin may ${what}.`);
  };
}

export function registerFeatures(
  app: FastifyInstance,
  db: Database,
  switches: EnterpriseSwitches,
  events: ServerEvents,
): void {
  const account = signedIn(db);

  app.get(
    "/api/instance/features",
    { preHandler: [account, instanceAdmin("see the server's features")] },
    async () => ({ features: await switches.states() }),
  );

  app.put<{ Params: { feature: string }; Body: { on: boolean } }>(
    "/api/instance/features/:feature",
    {
      schema: {
        body: {
          type: "object",
          required: ["on"],
          additionalProperties: false,
          properties: { on: { type: "boolean" } },
        },
      },
      preHandler: [account, instanceAdmin("turn the server's features on or off")],
    },
    async (request, reply) => {
      const { feature } = request.params;
      if (!isEnterpriseFeature(feature)) return fail(reply, 404, "There is no such feature.");
      if (switches.pinned(feature) !== undefined) {
        return fail(reply, 409, `${switchVariable(feature)} sets it: change it there.`);
      }
      if (!switches.available(feature)) {
        return fail(reply, 409, `This build of Nether has no ${feature} module.`);
      }
      const was = await switches.on(feature);
      await db.transaction(async (tx) => {
        await switches.set(feature, request.body.on, tx);
        if (was === request.body.on) return;
        await events.emit(
          tx,
          {
            action: "instance.feature_changed",
            actor: accountActor(accountOf(request).id),
            target: { type: "feature", id: feature, name: feature },
            details: { feature, on: request.body.on },
          },
          originOf(request),
        );
      });
      return (await switches.states()).find((state) => state.feature === feature);
    },
  );
}
