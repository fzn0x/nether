// Starts the server, configured by environment variables: it brings the
// database to its schema first, and while it has no account it takes
// NETHER_SETUP_CODE as its setup code, or makes one and writes it to its
// log. Its entries call it: `dist/main.js`, with no
// enterprise module, and `enterprise/server`, the image's, with every one
// (ADR 0079).
import type { Redis } from "ioredis";
import { buildApp } from "./app.ts";
import { DiskBlobs, S3Blobs } from "./blobs.ts";
import { readConfig } from "./config.ts";
import { connectPostgres } from "./db.ts";
import type { EnterpriseModule } from "./enterprise.ts";
import { smtpMailer } from "./mail.ts";
import { migrate } from "./migrations.ts";
import { connectRedis, watchRedis } from "./redis.ts";
import { newSetupCode, setupNeeded } from "./setup.ts";

export interface StartOptions {
  /** The enterprise features' modules this build has, each off until switched on. */
  readonly enterpriseModules?: readonly EnterpriseModule[];
}

/** Starts the server and listens, until a signal stops it. */
export async function startServer(options: StartOptions = {}): Promise<void> {
  const config = readConfig(process.env);
  const db = connectPostgres(config.databaseUrl);
  let redis: Redis | undefined;
  try {
    if (config.redisUrl !== null) redis = await connectRedis(config.redisUrl);
    const migrated = await migrate(db);
    // Every node takes the same code when the environment sets one (ADR 0082).
    const setupCode = (await setupNeeded(db)) ? (config.setupCode ?? newSetupCode()) : undefined;
    const mailer = config.mail === null ? undefined : smtpMailer(config.mail.url, config.mail.from);
    const blobs =
      config.storage.kind === "disk"
        ? new DiskBlobs(config.storage.path)
        : new S3Blobs(config.storage);
    const app = await buildApp(config, {
      db,
      blobs,
      ...(setupCode === undefined ? {} : { setupCode }),
      ...(mailer === undefined ? {} : { mailer }),
      ...(redis === undefined ? {} : { redis }),
      ...(options.enterpriseModules === undefined
        ? {}
        : { enterpriseModules: options.enterpriseModules }),
    });
    if (migrated.from !== migrated.to) {
      app.log.info(migrated, "Migrated the database to the server's schema");
    }
    if (redis !== undefined) watchRedis(redis, app.log);
    app.addHook("onClose", async () => {
      mailer?.close();
      await redis?.quit();
      await db.close();
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        app.log.info(`Received ${signal}, shutting down`);
        void app.close().then(() => process.exit(0));
      });
    }
    await app.listen({ host: config.host, port: config.port });
    if (setupCode !== undefined && config.setupCode !== null) {
      // Set by whoever runs the server, so not written where logs go.
      app.log.warn("The server has no account yet. Set it up from the app with NETHER_SETUP_CODE.");
    } else if (setupCode !== undefined) {
      app.log.warn(
        { setupCode },
        `The server has no account yet. Set it up from the app with this code: ${setupCode}`,
      );
    }
  } catch (error) {
    redis?.disconnect();
    await db.close().catch(() => undefined);
    throw error;
  }
}

/** Runs `startServer` as an entry does: a failure to start ends the process, saying why. */
export function runServer(options: StartOptions = {}): void {
  startServer(options).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Nether server could not start: ${message}\n`);
    process.exit(1);
  });
}
