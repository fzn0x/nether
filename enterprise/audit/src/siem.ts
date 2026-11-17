// The console's routes for the audit log's destinations (ADR 0081), and the
// sending that runs on every node: up to five an instance admin adds, each
// syslog or a webhook, beside one of each the environment may pin. Adding,
// changing or removing one is recorded, by its kind and its address, never
// its secret; a webhook's address by its origin alone.
import type { Database, Queryable } from "@nether/server/src/db.ts";
import type { EnterpriseContext, EnterpriseModule } from "@nether/server/src/enterprise.ts";
import { accountActor, originOf } from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail, uuidField } from "@nether/server/src/http.ts";
import type { Seal } from "@nether/server/src/secrets.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import type { ChainKey } from "./chain.ts";
import {
  type Destination,
  type DestinationKind,
  type PinnedDestination,
  addDestination,
  destinationOf,
  destinationProblem,
  keepPinned,
  listDestinations,
  maxDestinations,
  recordedAddress,
  settingsOf,
  shownDestination,
  waiting,
} from "./destinations.ts";
import { type Sender, sendDue } from "./export.ts";
import { record } from "./log.ts";

/** How often each node looks for events to send. */
const sendEvery = 2_000;

const destinationBody = {
  type: "object",
  required: ["kind", "name", "address"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["syslog", "webhook"] },
    name: { type: "string", minLength: 1, maxLength: 100 },
    address: { type: "string", minLength: 1, maxLength: 2000 },
    ca: { type: "string", maxLength: 20_000 },
    fingerprint: { type: "string", maxLength: 200 },
    from: { type: "string", enum: ["newest", "oldest"] },
  },
} as const;

const changeBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    address: { type: "string", minLength: 1, maxLength: 2000 },
    ca: { type: "string", maxLength: 20_000 },
    fingerprint: { type: "string", maxLength: 200 },
  },
} as const;

interface DestinationBody {
  readonly kind: DestinationKind;
  readonly name: string;
  readonly address: string;
  readonly ca?: string;
  readonly fingerprint?: string;
  readonly from?: "newest" | "oldest";
}

type ChangeBody = Partial<Omit<DestinationBody, "kind" | "from">>;

/** The app a module's plugin is given. */
type ModuleApp = Parameters<EnterpriseModule["plugin"]>[0];

/** A destination as an event's target. */
function targetOf(destination: Destination) {
  return { type: "audit_destination", id: destination.id, name: destination.name };
}

/** A change refused, with its status and the reason the console shows. */
function refusal(refused: number, message: string) {
  return { refused, message };
}

/** One destination by its ID, locked for a change; undefined for none. */
async function lockedDestination(tx: Queryable, id: string) {
  const { rows } = await tx.query("SELECT * FROM audit_destinations WHERE id = $1 FOR UPDATE", [
    id,
  ]);
  return rows[0] === undefined ? undefined : destinationOf(rows[0]);
}

export interface SiemOptions {
  readonly db: Database;
  readonly isOn: (db?: Queryable) => Promise<boolean>;
  readonly whenOn: EnterpriseContext["whenOn"];
  readonly key: ChainKey;
  readonly seal: Seal | undefined;
  readonly pinned: readonly PinnedDestination[];
  readonly sender: Sender;
  /** How often to look for events to send; two seconds. */
  readonly every?: number;
}

/** The destinations' routes, the environment's kept, and the sending started. */
export async function registerSiem(app: ModuleApp, options: SiemOptions): Promise<void> {
  const { db, key, seal, whenOn } = options;
  await keepPinned(db, options.pinned);
  const account = signedIn(db);
  const admin = instanceAdmin("send the audit log to a SIEM");

  app.get("/api/audit/destinations", { preHandler: [whenOn, account, admin] }, async () => {
    const [destinations, counts] = await Promise.all([listDestinations(db), waiting(db)]);
    return {
      destinations: destinations.map((each) => shownDestination(each, counts.get(each.id) ?? 0)),
      max: maxDestinations,
      sealing: seal !== undefined,
    };
  });

  app.post<{ Body: DestinationBody }>(
    "/api/audit/destinations",
    { schema: { body: destinationBody }, preHandler: [whenOn, account, admin] },
    async (request, reply) => {
      const body = request.body;
      const problem = destinationProblem(body.kind, body.address.trim());
      if (problem !== undefined) return fail(reply, 400, problem);
      if (body.kind === "webhook" && seal === undefined) {
        return fail(reply, 409, "Set NETHER_SECRET_KEY first: it keeps a webhook's secret.");
      }
      try {
        if (body.kind === "syslog") settingsOf(body);
      } catch (error) {
        return fail(reply, 400, error instanceof Error ? error.message : String(error));
      }
      const made = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          "SELECT count(*) AS count FROM audit_destinations WHERE pinned_by IS NULL",
        );
        if (Number(rows[0]?.count ?? 0) >= maxDestinations) return undefined;
        const added = await addDestination(
          tx,
          { ...body, name: body.name.trim(), from: body.from ?? "newest" },
          seal,
        );
        await record(
          tx,
          {
            action: "audit.destination_added",
            actor: accountActor(accountOf(request).id),
            target: targetOf(added.destination),
            details: {
              kind: body.kind,
              address: recordedAddress(body.kind, body.address.trim()),
              from: body.from ?? "newest",
            },
            origin: originOf(request),
          },
          key,
        );
        return added;
      });
      if (made === undefined) {
        return fail(reply, 409, `The log goes to ${String(maxDestinations)} destinations at most.`);
      }
      return reply.code(201).send({
        destination: shownDestination(made.destination, 0),
        // Shown once: the server keeps it sealed, and shows it never again.
        secret: made.secret,
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: ChangeBody }>(
    "/api/audit/destinations/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: uuidField } },
        body: changeBody,
      },
      preHandler: [whenOn, account, admin],
    },
    async (request, reply) => {
      const body = request.body;
      const changed = await db.transaction(async (tx) => {
        const destination = await lockedDestination(tx, request.params.id.toLowerCase());
        if (destination === undefined) return refusal(404, "There is no such destination.");
        if (destination.pinnedBy !== null) {
          return refusal(409, `${destination.pinnedBy} sets it: change it there.`);
        }
        const address = body.address?.trim() ?? destination.address;
        const problem = destinationProblem(destination.kind, address);
        if (problem !== undefined) return refusal(400, problem);
        let settings = destination.settings;
        if (
          destination.kind === "syslog" &&
          (body.ca !== undefined || body.fingerprint !== undefined)
        ) {
          try {
            settings = settingsOf(body);
          } catch (error) {
            return refusal(400, error instanceof Error ? error.message : String(error));
          }
        }
        const name = body.name?.trim() ?? destination.name;
        const { rows } = await tx.query(
          `UPDATE audit_destinations
              SET name = $2, address = $3, settings = $4, updated_at = now(),
                  failures = 0, next_try_at = now()
            WHERE id = $1 RETURNING *`,
          [destination.id, name, address, JSON.stringify(settings)],
        );
        const after = destinationOf(rows[0] ?? {});
        const details: Record<string, string | boolean> = { kind: destination.kind };
        if (name !== destination.name) {
          details.nameFrom = destination.name;
          details.nameTo = name;
        }
        if (address !== destination.address) {
          details.addressFrom = recordedAddress(destination.kind, destination.address);
          details.addressTo = recordedAddress(destination.kind, address);
        }
        if (JSON.stringify(settings) !== JSON.stringify(destination.settings)) {
          details.trust =
            settings.fingerprint === undefined
              ? settings.ca === undefined
                ? "system"
                : "ca"
              : "fingerprint";
        }
        await record(
          tx,
          {
            action: "audit.destination_changed",
            actor: accountActor(accountOf(request).id),
            target: targetOf(after),
            details,
            origin: originOf(request),
          },
          key,
        );
        return { destination: after };
      });
      if ("refused" in changed) return fail(reply, changed.refused, changed.message);
      const counts = await waiting(db);
      return shownDestination(changed.destination, counts.get(changed.destination.id) ?? 0);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/audit/destinations/:id",
    {
      schema: { params: { type: "object", required: ["id"], properties: { id: uuidField } } },
      preHandler: [whenOn, account, admin],
    },
    async (request, reply) => {
      const refused = await db.transaction(async (tx) => {
        const destination = await lockedDestination(tx, request.params.id.toLowerCase());
        if (destination === undefined) return [404, "There is no such destination."] as const;
        if (destination.pinnedBy !== null) {
          return [409, `${destination.pinnedBy} sets it: remove it there.`] as const;
        }
        await tx.query("DELETE FROM audit_destinations WHERE id = $1", [destination.id]);
        await record(
          tx,
          {
            action: "audit.destination_removed",
            actor: accountActor(accountOf(request).id),
            target: targetOf(destination),
            details: {
              kind: destination.kind,
              address: recordedAddress(destination.kind, destination.address),
            },
            origin: originOf(request),
          },
          key,
        );
        return undefined;
      });
      if (refused !== undefined) return fail(reply, refused[0], refused[1]);
      return reply.code(204).send();
    },
  );

  // Every node sends, each destination by one node at a time.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    (async () => {
      if (await options.isOn()) await sendDue(db, options.sender, app.log);
    })()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Could not send the audit log");
      })
      .finally(() => {
        running = false;
      });
  }, options.every ?? sendEvery);
  timer.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(timer);
    options.sender.close();
    done();
  });
}
