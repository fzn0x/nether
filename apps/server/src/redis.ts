// The Redis or Valkey server the rate limits keep their counts in
// (ADR 0054), so that a restart forgets none of them and several nodes
// count together.
import type { FastifyBaseLogger } from "fastify";
import { Redis } from "ioredis";

/** The address with its password hidden, for messages and the log. */
export function redactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "hidden";
    return parsed.toString();
  } catch {
    return "the address NETHER_REDIS_URL names";
  }
}

/**
 * Connects to the server at `url` and checks that it answers. `keyPrefix`
 * goes before every key, as tests use to keep theirs apart.
 */
export async function connectRedis(
  url: string,
  options: { keyPrefix?: string } = {},
): Promise<Redis> {
  const client = new Redis(url, {
    lazyConnect: true,
    // A limit asks once and fails fast, as @fastify/rate-limit advises,
    // rather than holding a sign-in while the server is away.
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    ...options,
  });
  let reason: Error | undefined;
  const remember = (error: Error) => {
    reason = error;
  };
  client.on("error", remember);
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    client.disconnect();
    const why = reason ?? (error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Could not reach Redis or Valkey at ${redactedUrl(url)}: ${why.message}`, {
      cause: error,
    });
  } finally {
    client.off("error", remember);
  }
  return client;
}

/**
 * Logs when the connection is lost and when it is back, once each: the
 * client tries again on its own, and limits fail while it is away.
 */
export function watchRedis(client: Redis, log: FastifyBaseLogger): void {
  let reachable = true;
  client.on("error", (error: Error) => {
    if (!reachable) return;
    reachable = false;
    log.error(
      { err: error },
      "Lost Redis or Valkey: routes with a rate limit fail until it is back",
    );
  });
  client.on("ready", () => {
    if (reachable) return;
    reachable = true;
    log.info("Reached Redis or Valkey again");
  });
}
