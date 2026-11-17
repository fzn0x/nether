// The extension point for enterprise features (ADR 0079). They are free and
// open source, live in enterprise/, and stay off until an admin switches
// them on: in the console, unless NETHER_ENTERPRISE_<FEATURE> pins them on
// or off. Every module a build has registers once, and asks for its switch
// on each request, so a switch takes effect on every node within the few
// seconds the switches are kept. Nothing here imports the modules: a build
// passes in those it has.
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AiEndpoints } from "./aiEndpoints.ts";
import type { Config } from "./config.ts";
import type { DataPolicies } from "./dataPolicies.ts";
import type { Database, Queryable } from "./db.ts";
import type { ServerEvents } from "./events.ts";
import type { Every } from "./jobs.ts";
import type { SecuritySettings } from "./settings.ts";
import type { SignInGuards } from "./signIns.ts";

export const enterpriseFeatures = ["sso", "scim", "audit", "policies", "admin", "ha"] as const;

export type EnterpriseFeature = (typeof enterpriseFeatures)[number];

/** How the environment pins each feature: on, off, or not at all, when the console decides. */
export type EnterprisePins = Readonly<Record<EnterpriseFeature, boolean | undefined>>;

/** What the server shares with every module, beside its switch. */
export interface EnterpriseServices {
  readonly db: Database;
  /** The server's configuration, as its environment set it: its public address and secret key among them. */
  readonly config: Config;
  /**
   * Closes an account's open sync and relay connections on every node, so
   * its apps connect again and every document is checked anew, as a change
   * of its role does (ADR 0082). This node's close at once; the others'
   * are asked through the bus, fire and forget, so callers never wait.
   */
  readonly disconnect: (userId: string) => void;
  /** The security settings (ADR 0084), which the console's Security page reads and sets. */
  readonly security: SecuritySettings;
  /** The approved AI endpoints (ADR 0086), which the `policies` module's page reads and sets. */
  readonly aiEndpoints: AiEndpoints;
  /**
   * The guards the server asks before it looks an account up by its
   * address, when a session starts and each time one is used (ADR 0080):
   * a module adds its own, as single sign-on does to require a provider.
   */
  readonly guards: SignInGuards;
  /**
   * Runs work once in each period across the server's nodes, claimed in
   * the database (ADR 0082), as a daily refresh or an hourly purge.
   */
  readonly every: Every;
  /**
   * The server's events (ADR 0081): what a module listens to, as audit logs
   * do, and tells of when it changes what the server's routes would, as the
   * console setting a member's role does.
   */
  readonly events: ServerEvents;
  /** The workspaces' data policies (ADR 0088), which the `policies` module's page reads and sets. */
  readonly dataPolicies: DataPolicies;
}

/** What a module's plugin is given. */
export interface EnterpriseContext extends EnterpriseServices {
  /**
   * Whether the module's feature is on now; asked within a transaction, as
   * a listener of the server's events is, it reads through it.
   */
  readonly isOn: (db?: Queryable) => Promise<boolean>;
  /** A route's check that answers 404 while the module's feature is off. */
  readonly whenOn: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

/** An enterprise feature's code: a Fastify plugin the server registers in every build that has it. */
export interface EnterpriseModule {
  readonly feature: EnterpriseFeature;
  readonly plugin: FastifyPluginAsync<EnterpriseContext>;
}

/** The environment variable that pins a feature, such as NETHER_ENTERPRISE_SSO. */
export function switchVariable(feature: EnterpriseFeature): string {
  return `NETHER_ENTERPRISE_${feature.toUpperCase()}`;
}

/** Whether a name is an enterprise feature's. */
export function isEnterpriseFeature(name: string): name is EnterpriseFeature {
  return (enterpriseFeatures as readonly string[]).includes(name);
}

/** How long a server keeps what the console chose before it reads it again. */
const keptFor = 5_000;

/** The key a feature's switch is kept under in `instance_settings`. */
const settingKey = (feature: EnterpriseFeature) => `enterprise.${feature}`;

/** A feature's switch as the console shows it. */
export interface FeatureState {
  readonly feature: EnterpriseFeature;
  readonly on: boolean;
  /** How the environment pins it, if it does. */
  readonly pinned: "on" | "off" | null;
  /** Whether this build has its module. */
  readonly available: boolean;
}

/**
 * Every feature's switch: its pin when the environment sets one, else what
 * the console chose, kept in the database and read again every few
 * seconds. A feature this build has no module for is off.
 */
export class EnterpriseSwitches {
  readonly #db: Database;
  readonly #pins: EnterprisePins;
  readonly #available: ReadonlySet<EnterpriseFeature>;
  #chosen:
    { readonly at: number; readonly values: Promise<ReadonlyMap<string, boolean>> } | undefined;

  constructor(db: Database, pins: EnterprisePins, available: Iterable<EnterpriseFeature>) {
    this.#db = db;
    this.#pins = pins;
    this.#available = new Set(available);
  }

  /** How the environment pins a feature; undefined when it leaves it to the console. */
  pinned(feature: EnterpriseFeature): boolean | undefined {
    return this.#pins[feature];
  }

  /** Whether this build has a feature's module. */
  available(feature: EnterpriseFeature): boolean {
    return this.#available.has(feature);
  }

  #read(db: Queryable = this.#db): Promise<ReadonlyMap<string, boolean>> {
    const kept = this.#chosen;
    if (kept !== undefined && Date.now() - kept.at < keptFor) return kept.values;
    const values = db
      .query("SELECT key, value FROM instance_settings WHERE key LIKE 'enterprise.%'")
      .then(({ rows }) => new Map(rows.map((row) => [String(row.key), row.value === true])));
    this.#chosen = { at: Date.now(), values };
    // A failed read is not kept: the next asks again.
    values.catch(() => {
      if (this.#chosen?.values === values) this.#chosen = undefined;
    });
    return values;
  }

  /** Whether a feature is on now. */
  async on(feature: EnterpriseFeature, db?: Queryable): Promise<boolean> {
    if (!this.#available.has(feature)) return false;
    const pin = this.#pins[feature];
    if (pin !== undefined) return pin;
    return (await this.#read(db)).get(settingKey(feature)) ?? false;
  }

  /** Every feature's switch, as the console shows them. */
  async states(): Promise<FeatureState[]> {
    return Promise.all(
      enterpriseFeatures.map(async (feature) => {
        const pin = this.#pins[feature];
        return {
          feature,
          on: await this.on(feature),
          pinned: pin === undefined ? null : pin ? ("on" as const) : ("off" as const),
          available: this.#available.has(feature),
        };
      }),
    );
  }

  /** Whether each feature is on now, as the health check says. */
  async all(): Promise<Record<EnterpriseFeature, boolean>> {
    const states = await this.states();
    return Object.fromEntries(states.map((state) => [state.feature, state.on])) as Record<
      EnterpriseFeature,
      boolean
    >;
  }

  /**
   * Keeps the console's choice for a feature the environment does not pin,
   * in `db`'s transaction when given one; this server sees it at once.
   */
  async set(feature: EnterpriseFeature, on: boolean, db: Queryable = this.#db): Promise<void> {
    await db.query(
      `INSERT INTO instance_settings (key, value) VALUES ($1, to_jsonb($2::boolean))
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [settingKey(feature), on],
    );
    this.#chosen = undefined;
  }
}

/** The 404 a feature that is off answers at its routes, as any route the server lacks. */
function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const path = request.url.split("?")[0] ?? request.url;
  return reply.code(404).send({
    statusCode: 404,
    error: "Not Found",
    message: `Route ${request.method}:${path} not found`,
  });
}

/**
 * Registers every module this build has, each with what the server shares
 * and the way to ask for its switch. A feature the environment pins on with
 * no module in the build is an error at startup, not a silent no.
 */
export async function registerEnterprise(
  app: FastifyInstance,
  services: EnterpriseServices,
  switches: EnterpriseSwitches,
  modules: readonly EnterpriseModule[],
): Promise<void> {
  for (const feature of enterpriseFeatures) {
    if (switches.pinned(feature) === true && !switches.available(feature)) {
      throw new Error(
        `${switchVariable(feature)} is on, but this build of Nether has no ${feature} module. ` +
          "Turn it off, or run a build that includes it.",
      );
    }
  }
  for (const module of modules) {
    const isOn = (db?: Queryable) => switches.on(module.feature, db);
    const whenOn = async (request: FastifyRequest, reply: FastifyReply) =>
      (await isOn()) ? undefined : notFound(request, reply);
    await app.register(module.plugin, { ...services, isOn, whenOn });
  }
}
