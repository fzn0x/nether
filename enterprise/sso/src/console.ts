// The console's Single sign-on page's routes (ADR 0080), for instance
// admins while the feature is on: the providers, each SAML 2.0 from its
// metadata, by address or pasted, or OpenID Connect from its issuer and
// client; the domains each is trusted for; what to give each provider; and
// what single sign-on requires, which ends the sessions it refuses as soon
// as it is saved.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import type { Database, Queryable } from "@nether/server/src/db.ts";
import { type EventValue, accountActor, originOf } from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail } from "@nether/server/src/http.ts";
import { oidcClient } from "@nether/server/src/oidc.ts";
import { type Account, accountOf, signedIn } from "@nether/server/src/sessions.ts";
import type { SecuritySettings } from "@nether/server/src/settings.ts";
import { newServiceKey } from "./certificate.ts";
import { readRules, readSettings, refusalOf, saveSettings } from "./enforcement.ts";
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
  readonly required?: boolean;
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
  required: { type: "boolean" },
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

/** What the page's routes share beside the sign-in's. */
export interface ConsoleContext extends SignInContext {
  /** Closes an account's sync connections, as a session it had ends. */
  readonly disconnect: (userId: string) => void;
  /** Whether email codes sign in, for the warning when no instance admin has a way in. */
  readonly security: SecuritySettings;
}

interface EnforcementInput {
  readonly everyone?: boolean;
  readonly admins?: boolean;
}

const enforcementBody = {
  type: "object",
  additionalProperties: false,
  properties: { everyone: { type: "boolean" }, admins: { type: "boolean" } },
} as const;

const ownSession =
  "Saving this would end your own session, which did not begin through the provider it requires: sign in through it first.";

export function registerConsole(app: FastifyInstance, context: ConsoleContext): void {
  const { db, config, whenOn, enforcement, disconnect, security, events } = context;
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
      required: provider.required,
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

  /**
   * Refuses a change, in the transaction that makes it, that would end the
   * session of the admin making it: they sign in through the provider first.
   */
  async function keepsOwnSession(tx: Queryable, me: Account): Promise<void> {
    if (enforcement.pinnedOff) return;
    const refused = refusalOf(await readRules(tx), {
      userId: me.id,
      email: me.email,
      instanceAdmin: me.instanceAdmin,
      method: me.method,
      provider: me.provider,
    });
    if (refused !== undefined) throw new Refused(409, ownSession);
  }

  /** What single sign-on requires, and whether instance admins keep a way in of their own. */
  async function enforcementView() {
    const settings = await readSettings(db);
    const { rows } = await db.query(
      "SELECT 1 FROM users WHERE instance_admin AND password_hash IS NOT NULL LIMIT 1",
    );
    const codes = config.mail !== null && (await security.values()).emailCodes;
    return {
      ...settings,
      pinnedBy: enforcement.pinnedOff ? "NETHER_SSO_ENFORCE" : null,
      adminWayIn: rows.length > 0 || codes,
    };
  }

  app.get("/api/admin/sso", admins("see single sign-on's providers"), async () => ({
    providers: await Promise.all((await listProviders(db)).map(view)),
    publicUrl: config.publicUrl,
    secretKey: config.secretKey !== null,
    privateSetting,
    environment:
      config.oidc === null ? null : { name: config.oidc.name, issuer: config.oidc.issuer },
    enforcement: await enforcementView(),
  }));

  // What single sign-on requires beside each provider's own switch: every
  // account, and instance admins too. The sessions and tokens it refuses
  // end as it is saved.
  app.put<{ Body: EnforcementInput }>(
    "/api/admin/sso/enforcement",
    { schema: { body: enforcementBody }, ...admins("set what single sign-on requires") },
    (request, reply) =>
      answer(reply, 200, async () => {
        if (enforcement.pinnedOff) {
          throw new Refused(409, "NETHER_SSO_ENFORCE=off pins enforcement off: unset it first.");
        }
        const { body } = request;
        if (body.everyone === true && config.oidc === null) {
          const { rows } = await db.query("SELECT 1 FROM sso_providers LIMIT 1");
          if (rows.length === 0) {
            throw new Refused(409, "Add a provider first: with none, no one could sign in.");
          }
        }
        await db.transaction(async (tx) => {
          const before = await readSettings(tx);
          await saveSettings(tx, body);
          await keepsOwnSession(tx, accountOf(request));
          const after = await readSettings(tx);
          if (before.everyone === after.everyone && before.admins === after.admins) return;
          // Recorded, as who must sign in through a provider changes (ADR 0081).
          await events.emit(
            tx,
            {
              action: "sso.enforcement_changed",
              actor: accountActor(accountOf(request).id),
              details: { from: { ...before }, to: { ...after } },
            },
            originOf(request),
          );
        });
        const ended = await enforcement.sweep(disconnect);
        return { ...(await enforcementView()), ended };
      }),
  );

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
              required: body.required ?? false,
              domains,
              settings: made.settings,
            },
            sealSecrets(seal, body.id, made.secrets ?? {}),
          );
          await keepsOwnSession(tx, accountOf(request));
          await events.emit(
            tx,
            {
              action: "sso.provider_added",
              actor: accountActor(accountOf(request).id),
              target: { type: "sso_provider", id: body.id, name: (body.name ?? body.id).trim() },
              details: {
                kind: made.settings.kind,
                domains,
                makeAccounts: body.makeAccounts ?? true,
                required: body.required ?? false,
              },
            },
            originOf(request),
          );
        });
        await enforcement.sweep(disconnect);
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
              required: body.required ?? kept.required,
              domains,
              settings: changed.settings,
            },
            changed.secrets === undefined ? undefined : sealSecrets(seal, kept.id, changed.secrets),
          );
          await keepsOwnSession(tx, accountOf(request));
          // What changed of what the page shows, from and to; never a secret.
          const name = body.name?.trim() ?? kept.name;
          const makeAccounts = body.makeAccounts ?? kept.makeAccounts;
          const required = body.required ?? kept.required;
          const details: Record<string, EventValue> = { kind: settings.kind };
          if (name !== kept.name) details.name = { from: kept.name, to: name };
          if (JSON.stringify(domains) !== JSON.stringify(kept.domains)) {
            details.domains = { from: [...kept.domains], to: [...domains] };
          }
          if (makeAccounts !== kept.makeAccounts) {
            details.makeAccounts = { from: kept.makeAccounts, to: makeAccounts };
          }
          if (required !== kept.required) details.required = { from: kept.required, to: required };
          if (changed.secrets !== undefined) details.secretsChanged = true;
          await events.emit(
            tx,
            {
              action: "sso.provider_changed",
              actor: accountActor(accountOf(request).id),
              target: { type: "sso_provider", id: kept.id, name },
              details,
            },
            originOf(request),
          );
        });
        await enforcement.sweep(disconnect);
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
      // The last provider stays while everyone signs in through one.
      if (config.oidc === null && (await readSettings(db)).everyone) {
        const { rows } = await db.query("SELECT id FROM sso_providers WHERE id <> $1 LIMIT 1", [
          request.params.id,
        ]);
        if (rows.length === 0) {
          return fail(
            reply,
            409,
            "Everyone signs in through a provider: turn that off before removing the last one.",
          );
        }
      }
      const removed = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          "DELETE FROM sso_providers WHERE id = $1 RETURNING id, name, settings",
          [request.params.id],
        );
        const row = rows[0];
        if (row === undefined) return false;
        const kind = (row.settings as { kind?: unknown } | null)?.kind;
        await events.emit(
          tx,
          {
            action: "sso.provider_removed",
            actor: accountActor(accountOf(request).id),
            target: { type: "sso_provider", id: String(row.id), name: String(row.name) },
            details: { kind: typeof kind === "string" ? kind : null },
          },
          originOf(request),
        );
        return true;
      });
      if (!removed) return fail(reply, 404, "There is no such provider.");
      enforcement.forget();
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
