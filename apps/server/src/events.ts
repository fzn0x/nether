// How a session began, in the names the server's events use (ADR 0080,
// ADR 0081): one closed list in core, which the sessions' and tokens'
// `method` columns keep and the audit log records, so a module never
// names a way in core does not know.

/**
 * How a session began: a password, an email code, the environment's
 * OpenID Connect provider, accepting an invitation, first-run setup, or a
 * provider of single sign-on's, whose ID the session keeps beside it.
 */
export const sessionMethods = ["password", "code", "oidc", "invitation", "setup", "sso"] as const;
export type SessionMethod = (typeof sessionMethods)[number];

/** A method as kept, or null for none, or one this server does not know. */
export function sessionMethodOf(text: string | null): SessionMethod | null {
  return text !== null && (sessionMethods as readonly string[]).includes(text)
    ? (text as SessionMethod)
    : null;
}
