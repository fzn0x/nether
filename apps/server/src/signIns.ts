// The guards that may refuse a sign-in (ADR 0080). Each session and token
// keeps how its session began; an enterprise module, as single sign-on
// is, adds a guard that the server asks before it looks an account up by
// its address, when a session starts, and each time one is used, so a
// session begun a way its account may no longer use ends at its next
// request. Core never imports a module: a module adds its guard to the
// services it is given, which are these.
import type { Database, Queryable } from "./db.ts";
import type { SessionMethod } from "./events.ts";

/** Who would sign in, and how. */
export interface SignInAttempt {
  readonly userId: string;
  readonly email: string;
  readonly instanceAdmin: boolean;
  /** How the session began; null for one begun before sessions kept it. */
  readonly method: SessionMethod | null;
  /** The provider of single sign-on's it came through, for `sso`; null otherwise. */
  readonly provider: string | null;
}

/** A provider an address must sign in with, by its short name and its name. */
export interface RequiredProvider {
  readonly id: string;
  readonly name: string;
}

/** Why a sign-in is refused, for the log and the server's events: never shown as it is. */
export interface Refusal {
  readonly reason: string;
}

/** What a module adds to say no. */
export interface SignInGuard {
  /**
   * The provider an address must sign in through, if any, known by its
   * domain alone, so saying so tells nothing of accounts.
   */
  requiredFor(email: string): Promise<RequiredProvider | undefined>;
  /**
   * Whether an account may have a session begun this way: when it starts,
   * and each time it is used. What it reads, it reads through `db`, the
   * transaction a session starts in, if it starts in one.
   */
  check(attempt: SignInAttempt, db: Queryable): Promise<Refusal | undefined>;
}

/** A sign-in a guard refused, as `startSession` throws it. */
export class SignInRefused extends Error {
  override readonly name = "SignInRefused";
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.reason);
    this.refusal = refusal;
  }
}

/** Every guard a server has, asked in turn; with none, every sign-in is let through. */
export class SignInGuards {
  readonly #guards = new Set<SignInGuard>();

  /** Adds a guard, and gives what takes it away again, as a module does when its server closes. */
  add(guard: SignInGuard): () => void {
    this.#guards.add(guard);
    return () => {
      this.#guards.delete(guard);
    };
  }

  async requiredFor(email: string): Promise<RequiredProvider | undefined> {
    for (const guard of this.#guards) {
      const required = await guard.requiredFor(email);
      if (required !== undefined) return required;
    }
    return undefined;
  }

  async check(attempt: SignInAttempt, db: Queryable): Promise<Refusal | undefined> {
    for (const guard of this.#guards) {
      const refusal = await guard.check(attempt, db);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }
}

const byDatabase = new WeakMap<Database, SignInGuards>();

/**
 * A server's guards, by its database: every place that reads a session
 * has the database to hand, and nodes of one server share it.
 */
export function signInGuards(db: Database): SignInGuards {
  let guards = byDatabase.get(db);
  if (guards === undefined) {
    guards = new SignInGuards();
    byDatabase.set(db, guards);
  }
  return guards;
}
