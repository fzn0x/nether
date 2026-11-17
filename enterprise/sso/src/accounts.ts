// The account a provider's sign-in finds (ADR 0080): by the identity it
// linked before; else by an address the provider is trusted for, at one of
// its domains, or that an OpenID Connect provider says it verified; else
// one made just in time, at its domains, when it makes accounts, or with
// an invitation.
import { randomUUID } from "node:crypto";
import { type Queryable, readText } from "@nether/server/src/db.ts";
import { emailKey } from "@nether/server/src/http.ts";
import { acceptInvitation, invites, openInvitation } from "@nether/server/src/invitations.ts";
import type { Person } from "@nether/server/src/oidc.ts";
import { type Provider, addressDomain } from "./providers.ts";

/** Why a sign-in found no account, as the app reads it from the address it comes back to. */
export type SignInError =
  | "access_denied"
  | "no_account"
  | "email_not_verified"
  | "no_address"
  | "invitation"
  | "other_address"
  | "provider_error"
  /** The account signs in through another provider, as single sign-on requires. */
  | "sso_required";

export type Outcome =
  | { readonly userId: string; readonly workspaceId: string | null }
  | { readonly error: SignInError };

/**
 * The account `person` signs in to through `provider`, whose issuer (or
 * SAML entity ID) is `issuer`, made when it may be, and the invitation
 * they accept with it.
 */
export async function resolveAccount(
  tx: Queryable,
  provider: Provider,
  issuer: string,
  person: Person,
  invitationHash: string | null,
): Promise<Outcome> {
  const invitation = invitationHash === null ? undefined : await openInvitation(tx, invitationHash);
  if (invitationHash !== null && invitation === undefined) return { error: "invitation" };

  const known = await tx.query(
    "SELECT user_id FROM identities WHERE issuer = $1 AND subject = $2",
    [issuer, person.subject],
  );
  let userId = known.rows[0] === undefined ? undefined : readText(known.rows[0], "user_id");
  let email: string | undefined;
  if (userId === undefined) {
    if (person.email === undefined) return { error: "no_address" };
    email = person.email;
    // Its domains are the provider's to vouch for; elsewhere only a
    // verified address links, and SAML has no way to say one is.
    const ours = provider.domains.includes(addressDomain(email));
    if (!ours && !person.emailVerified) return { error: "email_not_verified" };
    const byEmail = await tx.query("SELECT id FROM users WHERE email_key = $1", [emailKey(email)]);
    userId = byEmail.rows[0] === undefined ? undefined : readText(byEmail.rows[0], "id");
    if (userId === undefined) {
      const mayMake = invitation !== undefined || (ours && provider.makeAccounts);
      if (!mayMake) return { error: "no_account" };
      if (invitation !== undefined && !invites(invitation, email)) {
        return { error: "other_address" };
      }
      userId = randomUUID();
      await tx.query("INSERT INTO users (id, email, email_key, name) VALUES ($1, $2, $3, $4)", [
        userId,
        email,
        emailKey(email),
        person.name,
      ]);
    }
    await tx.query("INSERT INTO identities (issuer, subject, user_id) VALUES ($1, $2, $3)", [
      issuer,
      person.subject,
      userId,
    ]);
  }

  if (invitation === undefined) return { userId, workspaceId: null };
  if (email === undefined) {
    const { rows } = await tx.query("SELECT email FROM users WHERE id = $1", [userId]);
    email = readText(rows[0], "email");
  }
  if (!invites(invitation, email)) return { error: "other_address" };
  const workspace = await acceptInvitation(tx, invitation, userId);
  return { userId, workspaceId: workspace.id };
}
