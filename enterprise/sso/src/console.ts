// The console's Single sign-on page's routes (ADR 0080), for instance
// admins while the feature is on: the providers, each SAML 2.0 from its
// metadata, by address or pasted, or OpenID Connect from its issuer and
// client; the domains each is trusted for; and what to give each provider.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import type { Database } from "@nether/server/src/db.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail } from "@nether/server/src/http.ts";
import { oidcClient } from "@nether/server/src/oidc.ts";
import { signedIn } from "@nether/server/src/sessions.ts";
import { newServiceKey } from "./certificate.ts";
import { MetadataError, metadataLimit, readIdpMetadata } from "./metadata.ts";
import {
  type OidcSettings,
  type Provider,
  type SamlSettings,
  type Secrets,
  domainOf,
  findProvider,
  insertProvider,
  listProviders,
  openSecrets,
  providerIdPattern,
  sealSecrets,
  secretsBox,
  takenDomain,
  updateProvider,
} from "./providers.ts";
import { samlAddresses } from "./saml.ts";
import { type SignInContext, privateSetting, providerFetch, sealOf } from "./signIn.ts";

interface SamlInput {
  readonly metadataUrl?: string;
  readonly metadataXml?: string;
  readonly requireEncryption?: boolean;
  readonly subjectAttribute?: string | null;
  readonly emailAttribute?: string | null;
  readonly nameAttribute?: string | null;
}

interface OidcInput {
  readonly issuer?: string;
  readonly clientId?: string;
  /** Absent keeps the one kept; null makes a public client. */
  readonly clientSecret?: string | null;
}

interface ProviderInput {
  readonly id: string;
  readonly name?: string;
  readonly domains?: readonly string[];
  readonly makeAccounts?: boolean;
  readonly saml?: SamlInput;
  readonly oidc?: OidcInput;
}

const attributeField = {
  anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }],
} as const;

const samlInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    metadataUrl: { type: "string", minLength: 1, maxLength: 2000 },
    metadataXml: { type: "string", minLength: 1, maxLength: metadataLimit },
    requireEncryption: { type: "boolean" },
    subjectAttribute: attributeField,
    emailAttribute: attributeField,
    nameAttribute: attributeField,
  },
} as const;

const oidcInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    issuer: { type: "string", minLength: 1, maxLength: 2000 },
    clientId: { type: "string", minLength: 1, maxLength: 500 },
    clientSecret: { anyOf: [{ type: "string", minLength: 1, maxLength: 2000 }, { type: "null" }] },
  },
} as const;

const providerProperties = {
  name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
  domains: {
    type: "array",
    maxItems: 100,
    items: { type: "string", minLength: 1, maxLength: 253 },
  },
  makeAccounts: { type: "boolean" },
  saml: samlInput,
  oidc: oidcInput,
} as const;

const newProviderBody = {
  type: "object",
  required: ["id", "name"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: providerIdPattern },
    ...providerProperties,
  },
} as const;

const changeBody = {
  type: "object",
  additionalProperties: false,
  properties: providerProperties,
} as const;

/** A provider's input refused, saying why. */
class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The issuers that sign in several tenants, any of which could claim an address. */
function sharedTenant(issuer: URL): boolean {
  const tenant = issuer.pathname.split("/")[1]?.toLowerCase() ?? "";
  return (
    issuer.hostname.toLowerCase() === "login.microsoftonline.com" &&
    ["common", "organizations", "consumers"].includes(tenant)
  );
}

function domainsOf(input: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const text of input) {
    const domain = domainOf(text);
    if (domain === undefined) throw new Refused(400, `${text} is not an email domain.`);
    domains.add(domain);
  }
  return [...domains];
}

const stringOrNull = (value: string | null | undefined, kept: string | null) =>
  value === undefined ? kept : value === null ? null : value.trim() === "" ? null : value.trim();

export function registerConsole(app: FastifyInstance, context: SignInContext): void {
  const { db, config, whenOn } = context;
  const account = signedIn(db);
  const admins = (what: string) => ({
    preHandler: [whenOn, account, instanceAdmin(what)],
  });
  const seal = sealOf(config);
  const fetchProvider = providerFetch(config);

  /** What the page shows of a provider, and what to give it. */
  async function view(provider: Provider) {
    const base = {
      id: provider.id,
      kind: provider.settings.kind,
      name: provider.name,
      makeAccounts: provider.makeAccounts,
      domains: provider.domains,
    };
    const { settings } = provider;
    const { publicUrl } = config;
    if (settings.kind === "saml") {
      return {
        ...base,
        saml: {
          metadataUrl: settings.metadataUrl,
          readAt: settings.readAt,
          entityId: settings.entityId,
          ssoUrl: settings.ssoUrl,
          requireEncryption: settings.requireEncryption,
          subjectAttribute: settings.subjectAttribute,
          emailAttribute: settings.emailAttribute,
          nameAttribute: settings.nameAttribute,
          nether:
            publicUrl === null
              ? null
              : { ...samlAddresses(publicUrl, provider.id), certificate: settings.certificate },
        },
      };
    }
    let secret = false;
    const box = await secretsBox(db, provider.id);
    if (seal !== undefined && box !== undefined) {
      try {
        secret = typeof openSecrets(seal, provider.id, box).clientSecret === "string";
      } catch {
        secret = true;
      }
    }
    return {
      ...base,
      oidc: {
        issuer: settings.issuer,
        clientId: settings.clientId,
        secret,
        callbackUrl:
          publicUrl === null ? null : `${publicUrl}/api/sso/${provider.id}/oidc/callback`,
      },
    };
  }

  /** A provider's metadata, from its address or as pasted. */
  async function readMetadata(input: SamlInput): Promise<{ xml: string; url: string | null }> {
    if (input.metadataXml !== undefined) return { xml: input.metadataXml, url: null };
    const url = input.metadataUrl?.trim() ?? "";
    if (url === "")
      throw new Refused(400, "Give the provider's metadata: its address, or its XML.");
    return { xml: await fetchMetadata(config, url), url };
  }

  /** A SAML provider's settings from what the page sent, over those kept. */
  async function samlSettings(
    input: SamlInput,
    kept: SamlSettings | undefined,
    id: string,
  ): Promise<{ settings: SamlSettings; secrets: Secrets | undefined }> {
    const reread = input.metadataXml !== undefined || input.metadataUrl !== undefined;
    let read:
      | {
          metadata: string;
          metadataUrl: string | null;
          readAt: string;
          parsed: ReturnType<typeof readIdpMetadata>;
        }
      | undefined;
    if (reread || kept === undefined) {
      const { xml, url } = await readMetadata(input);
      try {
        read = {
          metadata: xml,
          metadataUrl: url,
          readAt: new Date().toISOString(),
          parsed: readIdpMetadata(xml),
        };
      } catch (error) {
        if (error instanceof MetadataError) throw new Refused(400, error.message);
        throw error;
      }
    }
    // A new provider gets a key and a certificate of its own.
    const made = kept === undefined ? newServiceKey(`Nether sign-on ${id}`) : undefined;
    const settings: SamlSettings = {
      kind: "saml",
      metadataUrl: read?.metadataUrl ?? kept?.metadataUrl ?? null,
      metadata: read?.metadata ?? kept?.metadata ?? "",
      readAt: read?.readAt ?? kept?.readAt ?? new Date().toISOString(),
      entityId: read?.parsed.entityId ?? kept?.entityId ?? "",
      ssoUrl: read?.parsed.ssoUrl ?? kept?.ssoUrl ?? "",
      idpCertificates: read?.parsed.certificates ?? kept?.idpCertificates ?? [],
      requireEncryption: input.requireEncryption ?? kept?.requireEncryption ?? false,
      subjectAttribute: stringOrNull(input.subjectAttribute, kept?.subjectAttribute ?? null),
      emailAttribute: stringOrNull(input.emailAttribute, kept?.emailAttribute ?? null),
      nameAttribute: stringOrNull(input.nameAttribute, kept?.nameAttribute ?? null),
      certificate: made?.certificate ?? kept?.certificate ?? "",
    };
    return { settings, secrets: made === undefined ? undefined : { privateKey: made.privateKey } };
  }

  /** An OpenID Connect provider's settings from what the page sent, checked by finding its metadata. */
  async function oidcSettings(
    input: OidcInput,
    kept: OidcSettings | undefined,
    keptSecret: string | null,
  ): Promise<{ settings: OidcSettings; secrets: Secrets | undefined }> {
    const issuer = input.issuer?.trim() ?? kept?.issuer ?? "";
    const clientId = input.clientId?.trim() ?? kept?.clientId ?? "";
    if (issuer === "" || clientId === "") {
      throw new Refused(400, "Give the provider's issuer and its client's ID.");
    }
    let url: URL;
    try {
      url = new URL(issuer);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
    } catch {
      throw new Refused(400, `${issuer} is not an issuer's address.`);
    }
    if (sharedTenant(url)) {
      throw new Refused(
        400,
        "This issuer signs in every tenant, any of which could claim an address: give your own tenant's.",
      );
    }
    const clientSecret = input.clientSecret === undefined ? keptSecret : input.clientSecret;
    // Its metadata found now, so a provider that cannot be reached is not kept.
    try {
      await oidcClient(
        {
          issuer,
          clientId,
          clientSecret,
          callbackUrl: config.publicUrl ?? "",
          fetch: fetchProvider,
        },
        app.log,
      ).start();
    } catch (error) {
      throw new Refused(
        400,
        `${issuer} could not be reached as an OpenID Connect provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      settings: { kind: "oidc", issuer, clientId },
      secrets:
        input.clientSecret === undefined && kept !== undefined ? undefined : { clientSecret },
    };
  }

  /** Answers with what `work` gives, or with its refusal, saying why. */
  async function answer(reply: FastifyReply, status: number, work: () => Promise<unknown>) {
    let body: unknown;
    try {
      body = await work();
    } catch (error) {
      if (error instanceof Refused) return fail(reply, error.status, error.message);
      throw error;
    }
    return reply.code(status).send(body);
  }

  app.get("/api/admin/sso", admins("see single sign-on's providers"), async () => ({
    providers: await Promise.all((await listProviders(db)).map(view)),
    publicUrl: config.publicUrl,
    secretKey: config.secretKey !== null,
    privateSetting,
    environment:
      config.oidc === null ? null : { name: config.oidc.name, issuer: config.oidc.issuer },
  }));

  app.post<{ Body: ProviderInput }>(
    "/api/admin/sso/providers",
    { schema: { body: newProviderBody }, ...admins("add a single sign-on provider") },
    (request, reply) =>
      answer(reply, 201, async () => {
        if (seal === undefined)
          throw new Refused(409, "Set NETHER_SECRET_KEY first: it keeps the providers' secrets.");
        if (config.publicUrl === null)
          throw new Refused(409, "Set NETHER_PUBLIC_URL first: providers send people back to it.");
        const { body } = request;
        if ((body.saml === undefined) === (body.oidc === undefined)) {
          throw new Refused(400, "A provider is SAML or OpenID Connect: give one of the two.");
        }
        if ((await findProvider(db, body.id)) !== undefined) {
          throw new Refused(409, `There is a provider named ${body.id} already.`);
        }
        const domains = domainsOf(body.domains ?? []);
        const taken = await takenDomain(db, body.id, domains);
        if (taken !== undefined) {
          throw new Refused(409, `${taken.domain} is ${taken.provider}'s already.`);
        }
        const made =
          body.saml !== undefined
            ? await samlSettings(body.saml, undefined, body.id)
            : await oidcSettings(body.oidc ?? {}, undefined, null);
        await db.transaction(async (tx) => {
          await insertProvider(
            tx,
            {
              id: body.id,
              name: (body.name ?? body.id).trim(),
              makeAccounts: body.makeAccounts ?? true,
              domains,
              settings: made.settings,
            },
            sealSecrets(seal, body.id, made.secrets ?? {}),
          );
        });
        const kept = await findProvider(db, body.id);
        if (kept === undefined) throw new Refused(404, "There is no such provider.");
        return view(kept);
      }),
  );

  app.put<{ Params: { id: string }; Body: Omit<ProviderInput, "id"> }>(
    "/api/admin/sso/providers/:id",
    { schema: { body: changeBody }, ...admins("change a single sign-on provider") },
    (request, reply) =>
      answer(reply, 200, async () => {
        if (seal === undefined)
          throw new Refused(409, "Set NETHER_SECRET_KEY first: it keeps the providers' secrets.");
        const kept = await findProvider(db, request.params.id);
        if (kept === undefined) throw new Refused(404, "There is no such provider.");
        const { body } = request;
        const { settings } = kept;
        if (
          (settings.kind === "saml" && body.oidc !== undefined) ||
          (settings.kind === "oidc" && body.saml !== undefined)
        ) {
          throw new Refused(400, "A provider's kind does not change: add another.");
        }
        const domains = body.domains === undefined ? [...kept.domains] : domainsOf(body.domains);
        const taken = await takenDomain(db, kept.id, domains);
        if (taken !== undefined) {
          throw new Refused(409, `${taken.domain} is ${taken.provider}'s already.`);
        }
        let changed: { settings: SamlSettings | OidcSettings; secrets: Secrets | undefined };
        if (settings.kind === "saml") {
          changed = await samlSettings(body.saml ?? {}, settings, kept.id);
        } else {
          const box = await secretsBox(db, kept.id);
          const keptSecret =
            box === undefined ? null : (openSecrets(seal, kept.id, box).clientSecret ?? null);
          changed = await oidcSettings(body.oidc ?? {}, settings, keptSecret);
        }
        await db.transaction(async (tx) => {
          await updateProvider(
            tx,
            {
              id: kept.id,
              name: body.name?.trim() ?? kept.name,
              makeAccounts: body.makeAccounts ?? kept.makeAccounts,
              domains,
              settings: changed.settings,
            },
            changed.secrets === undefined ? undefined : sealSecrets(seal, kept.id, changed.secrets),
          );
        });
        const now = await findProvider(db, kept.id);
        if (now === undefined) throw new Refused(404, "There is no such provider.");
        return view(now);
      }),
  );

  // Reads a SAML provider's metadata again from its address, as each day does.
  app.post<{ Params: { id: string } }>(
    "/api/admin/sso/providers/:id/metadata",
    admins("read a provider's metadata again"),
    (request, reply) =>
      answer(reply, 200, async () => {
        const kept = await findProvider(db, request.params.id);
        if (kept?.settings.kind !== "saml") {
          throw new Refused(404, "There is no such SAML provider.");
        }
        if (kept.settings.metadataUrl === null) {
          throw new Refused(409, "This provider's metadata was pasted: paste it again.");
        }
        return view(await refreshMetadata(db, config, kept, kept.settings));
      }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/sso/providers/:id",
    admins("remove a single sign-on provider"),
    async (request, reply) => {
      const { rows } = await db.query("DELETE FROM sso_providers WHERE id = $1 RETURNING id", [
        request.params.id,
      ]);
      if (rows.length === 0) return fail(reply, 404, "There is no such provider.");
      return reply.code(204).send();
    },
  );
}

/** A provider's metadata from its address, under the outbound rules. */
async function fetchMetadata(config: Config, url: string): Promise<string> {
  let answer: Response;
  try {
    answer = await providerFetch(config)(url, {
      headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" },
    });
  } catch (error) {
    throw new Refused(
      400,
      `The metadata could not be read from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (answer.status !== 200) {
    throw new Refused(400, `The metadata's address answered ${String(answer.status)}.`);
  }
  return answer.text();
}

/** Reads a SAML provider's metadata again from its address, keeping it if it reads, and gives the provider as it is then. */
export async function refreshMetadata(
  db: Database,
  config: Config,
  provider: Provider,
  settings: SamlSettings,
): Promise<Provider> {
  if (settings.metadataUrl === null) return provider;
  const xml = await fetchMetadata(config, settings.metadataUrl);
  let parsed;
  try {
    parsed = readIdpMetadata(xml);
  } catch (error) {
    if (error instanceof MetadataError) throw new Refused(400, error.message);
    throw error;
  }
  const next: SamlSettings = {
    ...settings,
    metadata: xml,
    readAt: new Date().toISOString(),
    entityId: parsed.entityId,
    ssoUrl: parsed.ssoUrl,
    idpCertificates: parsed.certificates,
  };
  await db.query("UPDATE sso_providers SET settings = $2, updated_at = now() WHERE id = $1", [
    provider.id,
    JSON.stringify(next),
  ]);
  return (await findProvider(db, provider.id)) ?? provider;
}
