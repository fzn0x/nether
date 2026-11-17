// Work that runs once across the server's nodes (ADR 0082), as purging
// what is kept too long: each job has a row in `cluster_jobs` with when it
// last started, and a node runs it when an update finds that start older
// than the job's period, as `backup_state` claims backups. Every node
// checks its jobs every minute, at a second of its own; a job that fails
// gives its claim back, so the next check tries again.
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "./db.ts";

/** Runs `work` once in each `period` milliseconds across the server's nodes. */
export type Every = (name: string, period: number, work: () => Promise<void>) => void;

/** How often a node checks whether its jobs are due. */
const checkEvery = 60_000;

interface Job {
  readonly period: number;
  readonly work: () => Promise<void>;
}

export class ClusterJobs {
  readonly #db: Database;
  readonly #node: string;
  readonly #log: FastifyBaseLogger;
  readonly #jobs = new Map<string, Job>();
  /** Jobs this node runs now, which a check does not start again. */
  readonly #running = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(db: Database, node: string, log: FastifyBaseLogger) {
    this.#db = db;
    this.#node = node;
    this.#log = log;
  }

  /** Adds a job: once in each period across the nodes, from the next check. */
  every: Every = (name, period, work) => {
    if (this.#jobs.has(name)) throw new Error(`A job is named ${name} already.`);
    this.#jobs.set(name, { period, work });
  };

  /** Checks every minute, the first at a second of this node's own, so nodes started together spread. */
  start(): void {
    const next = (delay: number) => {
      this.#timer = setTimeout(() => {
        if (this.#stopped) return;
        void this.runDue().finally(() => {
          if (!this.#stopped) next(checkEvery);
        });
      }, delay);
      this.#timer.unref();
    };
    next(Math.floor(Math.random() * checkEvery));
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** Runs each job that is due and that this node claims; gives the names of those it ran. */
  async runDue(): Promise<string[]> {
    const ran: string[] = [];
    for (const [name, job] of this.#jobs) {
      if (this.#running.has(name)) continue;
      const claimed = await this.#claim(name, job.period).catch((error: unknown) => {
        this.#log.error({ err: error, job: name }, "Could not claim a job");
        return undefined;
      });
      if (claimed === undefined) continue;
      this.#running.add(name);
      try {
        await job.work();
        ran.push(name);
      } catch (error) {
        this.#log.error(
          { err: error, job: name },
          "A job failed; it is tried again at the next check",
        );
        // Given back, so the next check of any node runs it again.
        await this.#db
          .query(
            "UPDATE cluster_jobs SET started_at = NULL WHERE name = $1 AND started_at = $2::timestamptz",
            [name, claimed],
          )
          .catch(() => undefined);
      } finally {
        this.#running.delete(name);
      }
    }
    return ran;
  }

  /**
   * Claims a job when its last start is older than its period; gives the
   * start it claimed, as text, which keeps the database's microseconds.
   */
  async #claim(name: string, period: number): Promise<string | undefined> {
    const { rows } = await this.#db.query(
      `INSERT INTO cluster_jobs (name, started_at, node) VALUES ($1, now(), $3)
         ON CONFLICT (name) DO UPDATE SET started_at = now(), node = $3
         WHERE cluster_jobs.started_at IS NULL
            OR cluster_jobs.started_at <= now() - make_interval(secs => $2)
       RETURNING started_at::text AS started`,
      [name, period / 1000, this.#node],
    );
    const started = rows[0]?.started;
    return typeof started === "string" ? started : undefined;
  }
}
