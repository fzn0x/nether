// What a load balancer or Kubernetes asks of a node, and how a node stops
// (ADR 0082). `/health` says the process answers and checks nothing else,
// so a database outage restarts no node. `/health/ready` says whether to
// send the node work: its database answers, and it is not draining.
// Valkey's state is in its answer but never fails it: while Valkey is away
// every node would fail together, and taking them all out helps no one.
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Database } from "./db.ts";

/** How long the database has to answer the readiness probe. */
const answerWithin = 2_000;

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
