// Accounts that sign in no more (ADR 0085). A directory that provisions
// accounts deactivates one it no longer lists, and reactivates it when it
// does again; core enforces it whether that feature is on or off, so
// turning the feature off never brings an account back. A deactivated
// account signs in no way: `startSession` refuses it, so every way in does,
// and its sessions, email codes and API tokens go in the transaction that
// deactivates it. It keeps its memberships, roles, grants, sealed keys and
// private spaces, so it comes back as it was. It does not count as a
// workspace's owner, gets no mail, and waits for no key. The server's last
// active instance admin is never deactivated, so its console keeps a way in.
import { type Queryable, readBoolean, readText } from "./db.ts";
import type { EventActor, EventOrigin, ServerEvents, SessionMethod } from "./events.ts";

/** Who deactivates or reactivates an account, as its events name them: a directory, at first. */
export interface AccountChanger {
  readonly actor: EventActor;
  readonly origin: EventOrigin;
}

/**
 * What deactivating or reactivating came to: changed, already so, or
 * refused, with its status and why. When it changed, the caller closes the
 * account's connections once its transaction commits.
 */
export type AccountOutcome = "changed" | "same" | readonly [status: 403 | 404, message: string];

export const noAccount = "There is no such account.";

export const lastInstanceAdmin =
  "This is the server's last active instance admin, who keeps a way into its console: it is not deactivated.";

/** What a sign-in through a provider answers for a deactivated account, which it then knows. */
export const deactivatedMessage =
  "This account is deactivated: ask your organization's admin to turn it back on.";

/** A sign-in refused because its account is deactivated, as `startSession` throws it, with how it came. */
export class AccountDeactivated extends Error {
  override readonly name = "AccountDeactivated";
  readonly userId: string;
  readonly method: SessionMethod;
  /** The provider of single sign-on's it came through, for `sso`. */
  readonly provider: string | undefined;

  constructor(userId: string, method: SessionMethod, provider?: string) {
    super(deactivatedMessage);
    this.userId = userId;
    this.method = method;
    this.provider = provider;
  }
}

/** Whether an account is deactivated; false for one there is not. */
export async function isDeactivated(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = $1",
    [userId],
  );
  return rows[0] !== undefined && readBoolean(rows[0], "deactivated");
}

/**
 * Deactivates an account, in the caller's transaction: it signs in no way
 * from then on, and its sessions, email codes and API tokens go now. The
 * server's last active instance admin is refused, with 403. The account's
 * rows and every active instance admin's are locked, in the order of their
 * IDs, so two deactivations cannot leave the server none.
 */
export async function deactivateAccount(
  tx: Queryable,
  userId: string,
  by: AccountChanger,
  events: ServerEvents,
): Promise<AccountOutcome> {
  const { rows } = await tx.query(
    `SELECT id, instance_admin, deactivated_at IS NOT NULL AS deactivated FROM users
      WHERE id = $1 OR (instance_admin AND deactivated_at IS NULL)
      ORDER BY id FOR UPDATE`,
    [userId],
  );
  const account = rows.find((row) => readText(row, "id") === userId);
  if (account === undefined) return [404, noAccount];
  if (readBoolean(account, "deactivated")) return "same";
  if (readBoolean(account, "instance_admin")) {
    const others = rows.filter(
      (row) =>
        readText(row, "id") !== userId &&
        readBoolean(row, "instance_admin") &&
        !readBoolean(row, "deactivated"),
    );
    if (others.length === 0) return [403, lastInstanceAdmin];
  }
  await tx.query("UPDATE users SET deactivated_at = now() WHERE id = $1", [userId]);
  const sessions = await tx.query("DELETE FROM sessions WHERE user_id = $1 RETURNING id", [userId]);
  await tx.query("DELETE FROM sign_in_codes WHERE user_id = $1", [userId]);
  const tokens = await tx.query("DELETE FROM api_tokens WHERE user_id = $1 RETURNING id", [userId]);
  await events.emit(
    tx,
    {
      action: "account.deactivated",
      actor: by.actor,
      target: { type: "account", id: userId },
      details: {
        sessions: sessions.rows.length,
        tokens: tokens.rows.map((row) => readText(row, "id")),
      },
    },
    by.origin,
  );
  return "changed";
}

/**
 * Reactivates a deactivated account, in the caller's transaction: it signs
 * in again, to all it kept. Nothing else changes, since nothing else did.
 */
export async function reactivateAccount(
  tx: Queryable,
  userId: string,
  by: AccountChanger,
  events: ServerEvents,
): Promise<AccountOutcome> {
  const { rows } = await tx.query(
    "SELECT deactivated_at IS NOT NULL AS deactivated FROM users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  const account = rows[0];
  if (account === undefined) return [404, noAccount];
  if (!readBoolean(account, "deactivated")) return "same";
  await tx.query("UPDATE users SET deactivated_at = NULL WHERE id = $1", [userId]);
  await events.emit(
    tx,
    {
      action: "account.reactivated",
      actor: by.actor,
      target: { type: "account", id: userId },
    },
    by.origin,
  );
  return "changed";
}
