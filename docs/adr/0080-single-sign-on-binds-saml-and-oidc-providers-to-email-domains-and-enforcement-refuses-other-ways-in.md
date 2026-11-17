# 0080. Single sign-on binds SAML and OIDC providers to email domains, and enforcement refuses other ways in

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask for "SSO: SAML 2.0 and enforced OIDC login; tested against Keycloak,
Okta, Microsoft Entra ID", an enterprise feature: free, open source, and
off until an admin switches it on
([ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)).
It is the `sso` module in `enterprise/sso`: a Fastify plugin given the
database, its switch, and a check that answers 404 while it is off.

What it has to live with:

- **Signing in today.** People sign in with a password
  ([ADR 0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)),
  a code by email
  ([ADR 0033](0033-sign-in-by-email-with-a-code-and-the-link-with-the-web-app.md)),
  or one OpenID Connect provider that the environment names
  ([ADR 0034](0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md)).
  ADR 0034's flow already serves apps that are not browsers: the app gets
  a one-minute code at its loopback address and redeems it with its PKCE
  verifier. It links an identity to an account by an address the provider
  says it has verified. Making accounts there is off unless the admin turns
  it on.
- **Sessions and tokens.** Every request is checked through one lookup,
  `sessionAccount`, including sync's sockets. Personal access tokens
  ([ADR 0059](0059-the-public-api-takes-tokens-that-act-as-their-account-and-gives-notes-as-markdown.md))
  are made from a session and act as its account. Neither records how its
  session began.
- **SAML is XML signatures.** Its known attacks are signature wrapping,
  where the signed part and the part read differ; replaying a captured
  response; unsolicited responses; and clocks that disagree. A library has
  to get these right, and both npm candidates have had critical advisories.
- **The three providers.** Entra ID signs only the assertion by default,
  and its `email` claim is "not guaranteed to be correct, and is mutable".
  Its ID tokens carry no `email_verified`, so ADR 0034's linking finds no
  verified address. Okta and Keycloak each have a switch for signing the
  assertion, and each can require the app's requests to be signed.
- **Air-gapped installs.** Phase 5's gate runs one with single sign-on on.
  A provider's metadata may have to be pasted, not fetched.

## Decision

### The SAML library: `@node-saml/node-saml` 5.2

| | `@node-saml/node-saml` 5.2.0 | `samlify` 2.15.1 |
| --- | --- | --- |
| License | MIT; every package it installs is MIT or BlueOak-1.0.0 | MIT; `xml-escape`'s license field is not SPDX, so the scan needs a reviewed entry |
| Maintenance | Two maintainers in the node-saml organization, which also keeps passport-saml; 5.1.0 on 2025-07-21, 5.2.0 on 2026-10-26 | One maintainer, with contributors; 2.13.0 to 2.15.1 between May and October 2026 |
| Advisories | Two critical, a signature bypass and an authentication bypass, fixed in 5.1.0 (GHSA-4mxg-3p6v-xgq3, GHSA-m837-g268-mmv7) | A critical signature wrapping, fixed in 2.10.0 (GHSA-r683-v43c-6xqv); an XML injection in attribute values, fixed in 2.13.0 (GHSA-34r5-q4jw-r36m) |
| Size | 9.4 MB installed, most of it type packages and `xml2js`; server only | 7.7 MB with `node-xmllint`, a 4.7 MB build of libxml2 |
| Schema validation | None needed | Required: Java, the `xmllint` program, `node-xmllint`, or a validator that skips it |
| IdP metadata | Not read: the module reads it | Read |

Both are past their advisories, and both stand on `xml-crypto` 6.4 and
`@xmldom/xmldom`, past their 2025 and 2026 advisories. `node-saml` wins
on three counts:

- **Its checks are stated.** It processes only the bytes a signature
  covers. It refuses ambiguity: more than one assertion, issuer or
  signature on an element; an ID that resolves twice; a reference to
  anything but its parent. It decrypts, then verifies.
- **It needs no schema validator.** samlify's choices are a second
  runtime, a native program, a large build of libxml2, or skipping the
  check.
- **Its replay and request checks are atomic** on a store of our own.

What it lacks is small. The module reads a provider's metadata itself,
with `@xmldom/xmldom` and `xpath`, which `node-saml` installs already.
They become the module's direct dependencies, pinned to the versions
`node-saml` uses. It reads only:
- the entity ID;
- the address for the Redirect binding;
- the signing certificates.

### How SAML is checked

- **Only sign-ins the server started.** The module asks for sign-in with
  an `AuthnRequest` over the Redirect binding, signed with RSA-SHA256. The
  answer comes back to the provider's own address, its Assertion Consumer
  Service, over the POST binding.
  - `validateInResponseTo` is `always`, so an unsolicited response is
    refused. Each request ID lasts as long as a flow does, ten minutes.
  - The guide has each provider's app tile open Nether's sign-in for that
    provider. A tile then starts a sign-in the server asked for.
- **A response counts once.** `rejectReplayedAssertions` is on. Request
  and assertion IDs are kept in PostgreSQL, through a cache provider of
  the module's, so any node can finish a flow another began. Each key
  starts with the provider's ID.
  - `consumeAsync` is `DELETE ... RETURNING`.
  - `saveIfAbsentAsync` is `INSERT ... ON CONFLICT DO NOTHING`.
- **The assertion must be signed.** The `Response` may also be signed,
  and need not be, since Entra ID signs only the assertion by default.
  The issuer must be the metadata's entity ID. The audience must be this
  provider's entity ID at Nether.
- **It must be for this address.** The library checks `Recipient` and
  `Destination` only from its next major. Until then, the module checks
  the `Recipient` itself. The profile's `getAssertionXml()` gives the
  assertion as its signature verified it, so a bearer
  `SubjectConfirmationData` in it must name the provider's Assertion
  Consumer Service. Its `InResponseTo`, its audience and an address of
  its own for each provider bind it too.
- **Clocks may differ by two minutes** (`acceptedClockSkewMs`).
- **Encrypted assertions.** The server makes a key pair and a self-signed
  certificate for each SAML provider, valid for ten years. node:crypto
  signs it; a small DER writer of the module's builds it; and
  `X509Certificate` checks it, so no certificate library is added.
  - The metadata Nether publishes for the provider offers the certificate
    for signing and for encryption.
  - Encrypted assertions are decrypted, then verified.
  - A provider set to require encryption refuses a response holding a
    plain `Assertion`.
- **The provider decides how people sign in.** Requests ask for no NameID
  format and no authentication context. The provider's own policy, such as
  MFA or passkeys, applies, and a request never fails for asking for a
  password.
- **Who it is.**
  - The subject is the NameID, or an attribute the admin names, such as
    Entra ID's object ID. A transient NameID with no such attribute is
    refused.
  - The address comes from a named attribute, from the common names, or
    from a NameID that is an address.
  - The name comes from `displayName`, or from the given and family names.

### The providers, and their domains

The module keeps a list of providers, each SAML 2.0 or OpenID Connect,
set on the console's **Single sign-on** page. Each has:
- a name, for the apps' button;
- the email domains it is trusted for;
- whether it makes accounts.

A domain belongs to at most one provider. There can be several providers:
- an organization moving from one identity provider to another runs both
  for a while;
- contractors may sign in through a provider of their own;
- a server hosted for several organizations gives each its own.

**Defining a provider.**
- **A SAML provider** comes from its metadata: an address, read again
  every day and when the admin asks, keeping the last copy that read well;
  or XML pasted on the page, for air-gapped installs. The page shows what
  to give the provider: Nether's entity ID, its Assertion Consumer Service
  address and its metadata address, all under
  `NETHER_PUBLIC_URL/api/sso/<id>/saml/`.
- **An OIDC provider** comes from its issuer and its client's ID and
  secret, as in ADR 0034, with its callback at
  `NETHER_PUBLIC_URL/api/sso/<id>/oidc/callback`. An issuer that serves
  several tenants is refused, as Entra ID's `common`, `organizations` and
  `consumers` do, since any of their tenants could claim an address.
- **The environment's provider** (ADR 0034) shows in the list as set by
  the environment. The page can give it domains like any other.

**Reaching a provider.** The module reaches providers the console names
under the outbound rules
([ADR 0060](0060-webhooks-tell-of-notes-made-changed-and-removed-signed-and-sent-to-public-addresses.md)):
public addresses only, unless `NETHER_SSO_PRIVATE` names the private
networks they may be on, as `NETHER_AI_PRIVATE` does for AI providers.
`openid-client` takes that fetch as its `customFetch`.

**Secrets.** OIDC client secrets and the SAML keys are sealed with
`NETHER_SECRET_KEY`, bound to the provider's ID, as the web app's AI keys
are
([ADR 0070](0070-the-web-apps-ai-goes-through-its-server-which-seals-the-keys-and-reaches-only-what-it-may.md)).
The page needs that key set, and says so when it is not.

### Signing in, as the apps do it

The apps meet the module as they meet ADR 0034's flow:
1. The app asks for a flow, with its loopback or web address and a PKCE
   challenge.
2. It opens the provider in the browser.
3. The browser comes back with a one-minute code, which the app redeems
   with its verifier for a session.

The SAML request carries the flow's state as its `RelayState`. The flow
is found in the database, not by a cookie, so the provider's cross-site
POST needs none.

The apps ask the module what to offer:
- `GET /api/sso` lists the providers by name, and answers 404 while the
  feature is off.
- `POST /api/sso/find`, given an address, names its domain's provider and
  says whether it is required. That is known by the domain alone, so it
  tells nothing of accounts.

The sign-in screens ask for the address first. They go straight to the
provider when its domain has one, and offer the providers' buttons
otherwise.

### Accounts

A provider's sign-in finds its account in this order:
1. **By identity**: the issuer, or the SAML entity ID, with the subject.
   This uses the server's `identities`, as ADR 0034 does.
2. **By address.**
   - An address at one of the provider's domains is taken as verified,
     since the admin bound those domains to that provider.
   - An address outside them links only as ADR 0034 links: an OIDC
     provider's verified address. From SAML, never.
   So a provider's tenant cannot sign in to an account at a domain it was
   not given. Entra ID's addresses link though it sends no
   `email_verified`.
3. **Made just in time**, when the provider makes accounts and the address
   is at one of its domains. Making accounts is on by default for a new
   provider: whoever the provider lets use the app may sign in. Such an
   account has no password and no workspace until invited. Elsewhere,
   accounts come by invitation only, as ADR 0034 has them.

A later sign-in does not change an account's address; provisioning
(SCIM) will.

### Enforcement

**What can be required.**
- **A provider's domains**: accounts at those domains sign in only
  through it.
- **Everyone**: every account signs in through a provider. An account at
  no provider's domain may use any provider it is linked to.

**Exemptions.** Instance admins are exempt unless the page covers them
too.

**What a covered account cannot do.**
- Sign in with a password or an email code.
- Accept an invitation by setting a password.
- Use a provider that is not its domain's.
- Set a password.

When it proves itself again, as for revoking sessions or making a token,
a sign-in through its provider in the last ten minutes counts. A password
does not.

**How refusals answer, telling nothing of accounts.**
- **For a required domain**, the refusal comes before any account is
  looked up. It names the provider, so the app can go there.
- **Under everyone**:
  - a password for a covered account answers as a wrong password does,
    so it cannot be used to test passwords;
  - email codes go only to exempt accounts, with the same answer for
    every address;
  - the apps offer the password and the code only behind **Sign in as an
    instance admin**.

**Existing sessions and tokens.** Each session and token records how its
session began: a password, an email code, setup, an invitation, the
environment's provider, or a provider of the module's, by its ID.
- A covered account's session or token that began another way ends at
  its next request. It is deleted, not paused, so turning enforcement off
  revives nothing.
- When the page saves enforcement, those sessions end at once, and the
  accounts' sync connections close. Their apps connect again and are
  checked anew.
- Sessions that came through the right provider go on.

**How a session began, in core's words.** The methods are core's one
exported type:
- `password`, `code`, `oidc`, `invitation` and `setup`, the names the
  audit log's `session.signed_in` events use;
- `sso`, with the provider's ID beside it, for a provider of the
  module's.

Sessions and tokens keep the method in a `method` column and the
provider's ID in a column of its own. Audit records the same names.

**What the server gives the module for this.** These are extension
points on `EnterpriseContext`, so core still depends on nothing in
`enterprise/`:
- a guard, asked before an account is looked up by its address, when a
  session starts, and when one is used;
- the session's start and the handoff, for its flows;
- the accounts' sync connections, to close.

A refusal goes back through core's session start, which answers and
tells the server's events of it, with the method and the reason. Audit
records it as a failed sign-in.

The guard costs no query on each request. It reads the module's settings,
kept for five seconds, as the switches are.

### A way in when the provider breaks

- **Instance admins.** Exempt by default, they keep their passwords and
  email codes and can sign in to fix the provider. The page warns when no
  instance admin has either.
- **The environment.** `NETHER_SSO_ENFORCE=off` pins enforcement off with
  a restart: sign-in through the providers goes on, and every other way
  comes back. It is the way in for an admin who covered instance admins
  too. `NETHER_ENTERPRISE_SSO=off` (ADR 0079) turns the whole module off.

### Where it lives

- **Code**: in `enterprise/sso`.
- **The console's page**: the module adds it, in the web app's console.
- **Tables**: in core's migrations, as `instance_settings` is:
  - the providers and their domains;
  - the flows;
  - the kept request and assertion IDs.

  Every image has every module (ADR 0079), so every server has the same
  schema, whether the feature is on or off. A restore runs core's
  migrations to the backup's version, then fills each table the backup
  names, so these tables exist when it does.
- **Core's changes**:
  - the sessions' and tokens' `method` and provider columns;
  - `oidc.ts`'s flow, made to serve any provider, so the environment's
    and the module's share it.

### Testing

- **Unit tests in `enterprise/sso`.**
  - Reading metadata: Keycloak's, and Okta's and Entra ID's as their
    documentation shows them. Entra ID's has several signing
    certificates.
  - The SAML checks, on responses shaped as each provider sends them and
    signed with test keys: Entra ID's claim names and assertion-only
    signature; Okta's unspecified NameID; Keycloak's signed documents.
  - Each attack refused: a wrapped assertion; two assertions; a response
    with no request; one replayed; one expired or early beyond the skew;
    a wrong audience or issuer; one for another provider's address; a
    plain assertion where encryption is required.
  - Decrypting AES-GCM with RSA-OAEP.
  - The certificate the DER writer makes, read back by `X509Certificate`
    with its key, subject and dates.
  - Linking and refusals, by domain.
  - Every enforcement rule: refusals, sessions and tokens ended,
    exemptions, and `NETHER_SSO_ENFORCE`.
- **Keycloak in CI.**
  - A job starts Keycloak 26.8 in Docker with `start-dev --import-realm`.
    The image needs that command, which a service container cannot pass.
  - The realm holds a SAML client, an OIDC client and two people. The
    SAML client signs its assertions and encrypts them to Nether's
    certificate, so the DER writer's output is checked by a real
    provider.
  - The web app's Playwright tests sign in through Keycloak's own page:
    - by SAML, making an account just in time;
    - by OIDC, through a console provider;
    - with a domain required: refusing a password and ending a password
      session;
    - as an exempt instance admin, still with a password.
  - Locally they run when a Keycloak address is set, and skip otherwise.
- **Okta and Entra ID.** We have no accounts there, so they are tested by
  their documented metadata and by responses and ID tokens shaped as
  theirs. A follow-up issue asks the maintainer to check both live, with
  the guide's steps.

### Parts

1. **Providers and sign-in**:
   - the module, its tables and the console's page;
   - SAML providers, and OIDC providers from the console;
   - accounts;
   - the apps' sign-in;
   - Keycloak in CI.
2. **Enforcement**:
   - the guard and the sessions' and tokens' `method`;
   - the refusals and exemptions;
   - `NETHER_SSO_ENFORCE`;
   - the address-first sign-in screens;
   - the Okta and Entra ID fixtures.

## Alternatives

- **samlify.** It reads metadata itself, and now checks `InResponseTo`
  and replays. Its schema validator is a second runtime, a native program
  or a large WebAssembly build of libxml2, and skipping it removes a
  check.
- **Accepting IdP-initiated sign-in.** An unsolicited response can be
  replayed until it expires, and logs a person in to an account they did
  not ask for. App tiles that start Nether's own sign-in give the same
  click.
- **Requiring a signed `Response` too.** That is safer by a margin, but
  Entra ID's default would fail, and the assertion's own signature covers
  what Nether reads.
- **One provider only.** A move between identity providers, or a server
  for several organizations, would need a second.
- **Providers set in the environment.** Metadata, certificates and domain
  lists fit poorly in variables, and every node would need them. The
  console keeps them in the database once. The environment keeps what a
  host must control: the break-glass pin, the private networks, and ADR
  0034's provider.
- **Linking by any address the provider sends.** Some tenants can set any
  address, so a provider could sign in to accounts at domains it does not
  own. Binding trust to domains closes that.
- **Ending sessions by deleting them once, when enforcement is turned
  on.** A switch turned on in the console, or an account that moves to a
  covered domain, would be missed. The check on use catches every case.
- **No exemption, with recovery from the host only.** It is safer against
  a stolen admin password, and is one setting away. As a default, a
  broken provider would lock out everyone who could fix it.
- **An X.509 library, or certificates the admin makes with openssl.** A
  dependency, or a step most admins would get wrong, for one fixed
  structure.
- **Migrations of the module's own.** They would keep its tables in
  `enterprise/sso`. A restore, though, runs core's migrations alone, then
  fills every table the backup names, so it would fail on a server whose
  modules made tables. The audit log's `audit_events` is in core's list
  for the same reason (ADR 0081).

## Consequences

- **What the admin does.** They register each provider with Nether's
  addresses and certificate, give it domains, and require it when ready.
  The apps then send people at those domains straight to it.
- **Keycloak.** Its client needs **Sign assertions** on. The guide says
  so for each provider, with the attributes to send.
- **Single logout is not part of this.** Signing out of a provider leaves
  Nether's sessions until they end. Deprovisioning by SCIM, the next
  items, ends them.
- **Certificates.** A provider's certificate rotates on the page. The new
  one is published beside the old before it is used, as `node-saml`'s
  certificate list allows.
- **Upgrades.** When `node-saml`'s next major checks `Recipient` and
  `Destination`, the upgrade turns them on. Its README lists what else it
  tightens.
- **Refusals are the server's events.** The audit log records each
  refusal as a failed sign-in with its reason, under the same method
  names as the sign-ins it records.
- **Two `EnterpriseContext` changes meet.** This one adds the guard, the
  session start and `disconnect`; audit adds `events`. Whichever merges
  second rebases onto the other's fields.
