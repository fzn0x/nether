// The rate limits: each counts on its own, in memory or in Redis, and nodes
// sharing a Redis or Valkey count together (ADR 0054). CI runs every server
// test with NETHER_TEST_REDIS_URL set; the tests of several nodes need it.
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { cannotCount, limitBy, limitByAddress } from "../src/http.ts";
import { connectRedis, redactedUrl } from "../src/redis.ts";
import { freePort } from "./ports.ts";
import { type TestServer, signIn, setUp, startServer, testRedis, testRedisUrl } from "./app.ts";

const running: TestServer[] = [];
const clients: Redis[] = [];

afterEach(async () => {
  for (const test of running.splice(0)) await test.close();
  for (const client of clients.splice(0)) await client.quit();
});

async function start(redis?: Redis): Promise<TestServer> {
  const test = await startServer(redis === undefined ? {} : { redis });
  running.push(test);
  return test;
}

describe("rate limits", () => {
  it("count each route's tries on their own, from one address", async () => {
    const test = await start();
    // Setup's try, and then 30 to sign in, as many as that limit allows.
    await setUp(test);
    for (let attempt = 0; attempt < 30; attempt++) {
      const email = `guess${String(attempt)}@example.org`;
      expect((await signIn(test.server, email, "a guess")).statusCode).toBe(401);
    }
    expect((await signIn(test.server, "eve@example.org", "a guess")).statusCode).toBe(429);
    // Another route's limit by address still has all of its tries.
    const lookup = await test.server.inject({
      method: "POST",
      url: "/api/invitations/lookup",
      payload: { token: "not an invitation" },
    });
    expect(lookup.statusCode).toBe(404);
  });

  it("refuse two limits of one name", async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    limitByAddress(app, "sign-in", 30, "5 minutes");
    expect(() => limitBy(app, "sign-in", 10, "15 minutes", () => "key")).toThrow(
      "Two rate limits are named sign-in",
    );
    // Another server may use the name again.
    const other = Fastify();
    await other.register(rateLimit, { global: false });
    expect(() => limitByAddress(other, "sign-in", 30, "5 minutes")).not.toThrow();
    await app.close();
    await other.close();
  });

  it.skipIf(testRedisUrl === "")(
    "count together on nodes that share a Redis or Valkey",
    async () => {
      const deployment = `nodes-${String(Date.now())}`;
      const connect = async () => {
        const client = await testRedis(deployment);
        if (client === undefined) throw new Error("NETHER_TEST_REDIS_URL is not set");
        clients.push(client);
        return client;
      };
      const one = await start(await connect());
      const two = await start(await connect());
      // Ten wrong passwords for one account, five on each node.
      for (let attempt = 0; attempt < 10; attempt++) {
        const node = attempt % 2 === 0 ? one : two;
        expect((await signIn(node.server, "ada@example.org", "a guess")).statusCode).toBe(401);
      }
      const limited = await signIn(one.server, "ADA@example.org", "a guess");
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(780);
      expect((await signIn(two.server, "ada@example.org", "a guess")).statusCode).toBe(429);

      // The counts are in Redis, under the deployment's prefix and each limit's name.
      const keys = await clients[0]?.keys("*");
      expect(keys?.some((key) => key.includes("sign-in-account:ada@example.org"))).toBe(true);
    },
  );
});

describe("rate limits whose Redis is away", () => {
  it("answer 503, neither letting the route through nor saying why", async () => {
    // A client that never connects, whose every command fails at once.
    const away = new Redis(`redis://127.0.0.1:${String(await freePort())}`, {
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    const app = Fastify();
    await app.register(rateLimit, { global: false, redis: away });
    let reached = 0;
    const handler = () => {
      reached += 1;
      return { ok: true };
    };
    app.get("/by-address", { onRequest: limitByAddress(app, "address", 5, "1 minute") }, handler);
    app.get("/by-key", { preHandler: limitBy(app, "key", 5, "1 minute", () => "k") }, handler);
    for (const url of ["/by-address", "/by-key"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("60");
      expect(response.json()).toEqual({
        statusCode: 503,
        error: "Service Unavailable",
        message: cannotCount,
      });
    }
    expect(reached).toBe(0);
    await app.close();
    away.disconnect();
  });
});

describe("connecting to Redis or Valkey", () => {
  it("names the address, its password hidden, when nothing answers there", async () => {
    const url = `redis://:a-secret@127.0.0.1:${String(await freePort())}`;
    const failure = connectRedis(url);
    await expect(failure).rejects.toThrow(/^Could not reach Redis or Valkey at redis:\/\//);
    await expect(failure).rejects.toThrow(/ECONNREFUSED/);
    await expect(failure).rejects.not.toThrow(/a-secret/);
  });

  it("hides the password in the address it logs", () => {
    expect(redactedUrl("rediss://nether:a-secret@cache.example.org:6380/2")).toBe(
      "rediss://nether:hidden@cache.example.org:6380/2",
    );
    expect(redactedUrl("redis://valkey:6379")).toBe("redis://valkey:6379");
  });
});
