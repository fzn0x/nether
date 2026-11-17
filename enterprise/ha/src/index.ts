// High availability (ADR 0082), the `ha` enterprise feature: several nodes
// of one server, behind a load balancer. The environment alone turns it on,
// with NETHER_ENTERPRISE_HA=on, and it acts as the server starts: it checks
// that the deployment can run several nodes, then gives the server a bus
// over Valkey, which carries the relay's hints and the closes of an
// account's sockets, and Hocuspocus's Redis extension, which shares open
// documents and who is in them across the nodes. It adds no routes.
import { Redis as SharedDocuments } from "@hocuspocus/extension-redis";
import type { Config } from "@nether/server/src/config.ts";
import type { Database } from "@nether/server/src/db.ts";
import type { EnterpriseModule, Started } from "@nether/server/src/enterprise.ts";
import { setupNeeded } from "@nether/server/src/setup.ts";
import { ValkeyBus } from "./bus.ts";

/**
 * What a deployment of several nodes lacks, each said as what to set; none
 * when it has all it needs.
 */
export async function missing(db: Database, config: Config): Promise<string[]> {
  const lacks: string[] = [];
  if (config.redisUrl === null) {
    lacks.push("NETHER_REDIS_URL, the Valkey every node shares");
  }
  if (config.storage.kind === "disk" && !config.storageShared) {
    lacks.push(
      "attachments every node reads: NETHER_STORAGE=s3, or NETHER_STORAGE_SHARED=on when NETHER_STORAGE_PATH is one volume every node mounts",
    );
  }
  if (config.setupCode === null && (await setupNeeded(db))) {
    lacks.push("NETHER_SETUP_CODE while the server has no account, so every node takes one code");
  }
  return lacks;
}

/** The extension's connection, from the address NETHER_REDIS_URL gives, as `redis://user:password@host:6379/0`. */
export function extensionConnection(url: string) {
  const address = new URL(url);
  const database = address.pathname.replace(/^\//, "");
  return {
    // An IPv6 host comes in brackets.
    host: address.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: address.port === "" ? 6379 : Number(address.port),
    options: {
      ...(address.username === "" ? {} : { username: decodeURIComponent(address.username) }),
      ...(address.password === "" ? {} : { password: decodeURIComponent(address.password) }),
      ...(database === "" ? {} : { db: Number(database) }),
      ...(address.protocol === "rediss:" ? { tls: {} } : {}),
    },
  };
}

export interface HighAvailabilityOptions {
  /** What every key and channel starts with, so servers sharing one Valkey stay apart; `nether`. */
  readonly prefix?: string;
}

/** The `ha` module, its keys under `prefix`. */
export function highAvailability(options: HighAvailabilityOptions = {}): EnterpriseModule {
  const prefix = options.prefix ?? "nether";
  return {
    feature: "ha",
    plugin: () => Promise.resolve(),
    async startup({ db, config, log }): Promise<Started> {
      const lacks = await missing(db, config);
      if (lacks.length > 0 || config.redisUrl === null) {
        throw new Error(
          `NETHER_ENTERPRISE_HA is on, and several nodes need ${lacks.join("; and ")}.`,
        );
      }
      const bus = await ValkeyBus.connect(config.redisUrl, `${prefix}:bus:`, log);
      const documents = new SharedDocuments({
        ...extensionConnection(config.redisUrl),
        prefix: `${prefix}:sync`,
        identifier: `${config.nodeName}-${crypto.randomUUID()}`,
        // Stores merge with what is stored, so they never need the lock.
        lockTimeout: 0,
      });
      log.info({ prefix }, "High availability: sharing sync through Valkey");
      return {
        bus,
        syncExtensions: [documents],
        readsThroughSync: true,
        async close() {
          await documents.onDestroy();
          await bus.close();
        },
      };
    },
  };
}

export const haModule = highAvailability();
