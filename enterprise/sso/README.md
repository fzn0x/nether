# Enterprise: Single sign-on

SAML 2.0 and enforced OIDC sign-in, tested against Keycloak, Okta and
Microsoft Entra ID
([ADR 0080](../../docs/adr/0080-single-sign-on-binds-saml-and-oidc-providers-to-email-domains-and-enforcement-refuses-other-ways-in.md)).

- `src/providers.ts`: the providers the console keeps, with their domains,
  their secrets sealed with `NETHER_SECRET_KEY`.
- `src/metadata.ts`: a SAML provider's metadata, read for its entity ID,
  its address and its signing certificates.
- `src/certificate.ts`: the key and self-signed certificate Nether signs
  requests with and providers encrypt to, written in DER.
- `src/saml.ts`: requests and answers, checked by `@node-saml/node-saml`.
- `src/accounts.ts`: the account a sign-in finds or makes.
- `src/signIn.ts`: the apps' flows, handed back as ADR 0034's are.
- `src/enforcement.ts`: what single sign-on requires, the guard the
  server asks at each sign-in and each request.
- `src/console.ts`: the console's Single sign-on page's routes.

Roadmap: Phase 5, enterprise, mobile and scale.
