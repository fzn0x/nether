// Single sign-on's providers as the console keeps them (ADR 0080): each
// SAML 2.0 or OpenID Connect, by a short name of the admin's, with the
// email domains it is trusted for, one provider at most each, and whether
// accounts at those domains sign in through it alone. Their secrets,
// SAML's key and OpenID Connect's client secret, are sealed with
// NETHER_SECRET_KEY and opened only to sign in.
import {
  type Queryable,
  readBoolean,
  readBytes,
  readText,
  readTime,
} from "@nether/server/src/db.ts";
import type { Seal } from "@nether/server/src/secrets.ts";

/** How a SAML provider is reached and read. */
export interface SamlSettings {
  readonly kind: "saml";
  /** Where its metadata is read again each day; none when it was pasted. */
  readonly metadataUrl: string | null;
  /** Its metadata as last read well. */
  readonly metadata: string;
  /** When it was last read well, as an ISO date. */
  readonly readAt: string;
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly idpCertificates: readonly string[];
  /** Whether a response holding a plain assertion is refused. */
  readonly requireEncryption: boolean;
  /** The attribute that names the person, for a provider whose NameID is transient. */
  readonly subjectAttribute: string | null;
  readonly emailAttribute: string | null;
  readonly nameAttribute: string | null;
  /** Nether's certificate for this provider, in PEM, which it signs requests with and providers encrypt to. */
  readonly certificate: string;
}

/** How an OpenID Connect provider is reached. */
export interface OidcSettings {
  readonly kind: "oidc";
  readonly issuer: string;
  readonly clientId: string;
}

export type Settings = SamlSettings | OidcSettings;
export type Kind = Settings["kind"];

/** What is kept sealed. */
export interface Secrets {
  /** SAML: Nether's private key for this provider, in PEM. */
  readonly privateKey?: string;
  /** OpenID Connect: the client's secret; none for a public client. */
  readonly clientSecret?: string | null;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly makeAccounts: boolean;
  /** Whether accounts at its domains sign in through it alone (ADR 0080). */
  readonly required: boolean;
  readonly domains: readonly string[];
  readonly settings: Settings;
  readonly updatedAt: Date;
}

/** A provider's short name: lowercase letters, digits and hyphens, as its addresses carry it. */
export const providerIdPattern = "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$";

const domainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const domainPattern = new RegExp(`^(?=.{1,253}$)(?:${domainLabel}\\.)+${domainLabel}$`);

/** An email domain as kept: trimmed and lowercase, or undefined when it is not one. */
export function domainOf(text: string): string | undefined {
  const domain = text.trim().toLowerCase().replace(/^@/, "");
  return domainPattern.test(domain) ? domain : undefined;
}

/** The domain of an address, lowercase. */
export function addressDomain(email: string): string {
  return (email.split("@").at(-1) ?? "").trim().toLowerCase();
}

/** What a seal binds a provider's secrets to. */
const owner = (id: string) => `sso:${id}`;

export function sealSecrets(seal: Seal, id: string, secrets: Secrets): Buffer {
  return Buffer.from(seal.seal(JSON.stringify(secrets), owner(id)));
}

export function openSecrets(seal: Seal, id: string, box: Uint8Array): Secrets {
  return JSON.parse(seal.open(box, owner(id))) as Secrets;
}

const columns = "id, name, make_accounts, required, settings, updated_at";

async function domainsOf(db: Queryable, ids: readonly string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.query(
    "SELECT domain, provider_id FROM sso_domains WHERE provider_id = ANY($1) ORDER BY domain",
    [ids],
  );
  const domains = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const row of rows) domains.get(readText(row, "provider_id"))?.push(readText(row, "domain"));
  return domains;
}

function providerOf(row: Record<string, unknown>, domains: readonly string[]): Provider {
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    makeAccounts: readBoolean(row, "make_accounts"),
    required: readBoolean(row, "required"),
    domains,
    settings: row.settings as Settings,
    updatedAt: readTime(row, "updated_at"),
  };
}

/** Every provider, by name. */
export async function listProviders(db: Queryable): Promise<Provider[]> {
  const { rows } = await db.query(`SELECT ${columns} FROM sso_providers ORDER BY name, id`);
  const domains = await domainsOf(
    db,
    rows.map((row) => readText(row, "id")),
  );
  return rows.map((row) => providerOf(row, domains.get(readText(row, "id")) ?? []));
}

/** A provider by its short name. */
export async function findProvider(db: Queryable, id: string): Promise<Provider | undefined> {
  const { rows } = await db.query(`SELECT ${columns} FROM sso_providers WHERE id = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return undefined;
  return providerOf(row, (await domainsOf(db, [id])).get(id) ?? []);
}

/** A provider's sealed secrets. */
export async function secretsBox(db: Queryable, id: string): Promise<Uint8Array | undefined> {
  const { rows } = await db.query("SELECT secrets FROM sso_providers WHERE id = $1", [id]);
  return rows[0] === undefined ? undefined : readBytes(rows[0], "secrets");
}

/** The provider a domain belongs to, if any. */
export async function domainOwner(db: Queryable, domain: string): Promise<string | undefined> {
  const { rows } = await db.query("SELECT provider_id FROM sso_domains WHERE domain = $1", [
    domain,
  ]);
  return rows[0] === undefined ? undefined : readText(rows[0], "provider_id");
}

/** The first of `domains` another provider has, with that provider, if any. */
export async function takenDomain(
  db: Queryable,
  id: string,
  domains: readonly string[],
): Promise<{ readonly domain: string; readonly provider: string } | undefined> {
  const { rows } = await db.query(
    `SELECT domain, provider_id FROM sso_domains
      WHERE domain = ANY($1) AND provider_id <> $2 ORDER BY domain LIMIT 1`,
    [domains, id],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { domain: readText(row, "domain"), provider: readText(row, "provider_id") };
}

/** Sets a provider's domains to exactly these. */
export async function setDomains(
  db: Queryable,
  id: string,
  domains: readonly string[],
): Promise<void> {
  await db.query("DELETE FROM sso_domains WHERE provider_id = $1", [id]);
  if (domains.length > 0) {
    await db.query("INSERT INTO sso_domains (domain, provider_id) SELECT unnest($1::text[]), $2", [
      domains,
      id,
    ]);
  }
}

/** Keeps a new provider, its secrets sealed. */
export async function insertProvider(
  db: Queryable,
  provider: Omit<Provider, "updatedAt">,
  box: Buffer,
): Promise<void> {
  await db.query(
    `INSERT INTO sso_providers (id, kind, name, make_accounts, required, settings, secrets)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      provider.id,
      provider.settings.kind,
      provider.name,
      provider.makeAccounts,
      provider.required,
      JSON.stringify(provider.settings),
      box,
    ],
  );
  await setDomains(db, provider.id, provider.domains);
}

/** Changes a provider; its secrets too when a new box is given. */
export async function updateProvider(
  db: Queryable,
  provider: Omit<Provider, "updatedAt">,
  box: Buffer | undefined,
): Promise<void> {
  await db.query(
    `UPDATE sso_providers
        SET name = $2, make_accounts = $3, required = $6, settings = $4,
            secrets = coalesce($5, secrets), updated_at = now()
      WHERE id = $1`,
    [
      provider.id,
      provider.name,
      provider.makeAccounts,
      JSON.stringify(provider.settings),
      box ?? null,
      provider.required,
    ],
  );
  await setDomains(db, provider.id, provider.domains);
}
