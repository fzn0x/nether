// An LDAP directory's runs (ADR 0085). One job, `scim.ldap` on the
// cluster's `every`, looks each minute for directories that are due; each
// runs every hour unless its admin picks another time, and Sync now runs
// one at once. A run claims its directory's row until it ends, or for an
// hour if its node dies, so two nodes never read one directory at once.
// It reads everything first and changes nothing on any error. A
// directory's first run is a preview, applied once an instance admin
// confirms it; a run that would deactivate more than its share of the
// directory's active accounts, and more than five, changes nothing until
// an instance admin looks, and Run anyway applies it once. Each run is
// recorded, with what it did or why it did not, and told of as
// `directory.synced`.
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import { type Database, type Queryable, readText } from "@nether/server/src/db.ts";
import { type ServerEvents, fromServer } from "@nether/server/src/events.ts";
import type { Resolver } from "@nether/server/src/outbound.ts";
import { SealedElsewhere, sealWith } from "@nether/server/src/secrets.ts";
import { findDirectory } from "./directories.ts";
import { LdapFailure, openLdap } from "./ldapConnect.ts";
import { type DirectoryRead, type Skip, readDirectory } from "./ldapRead.ts";
import {
  type LdapSettings,
  SettingRefused,
  defaultEveryMinutes,
  keptSettings,
  passwordOwner,
} from "./ldapSettings.ts";
import {
  type RunCounts,
  type RunPreview,
  applyPlan,
  deactivating,
  planRun,
  previewOf,
} from "./ldapSync.ts";

/** How a run ended: applied, shown as a preview, held back, or failed. */
export type RunOutcome = "applied" | "preview" | "held" | "failed";

/** A run, as the console shows it. */
export interface RunResult {
  readonly outcome: RunOutcome;
  /** When it ended. */
  readonly at: string;
  readonly seconds: number;
  readonly counts: RunCounts | null;
  readonly failure: string | null;
  /** The first of those skipped, with why. */
  readonly skipped: readonly Skip[];
  /** Who it would change, for a preview or a run held back. */
  readonly preview: RunPreview | null;
}

/** What a directory's row keeps of its runs. */
export interface SyncState {
  /** Whether an instance admin confirmed the first run's preview. */
  readonly confirmed: boolean;
  /** When the last run started, from which the next is due. */
  readonly startedAt: string | null;
  readonly last: RunResult | null;
  /** The accounts a run held back would deactivate, which Run anyway lets go. */
  readonly held: readonly string[];
}

/** How many skipped entries a run keeps to show. */
const skippedShown = 50;

/** How long a claim lasts if its node dies mid-run. */
const claimFor = "1 hour";

/** Reads a directory, as a run does; a test gives its own. */
export type ReadLdap = (
  settings: LdapSettings,
  password: string,
  stopped: () => boolean,
) => Promise<DirectoryRead>;

export interface RunServices {
  readonly db: Database;
  readonly config: Config;
  readonly events: ServerEvents;
  readonly disconnect: (userId: string) => void;
  readonly log: FastifyBaseLogger;
  /** What gives a directory's host's addresses; the system's resolver unless a test gives another. */
  readonly resolve?: Resolver;
  /** Reads a directory; the real one unless a test gives another. */
  readonly read?: ReadLdap;
}

/** A row's sync state, as kept. */
export function syncStateOf(value: unknown): SyncState {
  const kept = typeof value === "object" && value !== null ? (value as Partial<SyncState>) : {};
  return {
    confirmed: kept.confirmed === true,
    startedAt: typeof kept.startedAt === "string" ? kept.startedAt : null,
    last: typeof kept.last === "object" && kept.last !== null ? kept.last : null,
    held: Array.isArray(kept.held) ? kept.held.map(String) : [],
  };
}

/** Whether deactivating `count` of `active` accounts holds a run back. */
export function holdsBack(count: number, active: number, percent: number): boolean {
  return count > 5 && count * 100 > active * percent;
}

/** The directories whose next run is due: confirmed, not running, and their time come. */
export async function dueDirectories(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id FROM directories
      WHERE kind = 'ldap' AND (syncing_until IS NULL OR syncing_until <= now())
        AND ${dueCondition}
      ORDER BY id`,
  );
  return rows.map((row) => readText(row, "id"));
}

const dueCondition = `(sync_state->>'confirmed')::boolean IS TRUE
  AND coalesce((sync_state->>'startedAt')::timestamptz, '-infinity'::timestamptz)
      <= now() - make_interval(mins => coalesce((settings->>'everyMinutes')::int, ${String(defaultEveryMinutes)}))`;

/** What a run starts with: Sync now, a confirmed preview, Run anyway, or the schedule. */
export interface RunAsked {
  readonly scheduled?: boolean;
  /** An instance admin confirmed the first run's preview: this one applies. */
  readonly confirm?: boolean;
  /** An instance admin looked at a run held back: this one applies it once. */
  readonly anyway?: boolean;
}

/** The runs this node has started, and what starts them. */
export class LdapRuns {
  readonly #services: RunServices;
  readonly #running = new Map<string, Promise<void>>();
  #stopping = false;

  constructor(services: RunServices) {
    this.#services = services;
  }

  /** Whether this node runs a directory now. */
  running(id: string): boolean {
    return this.#running.has(id);
  }

  /**
   * Starts a run of a directory, unless one runs on any node or, for the
   * schedule, its time has not come; gives whether it started. The run
   * goes on after this returns.
   */
  async start(
    id: string,
    asked: RunAsked = {},
    tell?: (tx: Queryable) => Promise<void>,
  ): Promise<boolean> {
    if (this.#stopping) return false;
    const { db } = this.#services;
    const row = await db.transaction(async (tx) => {
      const claimed = await this.#claim(tx, id, asked);
      if (claimed !== undefined && tell !== undefined) await tell(tx);
      return claimed;
    });
    if (row === undefined) return false;
    const run = this.#run(id, row, asked).finally(() => {
      this.#running.delete(id);
    });
    this.#running.set(id, run);
    return true;
  }

  /** Claims a directory's row for a run, unless one runs on any node; gives what the run reads. */
  async #claim(
    tx: Queryable,
    id: string,
    asked: RunAsked,
  ): Promise<Record<string, unknown> | undefined> {
    const { rows } = await tx.query(
      `UPDATE directories
          SET syncing_until = now() + interval '${claimFor}',
              sync_state = sync_state || jsonb_build_object('startedAt', now())
                           || CASE WHEN $2 THEN '{"confirmed": true}'::jsonb ELSE '{}'::jsonb END
        WHERE id = $1 AND kind = 'ldap'
          AND (syncing_until IS NULL OR syncing_until <= now())
          ${asked.scheduled === true ? `AND ${dueCondition}` : ""}
        RETURNING settings, secrets, sync_state`,
      [id, asked.confirm === true],
    );
    return rows[0];
  }

  /** Lets each run this node has started stop between batches, and waits for them. */
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.idle();
  }

  /** Waits for the runs this node has started. */
  async idle(): Promise<void> {
    await Promise.all([...this.#running.values()]);
  }

  async #run(id: string, row: Record<string, unknown>, asked: RunAsked): Promise<void> {
    const { db, events, disconnect, log } = this.#services;
    const started = Date.now();
    const state = syncStateOf(row.sync_state);
    let held = state.held;
    let ended: Omit<RunResult, "at" | "seconds">;
    try {
      const settings = keptSettings(row.settings);
      const directory = await findDirectory(db, id);
      if (settings === undefined || directory === undefined) {
        throw new LdapFailure("This directory's settings are not complete: change them first.");
      }
      const read = await this.#read(id, settings, row.secrets);
      const plan = await planRun(db, id, read);
      const leaving = deactivating(plan);
      const allowed = asked.anyway === true ? new Set(state.held) : new Set<string>();
      const beyond = leaving.filter((user) => !allowed.has(user));
      const shown = read.skipped.slice(0, skippedShown);
      if (!state.confirmed) {
        ended = {
          outcome: "preview",
          counts: plan.counts,
          failure: null,
          skipped: shown,
          preview: previewOf(plan),
        };
      } else if (holdsBack(beyond.length, plan.active, settings.holdPercent)) {
        held = leaving;
        ended = {
          outcome: "held",
          counts: plan.counts,
          failure: null,
          skipped: shown,
          preview: previewOf(plan),
        };
      } else {
        const applied = await applyPlan(
          { db, events, directory, disconnect, stopped: () => this.#stopping },
          plan,
        );
        held = [];
        ended = {
          outcome: "applied",
          counts: applied.counts,
          failure: null,
          skipped: [...read.skipped, ...applied.skipped].slice(0, skippedShown),
          preview: null,
        };
      }
    } catch (error) {
      const known =
        error instanceof LdapFailure ||
        error instanceof SettingRefused ||
        error instanceof SealedElsewhere;
      if (!known) log.error({ err: error, directory: id }, "An LDAP directory's run failed");
      ended = {
        outcome: "failed",
        counts: null,
        failure: known
          ? error.message
          : `The run failed: ${error instanceof Error ? error.message : String(error)}`,
        skipped: [],
        preview: null,
      };
    }
    const result: RunResult = {
      ...ended,
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    await this.#record(id, result, held).catch((error: unknown) => {
      log.error({ err: error, directory: id }, "Could not record an LDAP directory's run");
    });
  }

  /** Opens the bind password, binds, reads everything, and closes the connection. */
  async #read(id: string, settings: LdapSettings, box: unknown): Promise<DirectoryRead> {
    const { config, read } = this.#services;
    const stopped = () => this.#stopping;
    if (config.secretKey === null) {
      throw new LdapFailure("LDAP needs NETHER_SECRET_KEY, which keeps the bind password sealed.");
    }
    if (!(box instanceof Uint8Array)) {
      throw new LdapFailure("This directory has no bind password: set it on the console.");
    }
    const password = sealWith(config.secretKey).open(box, passwordOwner(id, settings));
    if (read !== undefined) return read(settings, password, stopped);
    const connection = await openLdap(settings, password, this.reach());
    try {
      return await readDirectory(connection.client, settings, stopped);
    } finally {
      await connection.close();
    }
  }

  /** Where the server may reach directories. */
  reach() {
    const { config, resolve } = this.#services;
    return { policy: config.ldapPrivate, ...(resolve === undefined ? {} : { resolve }) };
  }

  /** Keeps how a run went, lets its claim go, and tells of it, in one transaction. */
  async #record(id: string, result: RunResult, held: readonly string[]): Promise<void> {
    const { db, events } = this.#services;
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE directories SET syncing_until = NULL,
                sync_state = sync_state || jsonb_build_object('last', $2::jsonb, 'held', $3::jsonb)
          WHERE id = $1 RETURNING name`,
        [id, JSON.stringify(result), JSON.stringify(held)],
      );
      // Removed meanwhile: nothing to keep or tell.
      if (rows[0] === undefined) return;
      const name = readText(rows[0], "name");
      await events.emit(
        tx,
        {
          action: "directory.synced",
          ...(result.outcome === "failed" ? { outcome: "failure" as const, reason: "failed" } : {}),
          actor: { kind: "directory", id, name },
          target: { type: "directory", id, name },
          details: {
            outcome: result.outcome,
            seconds: result.seconds,
            ...(result.counts === null ? {} : { counts: { ...result.counts } }),
            ...(result.failure === null ? {} : { failure: result.failure }),
            ...(result.outcome === "held" ? { holding: held.length } : {}),
          },
        },
        fromServer,
      );
    });
  }
}
