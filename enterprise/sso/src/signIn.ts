// Signing in through the console's providers (ADR 0080), as the apps sign
// in through the environment's (ADR 0034): the app starts a flow with its
// loopback or web address and a PKCE challenge; the browser signs in at
// the provider, which answers at this provider's own address; the server
// finds the account and sends the browser back with a code that lasts a
// minute, which the app redeems with its verifier for a session. Where
// single sign-on is required, the apps ask for the address first, and
// `/api/sso/find` names its domain's provider.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import { setSessionCookies, wantsCookie } from "@nether/server/src/cookies.ts";
import {
  type Database,
  type Row,
  readBoolean,
  readText,
  readTextOrNull,
} from "@nether/server/src/db.ts";
import { type ServerEvents, accountActor, originOf } from "@nether/server/src/events.ts";
import { emailField, fail, limitByAddress } from "@nether/server/src/http.ts";
import {
  type OidcClient,
  type Person,
  type Redeem,
  type Start,
  flowMinutes,
  handoffSeconds,
  mayReturnTo,
  oidcClient,
  pkceChallenge,
  redeemBody,
  startBody,
} from "@nether/server/src/oidc.ts";
import { checkedFetch } from "@nether/server/src/outbound.ts";
import { type Seal, SealedElsewhere, sealWith } from "@nether/server/src/secrets.ts";
import {
  type NewSession,
  newToken,
  refusedSignIn,
  startSession,
  tokenHash,
} from "@nether/server/src/sessions.ts";
import { type SignInGuards, SignInRefused } from "@nether/server/src/signIns.ts";
import { type Outcome, type SignInError, resolveAccount } from "./accounts.ts";
import { type Enforcement, covers } from "./enforcement.ts";
import {
  type OidcSettings,
  type Provider,
  type SamlSettings,
  addressDomain,
  domainOwner,
  findProvider,
  listProviders,
  openSecrets,
  secretsBox,
} from "./providers.ts";
import { type SamlContext, finishSaml, serviceMetadata, startSaml } from "./saml.ts";

/** What the module's routes share. */
export interface SignInContext {
  readonly db: Database;
  readonly config: Config;
  readonly whenOn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The server's events, told of each sign-in as core's own are (ADR 0081). */
  readonly events: ServerEvents;
  /** Every guard the server asks, single sign-on's among them. */
  readonly guards: SignInGuards;
  /** What single sign-on requires. */
  readonly enforcement: Enforcement;
}

/** The setting that lets the console's providers be on a private network. */
export const privateSetting = "NETHER_SSO_PRIVATE";

/** The fetch that reaches the console's providers, under the outbound rules (ADR 0060). */
export function providerFetch(config: Config) {
  return checkedFetch({ policy: config.ssoPrivate, allowedBy: privateSetting });
}

/** The seal of the server's secrets, or why there is none. */
export function sealOf(config: Config): Seal | undefined {
  return config.secretKey === null ? undefined : sealWith(config.secretKey);
}

const noPublicUrl =
  "This server has no NETHER_PUBLIC_URL, which signing in through a provider needs.";
const noSecretKey = "This server has no NETHER_SECRET_KEY, which keeps the providers' secrets.";

/** An OpenID Connect provider's client, made again when the console changes the provider. */
export function oidcClients(app: FastifyInstance, config: Config) {
  const made = new Map<string, { readonly at: number; readonly client: OidcClient }>();
  return (provider: Provider, settings: OidcSettings, clientSecret: string | null): OidcClient => {
    const kept = made.get(provider.id);
    if (kept?.at === provider.updatedAt.getTime()) return kept.client;
    const client = oidcClient(
      {
        issuer: settings.issuer,
        clientId: settings.clientId,
        clientSecret,
        callbackUrl: `${config.publicUrl ?? ""}/api/sso/${provider.id}/oidc/callback`,
        fetch: providerFetch(config),
      },
      app.log,
    );
    made.set(provider.id, { at: provider.updatedAt.getTime(), client });
    return client;
  };
}

interface Params {
  readonly id: string;
}

export function registerSignIn(app: FastifyInstance, context: SignInContext): void {
  const { db, config, whenOn, events, guards, enforcement } = context;
  const clients = oidcClients(app, config);
  const seal = sealOf(config);

  /** A provider's secrets, opened. */
  async function secretsOf(provider: Provider) {
    if (seal === undefined) throw new Error(noSecretKey);
    const box = await secretsBox(db, provider.id);
    if (box === undefined) throw new Error("The provider is gone.");
    return openSecrets(seal, provider.id, box);
  }

  async function samlContext(
    provider: Provider,
    settings: SamlSettings,
    publicUrl: string,
  ): Promise<SamlContext> {
    const { privateKey } = await secretsOf(provider);
    if (privateKey === undefined) throw new Error("The provider has no key.");
    return { db, publicUrl, id: provider.id, settings, privateKey };
  }

  /** Sends the browser back to the app, with a code or an error. */
  function back(reply: FastifyReply, redirect: string, query: Record<string, string>) {
    const url = new URL(redirect);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return reply.redirect(url.href, 302);
  }

  const expired = (reply: FastifyReply) =>
    reply
      .code(400)
      .type("text/plain; charset=utf-8")
      .send("This sign-in has expired or was used already. Start again from the app.");

  /** Finds the account a provider's answer names, and sends the browser back with a code or an error. */
  async function complete(
    request: FastifyRequest,
    reply: FastifyReply,
    flow: Row,
    provider: Provider,
    issuer: string,
    person: Person,
  ) {
    const flowId = readText(flow, "id");
    const outcome = await db
      .transaction(async (tx): Promise<Outcome | { code: string }> => {
        // Taken now, so a second answer to the same flow finds it gone.
        const taken = await tx.query(
          "SELECT id FROM sso_flows WHERE id = $1 AND handoff_hash IS NULL FOR UPDATE",
          [flowId],
        );
        if (taken.rows.length === 0) return { error: "provider_error" };
        const resolved = await resolveAccount(
          tx,
          provider,
          issuer,
          person,
          readTextOrNull(flow, "invitation_hash"),
          events,
          originOf(request),
        );
        if ("error" in resolved) return resolved;
        // Told now, while the browser is still here, rather than when the app
        // redeems; refused, what the sign-in made or linked is not kept.
        const users = await tx.query("SELECT email, instance_admin FROM users WHERE id = $1", [
          resolved.userId,
        ]);
        const attempt = {
          userId: resolved.userId,
          email: readText(users.rows[0], "email"),
          instanceAdmin: readBoolean(users.rows[0], "instance_admin"),
          method: "sso" as const,
          provider: provider.id,
        };
        const refusal = await guards.check(attempt, tx);
        if (refusal !== undefined) throw new SignInRefused(refusal, attempt);
        const code = newToken();
        await tx.query(
          `UPDATE sso_flows
            SET handoff_hash = $2, user_id = $3, workspace_id = $4,
                expires_at = now() + $5 * interval '1 second'
          WHERE id = $1`,
          [flowId, tokenHash(code), resolved.userId, resolved.workspaceId, handoffSeconds],
        );
        return { code };
      })
      .catch((error: unknown) => {
        if (!(error instanceof SignInRefused)) throw error;
        return { error: "sso_required" } as const;
      });
    if ("code" in outcome) return back(reply, readText(flow, "redirect"), { code: outcome.code });
    return failed(
      request,
      reply,
      flow,
      "error" in outcome ? outcome.error : "provider_error",
      person.email,
    );
  }

  /**
   * Ends a flow that found no account, told of as a failed sign-in by the
   * address the provider gave, if it gave one, as core's are (ADR 0081).
   */
  async function failed(
    request: FastifyRequest,
    reply: FastifyReply,
    flow: Row,
    error: SignInError,
    email?: string,
  ) {
    await db.query("DELETE FROM sso_flows WHERE id = $1", [readText(flow, "id")]);
    await events.attempt(
      db,
      {
        action: "session.signed_in",
        outcome: "failure",
        reason: error.replaceAll("_", " "),
        actor: email === undefined ? { kind: "anonymous" } : { kind: "anonymous", email },
        details: { method: "sso", provider: readText(flow, "provider_id") },
      },
      originOf(request),
      request.log,
    );
    return back(reply, readText(flow, "redirect"), { error });
  }

  /** A flow under way through a provider, by the state its answer carries. */
  async function flowOf(id: string, state: string): Promise<Row | undefined> {
    const { rows } = await db.query(
      `SELECT id, provider_id, nonce, verifier, request_id, redirect, invitation_hash FROM sso_flows
        WHERE provider_id = $1 AND state_hash = $2 AND handoff_hash IS NULL AND expires_at > now()`,
      [id, tokenHash(state)],
    );
    return rows[0];
  }

  // The providers the apps offer, by name; 404 while single sign-on is off.
  app.get("/api/sso", { preHandler: whenOn }, async () => ({
    providers: (await listProviders(db)).map((provider) => ({
      id: provider.id,
      name: provider.name,
    })),
    everyone: (await enforcement.rules())?.everyone ?? false,
  }));

  // An address's provider, by its domain alone, so it tells nothing of
  // accounts: the apps go straight there when there is one.
  app.post<{ Body: { email: string } }>(
    "/api/sso/find",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: { email: emailField },
        },
      },
      onRequest: limitByAddress(app, "sso-find", 60, "5 minutes"),
      preHandler: whenOn,
    },
    async (request) => {
      const { email } = request.body;
      const rules = await enforcement.rules();
      const id = await domainOwner(db, addressDomain(email));
      const owner = id === undefined ? undefined : await findProvider(db, id);
      return {
        provider: owner === undefined ? null : { id: owner.id, name: owner.name },
        // Whether the address's accounts sign in through a provider alone, their admins aside.
        required: rules !== undefined && covers(rules, email),
      };
    },
  );

  app.post<{ Params: Params; Body: Start }>(
    "/api/sso/:id/flows",
    {
      schema: { body: startBody },
      onRequest: limitByAddress(app, "sso-flows", 30, "5 minutes"),
      preHandler: whenOn,
    },
    async (request, reply) => {
      const { publicUrl } = config;
      if (publicUrl === null) return fail(reply, 503, noPublicUrl);
      const provider = await findProvider(db, request.params.id);
      if (provider === undefined) return fail(reply, 404, "There is no such provider.");
      const { body } = request;
      if (!mayReturnTo(body.redirect, publicUrl)) {
        return fail(
          reply,
          400,
          "The address to come back to must be the app's loopback address, by IP, or this server's.",
        );
      }
      await db.query("DELETE FROM sso_flows WHERE expires_at < now()");
      await db.query("DELETE FROM sso_kept WHERE expires_at < now()");
      const { settings } = provider;
      let started: {
        readonly url: string;
        readonly state: string;
        readonly nonce: string | null;
        readonly verifier: string | null;
        readonly requestId: string | null;
      };
      try {
        if (settings.kind === "saml") {
          const state = newToken();
          const saml = await startSaml(await samlContext(provider, settings, publicUrl), state);
          started = {
            url: saml.url,
            state,
            nonce: null,
            verifier: null,
            requestId: saml.requestId,
          };
        } else {
          const { clientSecret } = await secretsOf(provider);
          const oidc = await clients(provider, settings, clientSecret ?? null).start();
          started = { ...oidc, url: oidc.url.href, requestId: null };
        }
      } catch (error) {
        request.log.error({ err: error, provider: provider.id }, "Could not start a sign-in");
        if (error instanceof SealedElsewhere) return fail(reply, 503, error.message);
        return fail(reply, 503, `${provider.name} cannot be reached; try again later.`);
      }
      await db.query(
        `INSERT INTO sso_flows
           (id, provider_id, state_hash, nonce, verifier, request_id, redirect, challenge,
            invitation_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + $10 * interval '1 minute')`,
        [
          randomUUID(),
          provider.id,
          tokenHash(started.state),
          started.nonce,
          started.verifier,
          started.requestId,
          body.redirect,
          body.challenge,
          body.invitation === undefined ? null : tokenHash(body.invitation),
          flowMinutes,
        ],
      );
      return reply.code(201).send({ url: started.url });
    },
  );

  // Nether's metadata for a SAML provider, which its admin gives the provider.
  app.get<{ Params: Params }>(
    "/api/sso/:id/saml/metadata",
    { preHandler: whenOn },
    async (request, reply) => {
      const { publicUrl } = config;
      if (publicUrl === null) return fail(reply, 503, noPublicUrl);
      const provider = await findProvider(db, request.params.id);
      if (provider?.settings.kind !== "saml") {
        return fail(reply, 404, "There is no such SAML provider.");
      }
      const context = await samlContext(provider, provider.settings, publicUrl);
      return reply
        .type("application/samlmetadata+xml; charset=utf-8")
        .send(serviceMetadata(context));
    },
  );

  // The provider's answer, posted by the browser: a form, as SAML's POST binding has it.
  app.register((saml, _options, done) => {
    saml.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 2_000_000 },
      (_request, body, parsed) => {
        parsed(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    saml.post<{ Params: Params; Body: Record<string, string> }>(
      "/api/sso/:id/saml/acs",
      {
        onRequest: limitByAddress(app, "sso-saml-acs", 30, "5 minutes"),
        preHandler: whenOn,
      },
      async (request, reply) => {
        const { publicUrl } = config;
        if (publicUrl === null) return fail(reply, 503, noPublicUrl);
        const form = typeof request.body === "object" ? request.body : {};
        const flow = await flowOf(request.params.id, form.RelayState ?? "");
        const requestId = flow === undefined ? null : readTextOrNull(flow, "request_id");
        if (flow === undefined || requestId === null) return expired(reply);
        const provider = await findProvider(db, request.params.id);
        if (provider?.settings.kind !== "saml") {
          return failed(request, reply, flow, "provider_error");
        }
        let person: Person;
        try {
          person = await finishSaml(
            await samlContext(provider, provider.settings, publicUrl),
            form,
            requestId,
          );
        } catch (error) {
          request.log.warn(
            { err: error, provider: provider.id },
            "A SAML provider's answer was refused",
          );
          return failed(request, reply, flow, "provider_error");
        }
        return complete(request, reply, flow, provider, provider.settings.entityId, person);
      },
    );
    done();
  });

  app.get<{ Params: Params; Querystring: Record<string, string | undefined> }>(
    "/api/sso/:id/oidc/callback",
    {
      onRequest: limitByAddress(app, "sso-oidc-callback", 30, "5 minutes"),
      preHandler: whenOn,
    },
    async (request, reply) => {
      const state = typeof request.query.state === "string" ? request.query.state : "";
      const flow = await flowOf(request.params.id, state);
      const nonce = flow === undefined ? null : readTextOrNull(flow, "nonce");
      const verifier = flow === undefined ? null : readTextOrNull(flow, "verifier");
      if (flow === undefined || nonce === null || verifier === null) return expired(reply);
      if (request.query.error !== undefined) return failed(request, reply, flow, "access_denied");
      const provider = await findProvider(db, request.params.id);
      if (provider?.settings.kind !== "oidc") return failed(request, reply, flow, "provider_error");
      let person: Person;
      try {
        const { clientSecret } = await secretsOf(provider);
        person = await clients(provider, provider.settings, clientSecret ?? null).finish(
          request.url,
          { state, nonce, verifier },
        );
      } catch (error) {
        request.log.warn(
          { err: error, provider: provider.id },
          "An OpenID Connect provider's answer was refused",
        );
        return failed(request, reply, flow, "provider_error");
      }
      return complete(request, reply, flow, provider, provider.settings.issuer, person);
    },
  );

  app.post<{ Body: Redeem }>(
    "/api/sso/redeem",
    {
      schema: { body: redeemBody },
      onRequest: limitByAddress(app, "sso-redeem", 30, "5 minutes"),
      preHandler: whenOn,
    },
    async (request, reply) => {
      const outcome = await db.transaction(async (tx) => {
        // Spent by any try, right or wrong.
        const { rows } = await tx.query(
          `DELETE FROM sso_flows
            WHERE handoff_hash = $1 AND expires_at > now()
            RETURNING provider_id, challenge, user_id, workspace_id`,
          [tokenHash(request.body.code)],
        );
        const flow = rows[0];
        if (flow === undefined) return { failed: "code used, expired or unknown" } as const;
        const provider = readText(flow, "provider_id");
        const userId = readText(flow, "user_id");
        const challenge = Buffer.from(readText(flow, "challenge"));
        const proven = Buffer.from(pkceChallenge(request.body.verifier));
        if (challenge.length !== proven.length || !timingSafeEqual(challenge, proven)) {
          return { failed: "not the app that began it", userId, provider } as const;
        }
        const users = await tx.query(
          "SELECT name, email, instance_admin FROM users WHERE id = $1",
          [userId],
        );
        const user = users.rows[0];
        const workspaceId = readTextOrNull(flow, "workspace_id");
        const workspaces =
          workspaceId === null
            ? undefined
            : await tx.query(
                `SELECT w.name, m.role FROM workspaces w
                   JOIN memberships m ON m.workspace_id = w.id AND m.user_id = $2
                  WHERE w.id = $1`,
                [workspaceId, userId],
              );
        const workspace = workspaces?.rows[0];
        let session: NewSession;
        try {
          session = await startSession(tx, userId, request, {
            method: "sso",
            provider,
            events,
            guards,
          });
        } catch (error) {
          // Spent, as any try is: the account signs in through another provider now.
          if (!(error instanceof SignInRefused)) throw error;
          return { refused: error } as const;
        }
        return {
          ...session,
          user: {
            id: userId,
            name: readText(user, "name"),
            email: readText(user, "email"),
            instanceAdmin: readBoolean(user, "instance_admin"),
          },
          ...(workspaceId === null || workspace === undefined
            ? {}
            : {
                workspace: {
                  id: workspaceId,
                  name: readText(workspace, "name"),
                  role: readText(workspace, "role"),
                },
              }),
        };
      });
      if ("refused" in outcome) {
        await refusedSignIn(db, events, request, outcome.refused);
        return fail(reply, 403, "This account signs in through another provider now.");
      }
      if ("failed" in outcome) {
        // Told of as core's own failed redemptions are (ADR 0081).
        await events.attempt(
          db,
          {
            action: "session.signed_in",
            outcome: "failure",
            reason: outcome.failed,
            actor: "userId" in outcome ? accountActor(outcome.userId) : { kind: "anonymous" },
            details:
              "provider" in outcome
                ? { method: "sso", provider: outcome.provider }
                : { method: "sso" },
          },
          originOf(request),
          request.log,
        );
        return fail(reply, 401, "That sign-in code was used, has expired, or is not this app's.");
      }
      // From the web app, the session goes in its cookie, not in the answer (ADR 0053).
      if (wantsCookie(request)) {
        const { token, ...rest } = outcome;
        setSessionCookies(reply, request, token, outcome.expiresAt);
        return reply.code(201).send(rest);
      }
      return reply.code(201).send(outcome);
    },
  );
}
