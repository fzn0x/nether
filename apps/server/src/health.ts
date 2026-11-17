// What a load balancer or Kubernetes asks of a node, and how a node stops
// (ADR 0082). `/health` says the process answers and checks nothing else,
// so a database outage restarts no node. `/health/ready` says whether to
// send the node work: its database answers, and it is not draining.
// Valkey's state is in its answer but never fails it: while Valkey is away
// every node would fail together, and taking them all out helps no one.
// A node drains before it stops: its readiness answers 503 at once, and
// it closes a few seconds later, once the load balancer has taken it out.
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Database } from "./db.ts";

/** How long the database has to answer the readiness probe. */
const answerWithin = 2_000;

/** How long closing may take, after the drain's wait, before the process stops anyway. */
const closeWithin = 30_000;

/** Whether this node takes work: no longer, once it drains. */
export class Readiness {
  #draining = false;

  get draining(): boolean {
    return this.#draining;
  }

  /** From now on, the readiness probe answers 503. */
  drain(): void {
    this.#draining = true;
  }
}

const readyAnswer = {
  type: "object",
  required: ["status", "database", "valkey"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "draining", "unready"] },
    database: { type: "string", enum: ["up", "down"] },
    valkey: { type: "string", enum: ["up", "down", "none"] },
  },
} as const;

const readySchema = { response: { 200: readyAnswer, 503: readyAnswer } } as const;

/** Whether the database answers a query within a moment. */
async function databaseAnswers(db: Database): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      db.query("SELECT 1").then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, answerWithin);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The readiness probe, `GET /health/ready`: 200 when the node takes work, else 503. */
export function registerReadiness(
  app: FastifyInstance,
  db: Database,
  valkey: Pick<Redis, "status"> | undefined,
  readiness: Readiness,
): void {
  app.get("/health/ready", { schema: readySchema }, async (_request, reply) => {
    const database = await databaseAnswers(db);
    const status = readiness.draining ? "draining" : database ? "ready" : "unready";
    return reply.code(status === "ready" ? 200 : 503).send({
      status,
      database: database ? "up" : "down",
      valkey: valkey === undefined ? "none" : valkey.status === "ready" ? "up" : "down",
    });
  });
}

/**
 * Drains this node, then closes it: the readiness probe answers 503 at
 * once; after `seconds`, while the load balancer takes the node out, the
 * server closes its sockets with 1012, "service restart", stores its open
 * documents, and finishes the requests under way. Rejects when closing
 * takes longer than half a minute.
 */
export async function drain(
  app: FastifyInstance,
  readiness: Readiness,
  seconds: number,
): Promise<void> {
  readiness.drain();
  if (seconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The server took over half a minute to close."));
        }, closeWithin);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
