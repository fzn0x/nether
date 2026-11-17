// What Okta and Microsoft Entra ID send, as their documentation shows it,
// for the tests to sign in with (ADR 0080): we have no tenant of either,
// so their answers are shaped here and signed with test keys. A live check
// against real tenants is the maintainer's, by the admin guide's steps.
import type { Person } from "@nether/server/test/provider.ts";
import type { Bend, IdpPerson } from "./idp.ts";

const unspecified = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
const emailAddress = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Someone a provider signs in. */
export interface Someone {
  /** Who the provider says they are, for good. */
  readonly id: string;
  readonly email: string;
  readonly given: string;
  readonly family: string;
}

/**
 * Okta: a SAML app integration signs the response and the assertion, as
 * its defaults have it; its NameID is the Okta username, an address, in
 * the unspecified format; and the admin's attribute statements send
 * `email`, `firstName` and `lastName`. Its entity ID is
 * `http://www.okta.com/<app ID>`. Its ID tokens, with the `email` scope,
 * say whether the address is verified.
 */
export const okta = {
  entityId: "http://www.okta.com/exk1example",
  bend: { signResponse: true, signAssertion: true } satisfies Bend,
  saml(someone: Someone): IdpPerson {
    return {
      nameId: someone.email,
      format: unspecified,
      attributes: { email: someone.email, firstName: someone.given, lastName: someone.family },
    };
  },
  idToken(someone: Someone): Person {
    return {
      sub: someone.id,
      email: someone.email,
      email_verified: true,
      name: `${someone.given} ${someone.family}`,
      preferred_username: someone.email,
      given_name: someone.given,
      family_name: someone.family,
    };
  },
};

const tenant = "00000000-0000-0000-0000-000000000001";
const claims = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims";
const identity = "http://schemas.microsoft.com/identity/claims";

/**
 * Microsoft Entra ID: an enterprise application signs the assertion
 * alone, as its default has it; its NameID is the user principal name in
 * the email address format; its claims have URIs for names; and who
 * someone is for good is the object ID, which the admin names under
 * Attributes. Its entity ID is `https://sts.windows.net/<tenant>/`. Its v2
 * ID tokens carry no `email_verified`, and `sub` differs by app.
 */
export const entra = {
  tenant,
  entityId: `https://sts.windows.net/${tenant}/`,
  subjectAttribute: `${identity}/objectidentifier`,
  bend: { signResponse: false, signAssertion: true } satisfies Bend,
  saml(someone: Someone): IdpPerson {
    return {
      nameId: someone.email,
      format: emailAddress,
      attributes: {
        [`${identity}/tenantid`]: tenant,
        [`${identity}/objectidentifier`]: someone.id,
        [`${identity}/displayname`]: `${someone.given} ${someone.family}`,
        [`${identity}/identityprovider`]: `https://sts.windows.net/${tenant}/`,
        [`${identity}/authnmethodsreferences`]: [
          "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password",
          "http://schemas.microsoft.com/claims/multipleauthn",
        ],
        [`${claims}/givenname`]: someone.given,
        [`${claims}/surname`]: someone.family,
        [`${claims}/emailaddress`]: someone.email,
        [`${claims}/name`]: someone.email,
      },
    };
  },
  idToken(someone: Someone): Person {
    return {
      sub: `pairwise-${someone.id}`,
      oid: someone.id,
      tid: tenant,
      email: someone.email,
      name: `${someone.given} ${someone.family}`,
      preferred_username: someone.email,
      ver: "2.0",
    };
  },
};
