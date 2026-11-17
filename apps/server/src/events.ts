// What the server tells of as it happens (ADR 0081): every sign-in and its
// failures, permission change, share, export and deletion, as an event an
// enterprise module listens to, as audit logs do. The names are core's, a
// closed list, so a route cannot tell of one that does not exist, and core
// never imports a module. A change is told inside the transaction that
// makes it, as its last statement, and its listeners write with that
// transaction: a change is never recorded without happening, nor kept
// without its record. With no listener, telling costs one empty call.
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Queryable } from "./db.ts";

/** How a session began; the sessions' own `method` keeps the same values. */
export const sessionMethods = ["password", "code", "oidc", "invitation", "setup"] as const;
export type SessionMethod = (typeof sessionMethods)[number];

/** Every event the server tells of, by its name: each fits syslog's MSGID, 32 characters. */
export const serverActions = [
  // Sign-ins and their failures.
  "session.signed_in",
  "session.signed_out",
  "session.revoked",
  "account.created",
  "account.password_changed",
  "share_link.opened",
  // Permission changes.
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.left",
  "member.key_granted",
  "grant.set",
  "grant.removed",
  "teamspace.created",
  "teamspace.changed",
  "teamspace.deleted",
  "page.shared",
  "page.changed",
  "page.unshared",
  "private_space.created",
  "note.unit_changed",
  "workspace.created",
  "workspace.changed",
  "token.created",
  "instance.feature_changed",
  // Shares.
  "share_link.created",
  "share_link.revoked",
  "site.published",
  "site.changed",
  "site.unpublished",
  "site.domain_set",
  "site.domain_removed",
  "workspace.publishing_changed",
  "invitation.created",
  "invitation.revoked",
  "invitation.accepted",
  "webhook.created",
  "webhook.changed",
  "webhook.deleted",
  "webhook.secret_changed",
  // Exports.
  "note.read_by_api",
  "database.read_by_api",
  "search.read_by_api",
  "export.made",
  "backup.made",
  // Deletions.
  "note.deleted",
  "workspace.deleted",
  "account.deleted",
  "token.revoked",
] as const;
export type ServerAction = (typeof serverActions)[number];

/**
 * Who did it: an account, through an API token when it used one; a share
 * link's visitor; someone not signed in, by the email they typed when they
 * typed one; or the server itself. A listener reads an account's name and
 * email as they are when it records.
 */
export type EventActor =
  | {
      readonly kind: "account";
      readonly id: string;
      readonly token?: { readonly id: string; readonly name: string };
    }
  | { readonly kind: "visitor"; readonly link: string; readonly name: string | null }
  | { readonly kind: "anonymous"; readonly email?: string }
  | { readonly kind: "system" };

/** What an event acted on: a member, a unit, a link, a site, a token or a note. */
export interface EventTarget {
  readonly type: string;
  readonly id: string;
  /** Its name, where the server can read one: never what a note says. */
  readonly name?: string | null;
}

/** A value an event's details hold: IDs, names, levels and counts, never contents. */
export type EventValue =
  string | number | boolean | null | readonly EventValue[] | { readonly [key: string]: EventValue };

/** What else tells an event: a role from and to, a level, a format. */
export type EventDetails = Readonly<Record<string, EventValue>>;

export interface ServerEvent {
  readonly action: ServerAction;
  /** A success unless said; a failure is an attempt refused, with why. */
  readonly outcome?: "success" | "failure";
  /** Why an attempt was refused, in a few words: never what was typed but an email. */
  readonly reason?: string;
  readonly actor: EventActor;
  /** The workspace it happened in, by its ID. */
  readonly workspace?: string | null;
  readonly target?: EventTarget;
  readonly details?: EventDetails;
}

/** Where a request came from: its address, as NETHER_TRUST_PROXY reads it, and its client. */
export interface EventOrigin {
  readonly address: string | null;
  readonly userAgent: string | null;
}

/** A request's origin. */
export function originOf(request: FastifyRequest): EventOrigin {
  const agent = request.headers["user-agent"];
  return {
    address: request.ip === "" ? null : request.ip,
    userAgent: agent === undefined || agent === "" ? null : agent.slice(0, 200),
  };
}

/** Where the server's own events come from: no request at all. */
export const fromServer: EventOrigin = { address: null, userAgent: null };

/** An account as an event's actor, through the token it used, if it used one. */
export function accountActor(
  id: string,
  token?: { readonly id: string; readonly name: string } | null,
): EventActor {
  return token === undefined || token === null
    ? { kind: "account", id }
    : { kind: "account", id, token };
}

/** What a module runs for each event, with the transaction its change is in. */
export type EventListener = (
  event: ServerEvent,
  origin: EventOrigin,
  db: Queryable,
) => Promise<void>;

/** The server's events, which routes tell of and modules listen to. */
export class ServerEvents {
  readonly #listeners = new Set<EventListener>();

  /** Runs `listener` for each event; returns what stops it. */
  listen(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Tells of a change, in the transaction that makes it: a listener that
   * fails rejects, so the change rolls back rather than go unrecorded.
   */
  async emit(db: Queryable, event: ServerEvent, origin: EventOrigin): Promise<void> {
    for (const listener of this.#listeners) await listener(event, origin, db);
  }

  /**
   * Tells of an attempt that changed nothing, as a wrong password: the
   * request answers as it would, and a record that fails is logged.
   */
  async attempt(
    db: Queryable,
    event: ServerEvent,
    origin: EventOrigin,
    log: FastifyBaseLogger,
  ): Promise<void> {
    try {
      await this.emit(db, event, origin);
    } catch (error) {
      log.error({ err: error, action: event.action }, "Could not record an event");
    }
  }
}
