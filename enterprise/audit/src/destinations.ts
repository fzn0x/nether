// Where the audit log is sent (ADR 0081): up to five destinations an
// instance admin adds in the console, each syslog over TLS or a webhook,
// and one of each the environment may pin, NETHER_AUDIT_SYSLOG and
// NETHER_AUDIT_WEBHOOK, shown in the console with no control. Each keeps
// the last event it took: the log is the queue. A webhook's secret is
// sealed with NETHER_SECRET_KEY, or comes from the environment for the
// pinned one; a client certificate for syslog comes from files, so no key
// of its is ever in the database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Queryable,
  type Row,
  readCount,
  readText,
  readTextOrNull,
} from "@nether/server/src/db.ts";
import { addressProblem, newSecret } from "@nether/server/src/outbound.ts";
import type { Seal } from "@nether/server/src/secrets.ts";
import { fingerprintOf, syslogAddress } from "./syslog.ts";

/** The most destinations an instance admin adds; the environment's are beside them. */
export const maxDestinations = 5;

export type DestinationKind = "syslog" | "webhook";

/** How a syslog destination's server is trusted, as kept: the system's authorities unless one is given. */
export interface DestinationSettings {
  readonly ca?: string;
  readonly fingerprint?: string;
}

export interface Destination {
  readonly id: string;
  readonly kind: DestinationKind;
  readonly name: string;
  readonly address: string;
  readonly settings: DestinationSettings;
  /** The sealed secret of a webhook the console added. */
  readonly secret: Uint8Array | null;
  readonly pinnedBy: string | null;
  readonly cursor: number;
  readonly deliveredAt: Date | null;
  readonly failures: number;
  readonly lastError: string | null;
  readonly failedAt: Date | null;
  readonly warnedAt: Date | null;
  readonly nextTryAt: Date;
}

function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | number | Date);
}

export function destinationOf(row: Row): Destination {
  const settings =
    typeof row.settings === "object" && row.settings !== null
      ? (row.settings as DestinationSettings)
      : {};
  return {
    id: readText(row, "id"),
    kind: readText(row, "kind") === "syslog" ? "syslog" : "webhook",
    name: readText(row, "name"),
    address: readText(row, "address"),
    settings,
    secret: row.secret instanceof Uint8Array ? row.secret : null,
    pinnedBy: readTextOrNull(row, "pinned_by"),
    cursor: readCount(row, "cursor"),
    deliveredAt: dateOrNull(row.delivered_at),
    failures: readCount(row, "failures"),
    lastError: readTextOrNull(row, "last_error"),
    failedAt: dateOrNull(row.failed_at),
    warnedAt: dateOrNull(row.warned_at),
    nextTryAt: dateOrNull(row.next_try_at) ?? new Date(0),
  };
}

/** What sealing a webhook's secret binds it to, so a box moved to another row does not open. */
export function secretOwner(id: string): string {
  return `audit-destination:${id}`;
}

/** An address as an event records it: a webhook's by its origin alone, as its path may hold a secret. */
export function recordedAddress(kind: DestinationKind, address: string): string {
  if (kind === "syslog") return address;
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
}

/** Why an address cannot be a destination of `kind`, or undefined when it can. */
export function destinationProblem(kind: DestinationKind, address: string): string | undefined {
  if (kind === "syslog") {
    try {
      syslogAddress(address);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  // A SIEM is often on the server's own network: private addresses are allowed.
  return addressProblem(address, true);
}

/** The place a new destination starts from: after the newest event, or before the oldest kept. */
export async function startingCursor(db: Queryable, from: "newest" | "oldest"): Promise<number> {
  const { rows } = await db.query(
    from === "newest"
      ? "SELECT coalesce(max(seq), 0) AS seq FROM audit_events"
      : "SELECT coalesce(min(seq) - 1, 0) AS seq FROM audit_events",
  );
  return readCount(rows[0], "seq");
}

/** The destinations, the environment's first, then the console's in the order they were added. */
export async function listDestinations(db: Queryable): Promise<Destination[]> {
  const { rows } = await db.query(
    "SELECT * FROM audit_destinations ORDER BY pinned_by IS NULL, created_at, id",
  );
  return rows.map(destinationOf);
}

/** How many events wait for each destination, by its ID. */
export async function waiting(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query(
    `SELECT d.id, (SELECT count(*) FROM audit_events e WHERE e.seq > d.cursor) AS waiting
       FROM audit_destinations d`,
  );
  return new Map(rows.map((row) => [readText(row, "id"), readCount(row, "waiting")]));
}

/** A destination as the console shows it: never its secret. */
export function shownDestination(destination: Destination, waitingCount: number) {
  return {
    id: destination.id,
    kind: destination.kind,
    name: destination.name,
    address: destination.address,
    ca: destination.settings.ca !== undefined,
    fingerprint: destination.settings.fingerprint ?? null,
    pinnedBy: destination.pinnedBy,
    deliveredAt: destination.deliveredAt?.toISOString() ?? null,
    waiting: waitingCount,
    failures: destination.failures,
    lastError: destination.lastError,
    failedAt: destination.failedAt?.toISOString() ?? null,
    nextTryAt: destination.failures === 0 ? null : destination.nextTryAt.toISOString(),
  };
}

/** What adding a destination asks for. */
export interface NewDestination {
  readonly kind: DestinationKind;
  readonly name: string;
  readonly address: string;
  readonly ca?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly from: "newest" | "oldest";
}

/** Syslog's trust as kept: a fingerprint, normalized, or a certificate authority. */
export function settingsOf(given: {
  readonly ca?: string | undefined;
  readonly fingerprint?: string | undefined;
}): DestinationSettings {
  const ca = given.ca?.trim() ?? "";
  const fingerprint = given.fingerprint?.trim() ?? "";
  if (ca !== "" && fingerprint !== "") {
    throw new Error("Trust a certificate authority or pin a fingerprint, not both.");
  }
  if (fingerprint !== "") return { fingerprint: fingerprintOf(fingerprint) };
  if (ca !== "") {
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("A certificate authority is a certificate in PEM.");
    }
    return { ca };
  }
  return {};
}

/** Adds a console destination, in `tx`; gives it, and a webhook's secret, which is shown once. */
export async function addDestination(
  tx: Queryable,
  given: NewDestination,
  seal: Seal | undefined,
): Promise<{ readonly destination: Destination; readonly secret: string | null }> {
  const id = randomUUID();
  const settings = given.kind === "syslog" ? settingsOf(given) : {};
  let secret: string | null = null;
  let box: Uint8Array | null = null;
  if (given.kind === "webhook") {
    if (seal === undefined) {
      throw new Error("Set NETHER_SECRET_KEY first: it keeps a webhook's secret.");
    }
    secret = newSecret();
    box = seal.seal(secret, secretOwner(id));
  }
  const { rows } = await tx.query(
    `INSERT INTO audit_destinations (id, kind, name, address, settings, secret, cursor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      id,
      given.kind,
      given.name,
      given.address.trim(),
      JSON.stringify(settings),
      box,
      await startingCursor(tx, given.from),
    ],
  );
  return { destination: destinationOf(rows[0] ?? {}), secret };
}

/** A destination the environment pins: its address, its trust, and a webhook's secret. */
export interface PinnedDestination {
  readonly kind: DestinationKind;
  readonly pinnedBy: "NETHER_AUDIT_SYSLOG" | "NETHER_AUDIT_WEBHOOK";
  readonly address: string;
  readonly settings: DestinationSettings;
  /** A webhook's secret, from NETHER_AUDIT_WEBHOOK_SECRET; never kept in the database. */
  readonly secret: string | null;
}

/**
 * The destinations the environment pins: NETHER_AUDIT_SYSLOG, a host and
 * port, trusted by NETHER_AUDIT_SYSLOG_CA, a file, or
 * NETHER_AUDIT_SYSLOG_FINGERPRINT; and NETHER_AUDIT_WEBHOOK, an address,
 * signed with NETHER_AUDIT_WEBHOOK_SECRET. One set wrong stops the server.
 */
export function pinnedDestinations(env: NodeJS.ProcessEnv): PinnedDestination[] {
  const pinned: PinnedDestination[] = [];
  const syslog = env.NETHER_AUDIT_SYSLOG?.trim() ?? "";
  if (syslog !== "") {
    const problem = destinationProblem("syslog", syslog);
    if (problem !== undefined) throw new Error(`NETHER_AUDIT_SYSLOG: ${problem}`);
    const caFile = env.NETHER_AUDIT_SYSLOG_CA?.trim() ?? "";
    const settings = settingsOf({
      ca: caFile === "" ? undefined : readFileSync(caFile, "utf8"),
      fingerprint: env.NETHER_AUDIT_SYSLOG_FINGERPRINT,
    });
    pinned.push({
      kind: "syslog",
      pinnedBy: "NETHER_AUDIT_SYSLOG",
      address: syslog,
      settings,
      secret: null,
    });
  }
  const webhook = env.NETHER_AUDIT_WEBHOOK?.trim() ?? "";
  if (webhook !== "") {
    const problem = destinationProblem("webhook", webhook);
    if (problem !== undefined) throw new Error(`NETHER_AUDIT_WEBHOOK: ${problem}`);
    const secret = env.NETHER_AUDIT_WEBHOOK_SECRET?.trim() ?? "";
    if (!/^whsec_[A-Za-z0-9+/]{24,}={0,2}$/.test(secret)) {
      throw new Error(
        "NETHER_AUDIT_WEBHOOK needs NETHER_AUDIT_WEBHOOK_SECRET, a whsec_ secret, as Standard Webhooks has it.",
      );
    }
    pinned.push({
      kind: "webhook",
      pinnedBy: "NETHER_AUDIT_WEBHOOK",
      address: webhook,
      settings: {},
      secret,
    });
  }
  return pinned;
}

/**
 * Keeps the environment's destinations in the table, each with its place:
 * a new one starts after the newest event; one the environment no longer
 * pins goes. Every node does it as it starts; the result is the same.
 */
export async function keepPinned(
  db: Queryable,
  pinned: readonly PinnedDestination[],
): Promise<void> {
  for (const destination of pinned) {
    await db.query(
      `INSERT INTO audit_destinations (id, kind, name, address, settings, pinned_by, cursor)
         VALUES ($1, $2, $3, $4, $5, $3, (SELECT coalesce(max(seq), 0) FROM audit_events))
         ON CONFLICT (pinned_by) DO UPDATE
           SET kind = excluded.kind, address = excluded.address, settings = excluded.settings,
               updated_at = now()`,
      [
        randomUUID(),
        destination.kind,
        destination.pinnedBy,
        destination.address,
        JSON.stringify(destination.settings),
      ],
    );
  }
  await db.query(
    "DELETE FROM audit_destinations WHERE pinned_by IS NOT NULL AND NOT (pinned_by = ANY($1::text[]))",
    [pinned.map((destination) => destination.pinnedBy)],
  );
}
