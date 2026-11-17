import { readFileSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { registerAi } from "./ai.ts";
import { registerApi } from "./api.ts";
import { registerAttachments } from "./attachments.ts";
import { purgeDeliveries, startWebhooks } from "./deliveries.ts";
import type { BlobStore } from "./blobs.ts";
import { registerCodes } from "./codes.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import {
  type EnterpriseModule,
  EnterpriseSwitches,
  enterpriseFeatures,
  registerEnterprise,
} from "./enterprise.ts";
import { registerFeatures } from "./features.ts";
import { tooManyTries } from "./http.ts";
import { registerInvitations } from "./invitations.ts";
import { registerMembers } from "./members.ts";
import { purgeNotifications, registerNotifications } from "./notifications.ts";
import type { Mailer } from "./mail.ts";
import { registerOidc } from "./oidc.ts";
import { registerSessions } from "./sessions.ts";
import { registerSetup } from "./setup.ts";
import { registerRelay } from "./relay.ts";
import { registerSync } from "./sync.ts";
import { registerLinks } from "./links.ts";
import { registerPublished } from "./published.ts";
import { registerSites } from "./sites.ts";
import { registerTokens } from "./tokens.ts";
import { registerUnits } from "./units.ts";
import { purgeVersions, registerVersions } from "./versions.ts";
import { backfillSearch, registerSearch } from "./search.ts";
import { setSessionCookies, signInRoutes, wantsCookie } from "./cookies.ts";
import { backupIfDue, backupTarget, noBlobs } from "./backups.ts";
import type { Resolver } from "./outbound.ts";
import type { TxtResolver } from "./domains.ts";
import { registerWebApp } from "./web.ts";
import { registerWebhooks } from "./webhooks.ts";
import { registerWorkspaces } from "./workspaces.ts";
import { registerWrites } from "./writes.ts";
import { ServerEvents, fromServer } from "./events.ts";

/** The server's version, from its package.json (one folder up from src/ and dist/ alike). */
export function serverVersion(): string {
  const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(text) as { version: string }).version;
}

const healthSchema = {
  response: {
    200: {
      type: "object",
      required: ["status", "version", "enterprise"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] },
        version: { type: "string" },
        enterprise: {
          type: "object",
          required: [...enterpriseFeatures],
          additionalProperties: false,
          properties: Object.fromEntries(
            enterpriseFeatures.map((feature) => [feature, { type: "boolean" }]),
          ),
        },
      },
    },
  },
} as const;

/** What the server runs with besides its configuration. */
export interface Services {
  readonly db: Database;
  /** The code first-run setup asks for, while the server has no account. */
  readonly setupCode?: string;
  /** What sends email, when the admin has named an SMTP server. */
  readonly mailer?: Mailer;
  /** Where attachments' bytes are kept; without it, the server takes none. */
  readonly blobs?: BlobStore;
  /**
   * Where the rate limits keep their counts, so they hold across restarts
   * and nodes (ADR 0054); without it, each node counts in its memory.
   */
  readonly redis?: Redis;
  /** The modules of the enterprise features this build includes, each off until switched on (ADR 0079). */
  readonly enterpriseModules?: readonly EnterpriseModule[];
  /**
   * Whether webhooks' worker runs every few seconds (ADR 0060), as it does
   * unless a test turns it off to run its rounds by hand.
   */
  readonly webhookWorker?: boolean;
  /** What resolves AI providers' hosts, for the relay's checks; the system's unless a test gives another. */
  readonly aiResolve?: Resolver;
  /** What looks up sites' domains' TXT records (ADR 0077); the system's unless a test gives another. */
  readonly resolveTxt?: TxtResolver;
}

/** Builds the server: its routes, and the modules of the enterprise features that are switched on. */
export async function buildApp(config: Config, services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: typeof config.trustProxy === "boolean" ? config.trustProxy : [...config.trustProxy],
  });
  // Limits apply only to the routes that ask for one, as signing in does.
  await app.register(rateLimit, {
    global: false,
    ...(services.redis === undefined ? {} : { redis: services.redis, nameSpace: "nether:limit:" }),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: tooManyTries(Math.ceil(context.ttl / 1000)),
    }),
  });
  const version = serverVersion();

  // Signing in from the web app: the session's token goes in a cookie the
  // page cannot read, not in the answer (ADR 0053).
  app.addHook("onSend", (request, reply, payload) => {
    if (
      request.method !== "POST" ||
      !signInRoutes.has(request.routeOptions.url ?? "") ||
      !wantsCookie(request) ||
      reply.statusCode >= 300 ||
      typeof payload !== "string"
    ) {
      return Promise.resolve(payload);
    }
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return Promise.resolve(payload);
    }
    if (typeof body !== "object" || body === null) return Promise.resolve(payload);
    const { token, expiresAt, ...rest } = body as Record<string, unknown>;
    if (typeof token !== "string" || typeof expiresAt !== "string") return Promise.resolve(payload);
    setSessionCookies(reply, request, token, expiresAt);
    return Promise.resolve(JSON.stringify({ ...rest, expiresAt }));
  });

  // What the server tells of as it happens, which modules listen to (ADR 0081).
  const events = new ServerEvents();
  const modules = services.enterpriseModules ?? [];
  const switches = new EnterpriseSwitches(
    services.db,
    config.enterprise,
    modules.map((module) => module.feature),
  );
  app.get("/health", { schema: healthSchema }, async () => ({
    status: "ok",
    version,
    enterprise: await switches.all(),
  }));
  registerFeatures(app, services.db, switches, events);

  registerSetup(app, services.db, services.setupCode, events);
  registerSessions(app, services.db, events);
  registerInvitations(app, services.db, events);
  registerWorkspaces(app, services.db, events);
  registerVersions(app, services.db);
  registerNotifications(app, services.db, services.mailer);
  registerSearch(app, services.db);
  // Versions older than the admin keeps them, and old notifications, go on
  // start, then every hour.
  const purge = async () => {
    await purgeVersions(services.db, config.historyDays).catch((error: unknown) => {
      app.log.error({ err: error }, "Could not delete the versions kept too long");
    });
    await purgeNotifications(services.db).catch((error: unknown) => {
      app.log.error({ err: error }, "Could not delete the notifications kept too long");
    });
    await purgeDeliveries(services.db).catch((error: unknown) => {
      app.log.error({ err: error }, "Could not delete the webhooks' old deliveries");
    });
  };
  const hourly = setInterval(() => void purge(), 3_600_000);
  hourly.unref();
  // Scheduled backups (ADR 0052): checked as the server starts, then every
  // ten minutes, one made when the last began longer ago than asked.
  const backup = config.backup;
  const backups =
    backup === null
      ? undefined
      : (() => {
          const target = backupTarget(backup);
          const check = () => {
            backupIfDue(services.db, services.blobs ?? noBlobs, target, backup).then(
              async (made) => {
                if (made === undefined) return;
                app.log.info(made, "Made a backup");
                // A backup holds every workspace: an export, by the server itself.
                await events.attempt(
                  services.db,
                  {
                    action: "backup.made",
                    actor: { kind: "system" },
                    target: { type: "backup", id: made.name, name: made.name },
                    details: { rows: made.rows, attachments: made.blobs },
                  },
                  fromServer,
                  app.log,
                );
              },
              (error: unknown) => {
                app.log.error({ err: error }, "Could not make a backup");
              },
            );
          };
          const timer = setInterval(check, 600_000);
          timer.unref();
          return { check, timer };
        })();
  app.addHook("onReady", async () => {
    backups?.check();
    await purge();
    // What was stored before search was, indexed once (ADR 0050).
    const indexed = await backfillSearch(services.db);
    if (indexed > 0) app.log.info({ documents: indexed }, "Indexed the stored notes for search");
  });
  app.addHook("onClose", (_instance, done) => {
    clearInterval(hourly);
    if (backups !== undefined) clearInterval(backups.timer);
    done();
  });
  if (services.blobs !== undefined) {
    registerAttachments(app, services.db, services.blobs, config.attachmentLimit);
  }
  // The relay's sockets come through the WebSocket plugin sync registers.
  const sync = await registerSync(app, services.db, events);
  const relay = registerRelay(app, services.db);
  const reconnect = (userId: string) => {
    sync.disconnect(userId);
    relay.disconnect(userId);
  };
  registerMembers(app, services.db, reconnect, events);
  registerUnits(app, services.db, reconnect, sync, events);
  // Share links, which open a shared page to anyone with one (ADR 0071).
  registerLinks(app, services.db, {
    publicUrl: config.publicUrl,
    webApp: config.webApp !== null,
    disconnect: (userId) => {
      sync.disconnect(userId);
    },
    events,
  });
  // Published sites, drawn for anyone at /p/<name>/ (ADR 0076).
  // Their custom domains' requests, on any route, are theirs (ADR 0077).
  const published = registerPublished(app, services.db, {
    blobs: services.blobs,
    publicUrl: config.publicUrl,
  });
  registerSites(app, services.db, {
    publicUrl: config.publicUrl,
    changed: published.changed,
    resolveTxt: services.resolveTxt,
    events,
  });
  // The public API, for personal access tokens (ADR 0059).
  registerTokens(app, services.db, events);
  const api = registerApi(app, services.db, sync, events);
  registerWrites(app, services.db, sync, api);
  // Webhooks, and the worker that sends their events (ADR 0060).
  registerWebhooks(app, services.db, config.webhookPrivate, api, events);
  if (services.webhookWorker !== false) {
    const webhooks = startWebhooks(services.db, {
      policy: config.webhookPrivate,
      ...(services.mailer === undefined ? {} : { mailer: services.mailer }),
      log: app.log,
    });
    // Its round ends before the database closes.
    app.addHook("onClose", () => webhooks.stop());
  }
  // AI for the web app, through this server (ADR 0070).
  registerAi(app, services.db, {
    mode: config.ai,
    privatePolicy: config.aiPrivate,
    secretKey: config.secretKey,
    ...(services.aiResolve === undefined ? {} : { resolve: services.aiResolve }),
  });
  if (services.mailer !== undefined) {
    registerCodes(app, services.db, services.mailer, events, config.publicUrl);
  }
  const { oidc, publicUrl } = config;
  if (oidc !== null && publicUrl !== null) {
    registerOidc(app, services.db, oidc, publicUrl, events);
  }
  // How the app may offer to sign in on this server.
  app.get("/api/sign-in-methods", () => ({
    password: true,
    emailCode: services.mailer !== undefined,
    oidc: oidc === null ? null : { name: oidc.name },
  }));
  await registerEnterprise(app, services.db, switches, modules, {
    events,
    secretKey: config.secretKey,
  });
  // The web app at `/`, with its own answer for paths the API does not have.
  await registerWebApp(app, config.webApp);
  return app;
}
