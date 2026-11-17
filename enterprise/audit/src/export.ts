// Sending the audit log to a SIEM (ADR 0081). The log is the queue: each
// destination keeps the last event it took, and a node sends it the next
// ones in order, up to 100 a time, claiming it with FOR UPDATE SKIP LOCKED
// so one node at a time sends to it. A try that fails waits 30 seconds,
// then a minute, 2, 5, 10, and every 15 minutes while it fails, and the
// server's log says so every hour; a destination is never turned off on
// its own. Nothing is lost but what retention purges, which the purge
// records as `audit.export_gap`.
import { hostname } from "node:os";
import type { Database } from "@nether/server/src/db.ts";
import { type Resolver, post, signature } from "@nether/server/src/outbound.ts";
import type { Seal } from "@nether/server/src/secrets.ts";
import type { EnterpriseModule } from "@nether/server/src/enterprise.ts";
import {
  type Destination,
  type PinnedDestination,
  destinationOf,
  secretOwner,
} from "./destinations.ts";
import { type AuditRow, rowOf } from "./log.ts";
import { shownEvent } from "./search.ts";
import { type ClientCertificate, SyslogConnection, syslogAddress, syslogFrame } from "./syslog.ts";

/** The server's log, as a module's app has it. */
type Log = Parameters<EnterpriseModule["plugin"]>[0]["log"];

/** The most events a batch holds. */
export const batchSize = 100;

/** Seconds a failed try waits, by how many failed in a row; the last repeats. */
export const backoff: readonly number[] = [30, 60, 120, 300, 600, 900];

/** How long a node holds its claim on a destination while it sends. */
const claimFor = 120;

/** How long a syslog connection is kept open with nothing to send. */
const idleFor = 60_000;

/** An event as a SIEM receives it: what the console shows, and the chain's hashes. */
export function exportedEvent(row: AuditRow) {
  return { ...shownEvent(row), prevHash: row.prevHash, hash: row.hash };
}

/** The wait after `failures` tries in a row failed, in seconds. */
export function waitAfter(failures: number): number {
  return backoff[Math.min(Math.max(failures, 1), backoff.length) - 1] ?? 900;
}

export interface Sender {
  /** Sends a batch, in order; rejects saying why when it is not taken. */
  send(destination: Destination, events: readonly AuditRow[]): Promise<void>;
  close(): void;
}

export interface SenderOptions {
  readonly seal: Seal | undefined;
  readonly pinned: readonly PinnedDestination[];
  readonly client: ClientCertificate | undefined;
  /** The host a syslog message names: NETHER_PUBLIC_URL's, or the machine's. */
  readonly host: string;
  readonly version: string;
  readonly resolve?: Resolver;
  /** How long a webhook may take to answer, in milliseconds; 10 seconds. */
  readonly timeout?: number;
}

/** The host a syslog message names. */
export function syslogHost(publicUrl: string | null): string {
  if (publicUrl !== null) {
    try {
      return new URL(publicUrl).hostname;
    } catch {
      // The machine's, below.
    }
  }
  return hostname();
}

/** Sends batches by syslog or webhook, keeping a syslog connection open between batches. */
export function newSender(options: SenderOptions): Sender {
  const connections = new Map<string, { connection: SyslogConnection; timer: NodeJS.Timeout }>();

  function forget(id: string) {
    const kept = connections.get(id);
    if (kept === undefined) return;
    clearTimeout(kept.timer);
    kept.connection.close();
    connections.delete(id);
  }

  async function syslog(destination: Destination, events: readonly AuditRow[]) {
    const kept = connections.get(destination.id);
    let connection = kept?.connection;
    if (!connection?.open) {
      forget(destination.id);
      connection = await SyslogConnection.open(
        syslogAddress(destination.address),
        destination.settings,
        options.client,
      );
    } else if (kept !== undefined) {
      clearTimeout(kept.timer);
    }
    const timer = setTimeout(() => {
      forget(destination.id);
    }, idleFor);
    timer.unref();
    connections.set(destination.id, { connection, timer });
    const frames = events.map((row) =>
      syslogFrame(
        {
          at: row.at,
          action: row.action,
          outcome: row.outcome,
          json: JSON.stringify(exportedEvent(row)),
        },
        options.host,
        options.version,
      ),
    );
    try {
      await connection.write(frames);
    } catch (error) {
      // Sent again in full on a new connection.
      forget(destination.id);
      throw error;
    }
  }

  async function webhook(destination: Destination, events: readonly AuditRow[]) {
    // A sealed secret that does not open throws, saying so.
    const secret =
      destination.pinnedBy === null
        ? destination.secret === null || options.seal === undefined
          ? undefined
          : options.seal.open(destination.secret, secretOwner(destination.id))
        : (options.pinned.find((pin) => pin.pinnedBy === destination.pinnedBy)?.secret ??
          undefined);
    if (secret === undefined) {
      throw new Error("This webhook's secret is kept sealed: set NETHER_SECRET_KEY to send to it.");
    }
    const first = events[0]?.seq ?? 0;
    const last = events.at(-1)?.seq ?? 0;
    const id = `${destination.id}:${String(first)}-${String(last)}`;
    const now = new Date();
    const timestamp = Math.floor(now.getTime() / 1000);
    const body = JSON.stringify({
      type: "audit.events",
      timestamp: now.toISOString(),
      data: { events: events.map(exportedEvent) },
    });
    const outcome = await post(
      destination.address,
      {
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature(secret, id, timestamp, body),
      },
      body,
      {
        // A SIEM is the instance admin's own, often on the server's network.
        policy: true,
        timeout: options.timeout ?? 10_000,
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      },
    );
    if (!outcome.ok) throw new Error(outcome.error);
  }

  return {
    send: (destination, events) =>
      destination.kind === "syslog" ? syslog(destination, events) : webhook(destination, events),
    close() {
      for (const id of [...connections.keys()]) forget(id);
    },
  };
}

/**
 * Sends the next batch to one destination that is due and that no other
 * node is sending to; gives whether it sent one, failed to, or found none
 * due. Run again at once while it finds one: there may be more.
 */
export async function sendNext(
  db: Database,
  sender: Sender,
  log: Log,
): Promise<"sent" | "failed" | "idle"> {
  const claimed = await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id FROM audit_destinations
        WHERE next_try_at <= now()
          AND (claimed_until IS NULL OR claimed_until < now())
          AND cursor < (SELECT coalesce(max(seq), 0) FROM audit_events)
        ORDER BY next_try_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const found = rows[0];
    if (found === undefined) return undefined;
    const { rows: updated } = await tx.query(
      `UPDATE audit_destinations SET claimed_until = now() + make_interval(secs => $2)
        WHERE id = $1 RETURNING *`,
      [found.id, claimFor],
    );
    return updated[0] === undefined ? undefined : destinationOf(updated[0]);
  });
  if (claimed === undefined) return "idle";
  const { rows } = await db.query(
    "SELECT * FROM audit_events WHERE seq > $1 ORDER BY seq LIMIT $2",
    [claimed.cursor, batchSize],
  );
  const events = rows.map(rowOf);
  const last = events.at(-1);
  if (last === undefined) {
    await db.query("UPDATE audit_destinations SET claimed_until = NULL WHERE id = $1", [
      claimed.id,
    ]);
    return "idle";
  }
  try {
    await sender.send(claimed, events);
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const failures = claimed.failures + 1;
    const { rows: warned } = await db.query(
      `UPDATE audit_destinations
          SET failures = $2, last_error = $3, failed_at = now(), claimed_until = NULL,
              next_try_at = now() + make_interval(secs => $4),
              warned_at = CASE WHEN warned_at IS NULL OR warned_at < now() - interval '1 hour'
                               THEN now() ELSE warned_at END
        WHERE id = $1
        RETURNING warned_at = now() AS warn`,
      [claimed.id, failures, why, waitAfter(failures)],
    );
    // Once an hour while it fails.
    if (warned[0]?.warn === true) {
      log.error(
        { destination: claimed.id, name: claimed.name, kind: claimed.kind, failures, error: why },
        "Could not send the audit log to a destination; it waits in the log and is tried again",
      );
    }
    return "failed";
  }
  await db.query(
    `UPDATE audit_destinations
        SET cursor = greatest(cursor, $2), delivered_at = now(), failures = 0, last_error = NULL,
            claimed_until = NULL, next_try_at = now(), warned_at = NULL
      WHERE id = $1`,
    [claimed.id, last.seq],
  );
  return "sent";
}

/** Sends to every destination that is due, until none has more; gives how many batches went. */
export async function sendDue(db: Database, sender: Sender, log: Log): Promise<number> {
  let sent = 0;
  for (;;) {
    const done = await sendNext(db, sender, log);
    if (done === "idle") return sent;
    if (done === "sent") sent++;
  }
}
