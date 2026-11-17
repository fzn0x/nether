// Signing in through a SAML 2.0 provider (ADR 0080), with node-saml:
// requests signed and sent over the Redirect binding, answers taken over
// the POST binding at the provider's own address, only for requests the
// server made, each counting once, the assertion signed, and for this
// address. What it says of the person is read from the assertion as its
// signature verified it.
import { randomBytes } from "node:crypto";
import {
  type CacheItem,
  type CacheProvider,
  type Profile,
  SAML,
  ValidateInResponseTo,
  generateServiceProviderMetadata,
} from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { type Queryable, readText } from "@nether/server/src/db.ts";
import type { Person } from "@nether/server/src/oidc.ts";
import { flowMinutes } from "@nether/server/src/oidc.ts";
import type { SamlSettings } from "./providers.ts";

/** How far the provider's clock may be from the server's. */
export const clockSkewMs = 120_000;

const assertionNamespace = "urn:oasis:names:tc:SAML:2.0:assertion";
const bearer = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";

/** A provider's addresses at Nether, which its admin gives the provider. */
export function samlAddresses(publicUrl: string, id: string) {
  const base = `${publicUrl}/api/sso/${encodeURIComponent(id)}/saml`;
  return { entityId: `${base}/metadata`, acsUrl: `${base}/acs`, metadataUrl: `${base}/metadata` };
}

/**
 * node-saml's store, in PostgreSQL, so any node can finish a sign-in
 * another began: request IDs until answered, and assertions until they
 * could no longer be accepted. Each key starts with the provider's name,
 * so one provider's answer cannot retire another's request.
 */
export class KeptIds implements CacheProvider {
  readonly #db: Queryable;
  readonly #prefix: string;

  constructor(db: Queryable, providerId: string) {
    this.#db = db;
    this.#prefix = `${providerId}:`;
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.#db.query(
      `INSERT INTO sso_kept (key, value, expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 minute')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      [this.#prefix + key, value, flowMinutes],
    );
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    const { rows } = await this.#db.query(
      "SELECT value FROM sso_kept WHERE key = $1 AND expires_at > now()",
      [this.#prefix + key],
    );
    return rows[0] === undefined ? null : readText(rows[0], "value");
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    return this.consumeAsync(key);
  }

  async consumeAsync(key: string): Promise<string | null> {
    const { rows } = await this.#db.query(
      "DELETE FROM sso_kept WHERE key = $1 AND expires_at > now() RETURNING value",
      [this.#prefix + key],
    );
    return rows[0] === undefined ? null : readText(rows[0], "value");
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    // An expired key is as good as absent.
    const { rows } = await this.#db.query(
      `INSERT INTO sso_kept (key, value, expires_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
         WHERE sso_kept.expires_at <= now()
       RETURNING key`,
      [this.#prefix + key, value, expiresAtMs],
    );
    return rows.length > 0;
  }
}

/** What a SAML provider's sign-in takes beyond its settings. */
export interface SamlContext {
  readonly db: Queryable;
  readonly publicUrl: string;
  readonly id: string;
  readonly settings: SamlSettings;
  /** Nether's private key for this provider, in PEM. */
  readonly privateKey: string;
}

function samlOf(context: SamlContext, requestId?: string): SAML {
  const { entityId, acsUrl } = samlAddresses(context.publicUrl, context.id);
  return new SAML({
    callbackUrl: acsUrl,
    issuer: entityId,
    audience: entityId,
    entryPoint: context.settings.ssoUrl,
    idpIssuer: context.settings.entityId,
    idpCert: [...context.settings.idpCertificates],
    privateKey: context.privateKey,
    publicCert: context.settings.certificate,
    decryptionPvk: context.privateKey,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    // The assertion must be signed; the response may be too.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Only answers to requests this server made, each once.
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: flowMinutes * 60_000,
    rejectReplayedAssertions: true,
    cacheProvider: new KeptIds(context.db, context.id),
    acceptedClockSkewMs: clockSkewMs,
    // The provider's own policy decides how people sign in.
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    ...(requestId === undefined ? {} : { generateUniqueId: () => requestId }),
  });
}

/** A new request's ID: SAML's IDs start with a letter or an underscore. */
export function newRequestId(): string {
  return `_${randomBytes(20).toString("hex")}`;
}

/** The provider's address with a signed request, and the request's ID, which its answer must name. */
export async function startSaml(
  context: SamlContext,
  relayState: string,
): Promise<{ readonly url: string; readonly requestId: string }> {
  const requestId = newRequestId();
  const url = await samlOf(context, requestId).getAuthorizeUrlAsync(relayState, {});
  return { url, requestId };
}

/** Nether's metadata for a provider: its entity ID, its address for answers, and its certificate for signing and for encryption. */
export function serviceMetadata(context: Omit<SamlContext, "db">): string {
  const { entityId, acsUrl } = samlAddresses(context.publicUrl, context.id);
  return generateServiceProviderMetadata({
    issuer: entityId,
    callbackUrl: acsUrl,
    identifierFormat: null,
    wantAssertionsSigned: true,
    decryptionPvk: context.privateKey,
    decryptionCert: context.settings.certificate,
    privateKey: context.privateKey,
    publicCerts: context.settings.certificate,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  });
}

/** An answer refused, saying why, for the log; the app is told only that the provider's answer was refused. */
export class SamlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlRefused";
  }
}

/** Whether a response, as received, holds an assertion not encrypted. */
function hasPlainAssertion(response: string): boolean {
  const xml = Buffer.from(response, "base64").toString("utf8");
  const document = new DOMParser({ errorHandler: () => undefined }).parseFromString(
    xml,
    "text/xml",
  );
  return document.getElementsByTagNameNS(assertionNamespace, "Assertion").length > 0;
}

/** Two addresses that are the same once parsed: case of scheme and host, default ports. */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** A value of an attribute, the first when it has several. */
function attribute(profile: Profile, name: string | null): string | undefined {
  if (name === null) return undefined;
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
  const value = attributes[name];
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : undefined;
}

const emailNames = [
  "email",
  "mail",
  "emailaddress",
  "emailAddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const displayNames = [
  "displayName",
  "displayname",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "urn:oid:2.16.840.1.113730.3.1.241",
];
const givenNames = [
  "givenName",
  "firstName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  "urn:oid:2.5.4.42",
];
const familyNames = [
  "sn",
  "surname",
  "lastName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  "urn:oid:2.5.4.4",
];

const firstOf = (profile: Profile, names: readonly string[]) =>
  names.map((name) => attribute(profile, name)).find((value) => value !== undefined);

/** Who a verified assertion names: its subject, its address and its name. */
export function samlPerson(profile: Profile, settings: SamlSettings): Person {
  const nameId = typeof profile.nameID === "string" ? profile.nameID.trim() : "";
  let subject: string | undefined;
  if (settings.subjectAttribute !== null) {
    subject = attribute(profile, settings.subjectAttribute);
    if (subject === undefined) {
      throw new SamlRefused(`The assertion has no ${settings.subjectAttribute} attribute.`);
    }
  } else {
    if (profile.nameIDFormat === transient) {
      throw new SamlRefused(
        "The assertion's NameID is transient: name an attribute that stays the same for each person.",
      );
    }
    subject = nameId === "" ? undefined : nameId;
    if (subject === undefined) throw new SamlRefused("The assertion has no NameID.");
  }
  const looksLikeAddress = /^[^\s@]+@[^\s@]+$/.test(nameId);
  const email =
    (settings.emailAttribute === null
      ? firstOf(profile, emailNames)
      : attribute(profile, settings.emailAttribute)) ?? (looksLikeAddress ? nameId : undefined);
  const given = firstOf(profile, givenNames);
  const family = firstOf(profile, familyNames);
  const name =
    (settings.nameAttribute === null ? undefined : attribute(profile, settings.nameAttribute)) ??
    firstOf(profile, displayNames) ??
    ([given, family].filter((part) => part !== undefined).join(" ") || undefined) ??
    email?.split("@")[0] ??
    "Nether user";
  return { subject, email, emailVerified: false, name };
}

/**
 * Checks a provider's answer to the request `requestId` and gives whom it
 * names. The assertion must be signed, timely, for this provider's
 * audience, answer this request, and be meant for this address; encrypted,
 * when the provider says so. Anything else is refused, saying why.
 */
export async function finishSaml(
  context: SamlContext,
  form: Readonly<Record<string, string>>,
  requestId: string,
): Promise<Person> {
  const response = form.SAMLResponse ?? "";
  if (response === "") throw new SamlRefused("The answer has no SAMLResponse.");
  if (context.settings.requireEncryption && hasPlainAssertion(response)) {
    throw new SamlRefused("The answer's assertion is not encrypted, which this provider requires.");
  }
  const { profile } = await samlOf(context).validatePostResponseAsync({ SAMLResponse: response });
  if (profile === null) throw new SamlRefused("The answer signs no one in.");
  // The library checks the Recipient from its next major only: the
  // assertion, as its signature verified it, must be meant for this
  // address and answer this request.
  const { acsUrl } = samlAddresses(context.publicUrl, context.id);
  const assertion = (profile.getAssertion?.() ?? {}) as {
    Assertion?: {
      Subject?: {
        SubjectConfirmation?: {
          $?: { Method?: string };
          SubjectConfirmationData?: { $?: { Recipient?: string; InResponseTo?: string } }[];
        }[];
      }[];
    };
  };
  const confirmations = assertion.Assertion?.Subject?.[0]?.SubjectConfirmation ?? [];
  const meant = confirmations.some((confirmation) => {
    const data = confirmation.SubjectConfirmationData?.[0]?.$;
    return (
      confirmation.$?.Method === bearer &&
      data?.Recipient !== undefined &&
      sameUrl(data.Recipient, acsUrl) &&
      data.InResponseTo === requestId
    );
  });
  if (!meant) {
    throw new SamlRefused(
      `The assertion is not for this sign-in: no bearer confirmation names ${acsUrl} and this request.`,
    );
  }
  return samlPerson(profile, context.settings);
}
