// The server's configuration, read from environment variables.
import { isIP } from "node:net";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { endpointsVariable, maxEndpoints, readEndpoints } from "./aiEndpoints.ts";
import { type EnterprisePins, enterpriseFeatures, switchVariable } from "./enterprise.ts";
import { type SecurityPins, securityNames, securitySettings } from "./settings.ts";

export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];

export const aiModes = ["on", "admin", "off"] as const;
export type AiMode = (typeof aiModes)[number];

export interface Config {
  /** The address to listen on. The Docker image sets 0.0.0.0. */
  readonly host: string;
  /** The port to listen on; 0 picks a free one. */
  readonly port: number;
  readonly logLevel: LogLevel;
  /** The PostgreSQL database's address, as `postgres://user:password@host:5432/nether`. */
  readonly databaseUrl: string;
  /**
   * This node's name among the server's nodes, as the console lists them
   * (ADR 0082): `NETHER_NODE_NAME`, or the machine's, as a pod's is.
   */
  readonly nodeName: string;
  /**
   * How long a node stopping on SIGTERM keeps serving after its readiness
   * probe answers 503, while the load balancer takes it out (ADR 0082):
   * NETHER_DRAIN_SECONDS, 5 unless set.
   */
  readonly drainSeconds: number;
  /**
   * The Redis or Valkey server that keeps the rate limits' counts (ADR 0054),
   * as `redis://host:6379`; without one, each node keeps its own in memory.
   */
  readonly redisUrl: string | null;
  /**
   * Which proxies in front of the server to believe about the client's
   * address: none, all, or their addresses and ranges.
   */
  readonly trustProxy: boolean | readonly string[];
  /**
   * Which addresses that are not public webhooks may reach (ADR 0060): none,
   * all, or these addresses and ranges, for services on the admin's network.
   */
  readonly webhookPrivate: boolean | readonly string[];
  /**
   * Whether the web app's AI goes through this server (ADR 0070): `on`, with
   * each account's providers and the admin's; `admin`, with the admin's
   * alone; or `off`.
   */
  readonly ai: AiMode;
  /**
   * Which addresses that are not public the admin's AI providers may reach,
   * as a model on the server's own network: none, all, or these addresses
   * and ranges. An account's own providers reach public addresses only.
   */
  readonly aiPrivate: boolean | readonly string[];
  /**
   * Which addresses that are not public the single sign-on providers the
   * console names may be at, as Keycloak beside the server (ADR 0080):
   * none, all, or these addresses and ranges.
   */
  readonly ssoPrivate: boolean | readonly string[];
  /**
   * The 32 bytes that seal what the server keeps secret for its accounts,
   * AI providers' keys among them, from NETHER_SECRET_KEY in base64; none,
   * and the server keeps no such secret.
   */
  readonly secretKey: Buffer | null;
  /**
   * The setup code first-run setup takes while the server has no account,
   * from NETHER_SETUP_CODE, so every node accepts the same one (ADR 0082);
   * none, and each start makes a new code and writes it to the log.
   */
  readonly setupCode: string | null;
  /** The SMTP server to send email through, if any; without one the server sends none. */
  readonly mail: MailConfig | null;
  /**
   * The address people reach the server at, as `https://nether.example.org`,
   * without a slash at its end, for the links and redirects that need it.
   */
  readonly publicUrl: string | null;
  /** The OpenID Connect provider to sign in with, if any. */
  readonly oidc: OidcConfig | null;
  /** Where attachments' bytes are kept: a folder on the server's disk, or an S3-compatible bucket. */
  readonly storage: StorageConfig;
  /** The largest attachment the server takes, in bytes. */
  readonly attachmentLimit: number;
  /** How many days the server keeps notes' earlier versions (ADR 0041). */
  readonly historyDays: number;
  /** Scheduled backups (ADR 0052), or none. */
  readonly backup: BackupConfig | null;
  /** The web app's build to serve at `/` (ADR 0053), or none. */
  readonly webApp: WebAppConfig | null;
  /** How the environment pins each enterprise feature; unset ones are the console's (ADR 0079). */
  readonly enterprise: EnterprisePins;
  /** The security settings the environment pins; unset ones are the console's (ADR 0084). */
  readonly security: SecurityPins;
  /** The approved AI endpoints, when NETHER_AI_ENDPOINTS pins them; else the console's (ADR 0086). */
  readonly aiEndpoints: readonly string[] | undefined;
}

export interface WebAppConfig {
  /** The folder of the web app's build, with its index.html. */
  readonly dir: string;
  /** Whether NETHER_WEB_APP named it, so the server must serve it, rather than finding it there. */
  readonly named: boolean;
}

export interface MailConfig {
  /** As `smtp://user:password@host:587` or `smtps://user:password@host:465`. */
  readonly url: string;
  /** The sender, as `Nether <nether@example.org>`. */
  readonly from: string;
}

export type StorageConfig =
  | { readonly kind: "disk"; readonly path: string }
  | {
      readonly kind: "s3";
      readonly endpoint: string;
      readonly bucket: string;
      readonly region: string;
      readonly accessKey: string;
      readonly secretKey: string;
    };

export interface OidcConfig {
  /** The provider's issuer, whose discovery document is under `/.well-known/openid-configuration`. */
  readonly issuer: string;
  readonly clientId: string;
  /** None for a public client, which proves itself with PKCE alone. */
  readonly clientSecret: string | null;
  /** The provider's name, for the app's button: "Sign in with …". */
  readonly name: string;
  /** Whether anyone the provider signs in gets an account, not only people with one or an invitation. */
  readonly signUp: boolean;
}

/** A configuration value that cannot be used, with the variable that holds it. */
export class ConfigError extends Error {
  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}`);
    this.name = "ConfigError";
  }
}

const on = ["on", "true", "yes", "1"];
const off = ["off", "false", "no", "0", ""];

function readSwitch(env: NodeJS.ProcessEnv, variable: string): boolean {
  const value = (env[variable] ?? "").trim().toLowerCase();
  if (on.includes(value)) return true;
  if (off.includes(value)) return false;
  throw new ConfigError(variable, `must be on or off, not "${env[variable] ?? ""}"`);
}

/** A switch the environment may pin on or off, or leave unset for the console. */
function readPin(env: NodeJS.ProcessEnv, variable: string): boolean | undefined {
  return (env[variable] ?? "").trim() === "" ? undefined : readSwitch(env, variable);
}

/** The security settings the environment pins, each in its range (ADR 0084). */
function readSecurityPins(env: NodeJS.ProcessEnv): SecurityPins {
  const pins: Partial<Record<keyof SecurityPins, number | boolean>> = {};
  for (const name of securityNames) {
    const setting: (typeof securitySettings)[keyof typeof securitySettings] =
      securitySettings[name];
    const text = (env[setting.variable] ?? "").trim();
    if (text === "") continue;
    if (setting.kind === "switch") {
      pins[name] = readSwitch(env, setting.variable);
      continue;
    }
    const value = Number(text);
    if (!/^\d+$/.test(text) || value < setting.min || value > setting.max) {
      throw new ConfigError(
        setting.variable,
        `must be a whole number from ${String(setting.min)} to ${String(setting.max)}, not "${text}"`,
      );
    }
    pins[name] = value;
  }
  return pins as SecurityPins;
}

/** The approved AI endpoints NETHER_AI_ENDPOINTS pins, a comma-separated list (ADR 0086). */
function readAiEndpoints(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  const text = env[endpointsVariable]?.trim() ?? "";
  if (text === "") return undefined;
  try {
    return readEndpoints(text.split(","));
  } catch (error) {
    throw new ConfigError(
      endpointsVariable,
      `must list http or https addresses, ${String(maxEndpoints)} at most: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readPort(env: NodeJS.ProcessEnv): number {
  const value = env.NETHER_PORT?.trim() ?? "";
  if (value === "") return 3000;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new ConfigError("NETHER_PORT", `must be a port number from 0 to 65535, not "${value}"`);
  }
  return port;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const value = env.NETHER_LOG_LEVEL?.trim().toLowerCase() ?? "";
  if (value === "") return "info";
  const level = logLevels.find((item) => item === value);
  if (level === undefined) {
    throw new ConfigError(
      "NETHER_LOG_LEVEL",
      `must be one of ${logLevels.join(", ")}, not "${value}"`,
    );
  }
  return level;
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.NETHER_DATABASE_URL?.trim() ?? "";
  if (value === "") {
    throw new ConfigError(
      "NETHER_DATABASE_URL",
      "must be set to the PostgreSQL database's address, as postgres://user:password@host:5432/nether",
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    throw new ConfigError("NETHER_DATABASE_URL", "must be a postgres:// address");
  }
  return value;
}

/** NETHER_DRAIN_SECONDS: 0 to 300 seconds, 5 unless set. */
function readDrainSeconds(env: NodeJS.ProcessEnv): number {
  const value = env.NETHER_DRAIN_SECONDS?.trim() ?? "";
  if (value === "") return 5;
  if (!/^\d+$/.test(value) || Number(value) > 300) {
    throw new ConfigError(
      "NETHER_DRAIN_SECONDS",
      `must be a whole number of seconds from 0 to 300, not "${value}"`,
    );
  }
  return Number(value);
}

/** This node's name: `NETHER_NODE_NAME`, or the machine's when unset or blank. */
function readNodeName(env: NodeJS.ProcessEnv): string {
  const value = env.NETHER_NODE_NAME?.trim() ?? "";
  return value === "" ? hostname() : value;
}

function readRedisUrl(env: NodeJS.ProcessEnv): string | null {
  const value = env.NETHER_REDIS_URL?.trim() ?? "";
  if (value === "") return null;
  if (!/^rediss?:\/\/./i.test(value)) {
    throw new ConfigError(
      "NETHER_REDIS_URL",
      "must be a redis:// or rediss:// address, as redis://valkey:6379",
    );
  }
  return value;
}

/** An address, a range in CIDR notation, or one of proxy-addr's named ranges. */
function isProxy(text: string): boolean {
  if (["loopback", "linklocal", "uniquelocal"].includes(text)) return true;
  const [address = "", bits, ...rest] = text.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  return bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128));
}

function readTrustProxy(env: NodeJS.ProcessEnv): boolean | readonly string[] {
  const value = env.NETHER_TRUST_PROXY?.trim() ?? "";
  if (off.includes(value.toLowerCase())) return false;
  if (on.includes(value.toLowerCase())) return true;
  const proxies = value.split(",").map((item) => item.trim());
  if (!proxies.every(isProxy)) {
    throw new ConfigError(
      "NETHER_TRUST_PROXY",
      `must be on, off, or the proxies' addresses and ranges separated by commas, not "${value}"`,
    );
  }
  return proxies;
}

/** Which addresses that are not public a kind of request may reach: none, all, or these. */
function readPrivate(
  env: NodeJS.ProcessEnv,
  variable: string,
  what: string,
): boolean | readonly string[] {
  const value = env[variable]?.trim() ?? "";
  if (off.includes(value.toLowerCase())) return false;
  if (on.includes(value.toLowerCase())) return true;
  const ranges = value.split(",").map((item) => item.trim());
  if (!ranges.every(isProxy)) {
    throw new ConfigError(
      variable,
      `must be on, off, or the addresses and ranges ${what} may reach separated by commas, not "${value}"`,
    );
  }
  return ranges;
}

function readAi(env: NodeJS.ProcessEnv): AiMode {
  const value = (env.NETHER_AI ?? "").trim().toLowerCase();
  if (value === "") return "on";
  if (aiModes.includes(value as AiMode)) return value as AiMode;
  throw new ConfigError("NETHER_AI", `must be on, admin or off, not "${env.NETHER_AI ?? ""}"`);
}

/** NETHER_SETUP_CODE: 16 to 64 characters, not counting the spaces and hyphens setup ignores. */
function readSetupCode(env: NodeJS.ProcessEnv): string | null {
  const value = env.NETHER_SETUP_CODE?.trim() ?? "";
  if (value === "") return null;
  const counted = value.replace(/[\s-]/g, "").length;
  if (counted < 16 || value.length > 64) {
    throw new ConfigError(
      "NETHER_SETUP_CODE",
      "must be 16 to 64 characters, not counting spaces and hyphens, as `openssl rand -hex 12` makes",
    );
  }
  return value;
}

function readSecretKey(env: NodeJS.ProcessEnv): Buffer | null {
  const value = env.NETHER_SECRET_KEY?.trim() ?? "";
  if (value === "") return null;
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, "base64") : undefined;
  if (key?.length !== 32) {
    throw new ConfigError(
      "NETHER_SECRET_KEY",
      "must be 32 random bytes in base64, as `openssl rand -base64 32` makes them",
    );
  }
  return key;
}

function readMail(env: NodeJS.ProcessEnv): MailConfig | null {
  const url = env.NETHER_SMTP_URL?.trim() ?? "";
  const from = env.NETHER_MAIL_FROM?.trim() ?? "";
  if (url === "") {
    if (from !== "") {
      throw new ConfigError(
        "NETHER_MAIL_FROM",
        "is set without NETHER_SMTP_URL: set both to send email",
      );
    }
    return null;
  }
  if (!/^smtps?:\/\//i.test(url)) {
    throw new ConfigError("NETHER_SMTP_URL", "must be an smtp:// or smtps:// address");
  }
  if (!/^[^@\s]+@[^@\s]+$|<[^@\s]+@[^@\s]+>$/.test(from)) {
    throw new ConfigError(
      "NETHER_MAIL_FROM",
      "must be the address email comes from, as Nether <nether@example.org>",
    );
  }
  return { url, from };
}

/** An http:// or https:// address without a query or fragment, without its last slash. */
function readHttpUrl(env: NodeJS.ProcessEnv, variable: string): string | null {
  const value = env[variable]?.trim() ?? "";
  if (value === "") return null;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    !["http:", "https:"].includes(url.protocol) ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConfigError(variable, `must be an http:// or https:// address, not "${value}"`);
  }
  return value.replace(/\/+$/, "");
}

const oidcVariables = [
  "NETHER_OIDC_ISSUER",
  "NETHER_OIDC_CLIENT_ID",
  "NETHER_OIDC_CLIENT_SECRET",
  "NETHER_OIDC_NAME",
  "NETHER_OIDC_SIGN_UP",
];

function readOidc(env: NodeJS.ProcessEnv, publicUrl: string | null): OidcConfig | null {
  const issuer = readHttpUrl(env, "NETHER_OIDC_ISSUER");
  if (issuer === null) {
    const stray = oidcVariables.find((variable) => (env[variable]?.trim() ?? "") !== "");
    if (stray !== undefined) {
      throw new ConfigError(
        stray,
        "is set without NETHER_OIDC_ISSUER: set it to sign in with OIDC",
      );
    }
    return null;
  }
  const clientId = env.NETHER_OIDC_CLIENT_ID?.trim() ?? "";
  if (clientId === "") {
    throw new ConfigError("NETHER_OIDC_CLIENT_ID", "must be set with NETHER_OIDC_ISSUER");
  }
  if (publicUrl === null) {
    throw new ConfigError(
      "NETHER_PUBLIC_URL",
      "must be set with NETHER_OIDC_ISSUER, for the provider to send people back to",
    );
  }
  const secret = env.NETHER_OIDC_CLIENT_SECRET?.trim() ?? "";
  const name = env.NETHER_OIDC_NAME?.trim() ?? "";
  return {
    issuer,
    clientId,
    clientSecret: secret === "" ? null : secret,
    name: name === "" ? "single sign-on" : name,
    signUp: readSwitch(env, "NETHER_OIDC_SIGN_UP"),
  };
}

function readStorage(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = (env.NETHER_STORAGE?.trim() ?? "").toLowerCase();
  if (kind === "" || kind === "disk") {
    const path = env.NETHER_STORAGE_PATH?.trim() ?? "";
    return { kind: "disk", path: path === "" ? "data/attachments" : path };
  }
  if (kind !== "s3") {
    throw new ConfigError("NETHER_STORAGE", `must be disk or s3, not "${kind}"`);
  }
  const endpoint = readHttpUrl(env, "NETHER_S3_ENDPOINT");
  if (endpoint === null) {
    throw new ConfigError("NETHER_S3_ENDPOINT", "must be set to the S3-compatible store's address");
  }
  const required = (variable: string): string => {
    const value = env[variable]?.trim() ?? "";
    if (value === "") throw new ConfigError(variable, "must be set when NETHER_STORAGE is s3");
    return value;
  };
  const region = env.NETHER_S3_REGION?.trim() ?? "";
  return {
    kind: "s3",
    endpoint,
    bucket: required("NETHER_S3_BUCKET"),
    region: region === "" ? "us-east-1" : region,
    accessKey: required("NETHER_S3_ACCESS_KEY"),
    secretKey: required("NETHER_S3_SECRET_KEY"),
  };
}

function readAttachmentLimit(env: NodeJS.ProcessEnv): number {
  const value = env.NETHER_ATTACHMENT_LIMIT?.trim() ?? "";
  if (value === "") return 100 * 1024 * 1024;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 4096) {
    throw new ConfigError(
      "NETHER_ATTACHMENT_LIMIT",
      `must be a number of mebibytes from 1 to 4096, not "${value}"`,
    );
  }
  return Number(value) * 1024 * 1024;
}

/** Where scheduled backups go, how often, and how many are kept. */
export interface BackupConfig {
  readonly target:
    | { readonly kind: "disk"; readonly path: string }
    | {
        readonly kind: "s3";
        readonly endpoint: string;
        readonly bucket: string;
        readonly region: string;
        readonly accessKey: string;
        readonly secretKey: string;
        /** The folder of the bucket the backups go in, ending with a slash. */
        readonly prefix: string;
      };
  readonly hours: number;
  readonly keep: number;
}

function readCount(
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
  max: number,
): number {
  const value = env[variable]?.trim() ?? "";
  if (value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new ConfigError(
      variable,
      `must be a whole number from 1 to ${String(max)}, not "${value}"`,
    );
  }
  return Number(value);
}

function readBackup(env: NodeJS.ProcessEnv): BackupConfig | null {
  const kind = (env.NETHER_BACKUP?.trim() ?? "").toLowerCase();
  if (kind === "" || kind === "off") return null;
  const hours = readCount(env, "NETHER_BACKUP_HOURS", 24, 8760);
  const keep = readCount(env, "NETHER_BACKUP_KEEP", 7, 1000);
  if (kind === "disk") {
    const path = env.NETHER_BACKUP_PATH?.trim() ?? "";
    return { target: { kind: "disk", path: path === "" ? "data/backups" : path }, hours, keep };
  }
  if (kind !== "s3") {
    throw new ConfigError("NETHER_BACKUP", `must be off, disk or s3, not "${kind}"`);
  }
  const endpoint = readHttpUrl(env, "NETHER_S3_ENDPOINT");
  if (endpoint === null) {
    throw new ConfigError("NETHER_S3_ENDPOINT", "must be set when NETHER_BACKUP is s3");
  }
  const required = (variable: string): string => {
    const value = env[variable]?.trim() ?? "";
    if (value === "") throw new ConfigError(variable, "must be set when NETHER_BACKUP is s3");
    return value;
  };
  const region = env.NETHER_S3_REGION?.trim() ?? "";
  const prefix = (env.NETHER_BACKUP_S3_PREFIX?.trim() ?? "").replace(/^\/+/, "");
  return {
    target: {
      kind: "s3",
      endpoint,
      bucket: required("NETHER_BACKUP_S3_BUCKET"),
      region: region === "" ? "us-east-1" : region,
      accessKey: required("NETHER_S3_ACCESS_KEY"),
      secretKey: required("NETHER_S3_SECRET_KEY"),
      prefix: prefix === "" ? "nether-backups/" : prefix.endsWith("/") ? prefix : `${prefix}/`,
    },
    hours,
    keep,
  };
}

function readHistoryDays(env: NodeJS.ProcessEnv): number {
  const value = env.NETHER_HISTORY_DAYS?.trim() ?? "";
  if (value === "") return 30;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 36_500) {
    throw new ConfigError(
      "NETHER_HISTORY_DAYS",
      `must be a number of days from 1 to 36500, not "${value}"`,
    );
  }
  return Number(value);
}

/** Where the web app is built, beside the server in the repository: apps/web/dist. */
export const builtWebApp = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The web app to serve: the folder NETHER_WEB_APP names, none for "off",
 * and by default the one built beside the server, if it was built.
 */
function readWebApp(env: NodeJS.ProcessEnv): WebAppConfig | null {
  const value = env.NETHER_WEB_APP?.trim() ?? "";
  if (value.toLowerCase() === "off") return null;
  return value === "" ? { dir: builtWebApp, named: false } : { dir: value, named: true };
}

/** Reads the configuration, throwing a ConfigError that names the variable at fault. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const enterprise = Object.fromEntries(
    enterpriseFeatures.map((feature) => [feature, readPin(env, switchVariable(feature))]),
  ) as Record<keyof EnterprisePins, boolean | undefined>;
  const host = env.NETHER_HOST?.trim() ?? "";
  const publicUrl = readHttpUrl(env, "NETHER_PUBLIC_URL");
  return {
    host: host === "" ? "127.0.0.1" : host,
    port: readPort(env),
    logLevel: readLogLevel(env),
    databaseUrl: readDatabaseUrl(env),
    nodeName: readNodeName(env),
    drainSeconds: readDrainSeconds(env),
    redisUrl: readRedisUrl(env),
    trustProxy: readTrustProxy(env),
    webhookPrivate: readPrivate(env, "NETHER_WEBHOOK_PRIVATE", "webhooks"),
    ai: readAi(env),
    aiPrivate: readPrivate(env, "NETHER_AI_PRIVATE", "the admin's AI providers"),
    ssoPrivate: readPrivate(env, "NETHER_SSO_PRIVATE", "single sign-on providers"),
    secretKey: readSecretKey(env),
    setupCode: readSetupCode(env),
    mail: readMail(env),
    publicUrl,
    oidc: readOidc(env, publicUrl),
    storage: readStorage(env),
    attachmentLimit: readAttachmentLimit(env),
    historyDays: readHistoryDays(env),
    backup: readBackup(env),
    webApp: readWebApp(env),
    enterprise,
    security: readSecurityPins(env),
    aiEndpoints: readAiEndpoints(env),
  };
}
