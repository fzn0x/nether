// Each node of the server, as it runs (ADR 0082): a heartbeat in
// `cluster_nodes` every half a minute, with its name, version and start,
// gone when it stops. Instance admins list them in the console. A node
// that runs without high availability and sees another for more than two
// minutes says so in its log: several nodes need `ha`, and a rolling
// restart overlaps for less.
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { type Database, readText, readTime } from "./db.ts";
import { instanceAdmin } from "./features.ts";
import { signedIn } from "./sessions.ts";

/** How often a node writes its heartbeat. */
const beatEvery = 30_000;
/** How long a node is listed after its last heartbeat. */
const listedFor = 120_000;
/** How long another node may be seen beside one without `ha` before it says so. */
const overlapFor = 120_000;

/** This node, as the others and the console see it. */
export interface NodeIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Starts this node's heartbeat, every half a minute from now; gives a beat
 * to write at once, as the server does when it is ready, and what stops
 * it, which forgets the node.
 */
export function startHeartbeat(
  db: Database,
  node: NodeIdentity,
  options: {
    readonly log: FastifyBaseLogger;
    /** Whether this node runs with high availability, so others beside it are expected. */
    readonly highlyAvailable: () => Promise<boolean>;
    readonly every?: number;
    /** How long others may be seen beside a node without `ha` before it says so; two minutes. */
    readonly overlapFor?: number;
  },
): { readonly beat: () => Promise<void>; readonly stop: () => Promise<void> } {
  const started = new Date();
  let othersSince: number | undefined;
  let warned = 0;
  const beat = async () => {
    await db.query(
      `INSERT INTO cluster_nodes (id, name, version, started_at, seen_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET seen_at = now()`,
      [node.id, node.name, node.version, started],
    );
    const { rows } = await db.query(
      `SELECT name FROM cluster_nodes
        WHERE id <> $1 AND seen_at > now() - make_interval(secs => $2)`,
      [node.id, listedFor / 1000],
    );
    if (rows.length === 0 || (await options.highlyAvailable())) {
      othersSince = undefined;
      return;
    }
    const now = Date.now();
    othersSince ??= now;
    // Said once an hour while it lasts, not at every heartbeat.
    if (now - othersSince >= (options.overlapFor ?? overlapFor) && now - warned > 3_600_000) {
      warned = now;
      options.log.error(
        { nodes: rows.map((row) => readText(row, "name")) },
        "Other nodes run beside this one without high availability: their clients do not see each other's edits until they are stored. Set NETHER_ENTERPRISE_HA=on on every node, or run one.",
      );
    }
  };
  const tick = () => {
    beat().catch((error: unknown) => {
      options.log.error({ err: error }, "Could not write this node's heartbeat");
    });
  };
  const timer = setInterval(tick, options.every ?? beatEvery);
  timer.unref();
  return {
    beat,
    async stop() {
      clearInterval(timer);
      await db.query("DELETE FROM cluster_nodes WHERE id = $1", [node.id]).catch(() => undefined);
    },
  };
}

/** Forgets nodes not seen for a day, which stopped without saying so. */
export async function purgeNodes(db: Database): Promise<number> {
  const { rows } = await db.query(
    "DELETE FROM cluster_nodes WHERE seen_at < now() - interval '1 day' RETURNING id",
  );
  return rows.length;
}

/** The instance admins' list of the server's nodes, this one marked. */
export function registerNodes(app: FastifyInstance, db: Database, node: NodeIdentity): void {
  app.get(
    "/api/instance/nodes",
    { preHandler: [signedIn(db), instanceAdmin("see the server's nodes")] },
    async () => {
      const { rows } = await db.query(
        `SELECT id, name, version, started_at, seen_at FROM cluster_nodes
          WHERE seen_at > now() - make_interval(secs => $1)
          ORDER BY started_at, id`,
        [listedFor / 1000],
      );
      return {
        nodes: rows.map((row) => ({
          name: readText(row, "name"),
          version: readText(row, "version"),
          startedAt: readTime(row, "started_at").toISOString(),
          seenAt: readTime(row, "seen_at").toISOString(),
          current: readText(row, "id") === node.id,
        })),
      };
    },
  );
}
