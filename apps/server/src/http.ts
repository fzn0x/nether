// What the routes share: the schemas of the fields several of them take,
// and errors in the shape Fastify gives its own, so a client reads every
// error's `message` the same way.
import { STATUS_CODES } from "node:http";
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { minimumPasswordLength } from "./passwords.ts";

/** A person's or a workspace's name: some text that is not only spaces. */
export const nameField = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

export const emailField = {
  type: "string",
  maxLength: 320,
  pattern: "^\\s*[^@\\s]+@[^@\\s]+\\.[^@\\s]+\\s*$",
} as const;

/** A new password. One being checked is any text, so a wrong one is only wrong. */
export const newPasswordField = {
  type: "string",
  minLength: minimumPasswordLength,
  maxLength: 1024,
} as const;

export const passwordField = { type: "string", minLength: 1, maxLength: 1024 } as const;

/** A secret token the server made, as a client sends it back. */
export const tokenField = { type: "string", minLength: 1, maxLength: 200 } as const;

export const uuidField = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

/** The key an email address is compared by, so one person has one account. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Answers with an error: `{ statusCode, error, message }`, as Fastify's own errors are. */
export function fail(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply
    .code(statusCode)
    .send({ statusCode, error: STATUS_CODES[statusCode] ?? "Error", message });
}

/** The message of a 429, after how many seconds to try again. */
export function tooManyTries(seconds: number): string {
  return `Too many tries: try again in ${String(seconds)} seconds.`;
}

const limitNames = new WeakMap<FastifyInstance, Set<string>>();

/**
 * The key a limit counts `key` under. In Redis every limit's counts sit
 * side by side, so each limit has a name of its own, and one route's tries
 * never count against another's (ADR 0054).
 */
function namedKey(app: FastifyInstance, name: string, key: (request: FastifyRequest) => string) {
  const names = limitNames.get(app) ?? new Set<string>();
  if (names.has(name)) throw new Error(`Two rate limits are named ${name}`);
  names.add(name);
  limitNames.set(app, names);
  return (request: FastifyRequest) => `${name}:${key(request)}`;
}

/** The message of a 503 while the limits cannot count, as when Redis is away. */
export const cannotCount = "The server cannot count tries just now: try again in a minute.";

/**
 * Answers a limit whose store failed, as Redis away, with a 503: the route
 * is not let through unlimited, and the store's own message stays in the log.
 */
function storeFailed(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  request.log.error({ err: error }, "Could not count a try against a rate limit");
  return fail(reply.header("retry-after", "60"), 503, cannotCount);
}

/**
 * How many requests a limit allows in its window: a number, or a function
 * asked on each request, for a limit the security settings give (ADR 0084).
 */
export type LimitMax = number | (() => Promise<number>);

/** A hook that limits a route's requests from one client address, counted under `name`. */
export function limitByAddress(
  app: FastifyInstance,
  name: string,
  max: LimitMax,
  timeWindow: string,
) {
  const limit = app.rateLimit({
    max,
    timeWindow,
    keyGenerator: namedKey(app, name, (request) => normalizeIP(request.ip)),
  });
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await limit.call(app, request, reply);
    } catch (error) {
      // The plugin throws its own answer, a 429, when the limit is reached.
      if (typeof error === "object" && error !== null && "statusCode" in error) throw error;
      return storeFailed(request, reply, error);
    }
    return undefined;
  };
}

/**
 * A hook that applies a second limit to a route, by a key of its own, such
 * as the account a request names, counted under `name`. The rate-limit
 * plugin applies one limit to a request; this checks another beside it.
 */
export function limitBy(
  app: FastifyInstance,
  name: string,
  max: LimitMax,
  timeWindow: string,
  key: (request: FastifyRequest) => string,
) {
  const check = app.createRateLimit({ max, timeWindow, keyGenerator: namedKey(app, name, key) });
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let limit;
    try {
      limit = await check(request);
    } catch (error) {
      return storeFailed(request, reply, error);
    }
    if (limit.isAllowed || !limit.isExceeded) return undefined;
    return fail(
      reply.header("retry-after", String(limit.ttlInSeconds)),
      429,
      tooManyTries(limit.ttlInSeconds),
    );
  };
}
