// High availability (ADR 0082). Without Valkey: what a deployment of
// several nodes must have, and the extension's connection read from
// NETHER_REDIS_URL. With Valkey, as CI gives one in NETHER_TEST_REDIS_URL:
// the bus between nodes, and two nodes of one server in this process, each
// with the `ha` module, sharing a database and Valkey: an edit on one
// reaches a client of the other before it is stored, the API of one reads
// the other's open copy, a push through one reaches the other's relay
// subscriber at once, and a member removed through one is closed out of
// the other.
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { readConfig } from "@nether/server/src/config.ts";
import type { Database } from "@nether/server/src/db.ts";
import { readBytes } from "@nether/server/src/db.ts";
import { documentNote, parseNote, writeNote } from "@nether/server/src/markdown.ts";
import { migrate } from "@nether/server/src/migrations.ts";
import { connectRedis } from "@nether/server/src/redis.ts";
import {
  type SetUp,
  type TestServer,
  bearer,
  setUp,
  signIn,
  startServer,
  testRedisUrl,
} from "@nether/server/test/app.ts";
import { testDatabase } from "@nether/server/test/database.ts";
import { freePort } from "@nether/server/test/ports.ts";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ValkeyBus } from "../src/bus.ts";
import { extensionConnection, highAvailability, missing } from "../src/index.ts";

const running: TestServer[] = [];
const providers: HocuspocusProvider[] = [];
const sockets: WebSocket[] = [];
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const socket of sockets.splice(0)) socket.close();
  for (const close of closing.splice(0)) await close();
  // The second node first: the first closes the database they share.
  for (const node of running.splice(0).reverse()) await node.close();
});

const quiet = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  silent: () => undefined,
  level: "silent",
  child: () => quiet,
} as unknown as FastifyBaseLogger;

async function until(check: () => boolean | Promise<boolean>, seconds = 10): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("a deployment of several nodes", () => {
  const base = { NETHER_DATABASE_URL: "postgres://nether@localhost:5432/nether" };

  it("needs Valkey, attachments every node reads, and one setup code before the first account", async () => {
    const db: Database = await testDatabase();
    closing.push(() => db.close());
    await migrate(db);
    expect(await missing(db, readConfig(base))).toEqual([
      "NETHER_REDIS_URL, the Valkey every node shares",
      "attachments every node reads: NETHER_STORAGE=s3, or NETHER_STORAGE_SHARED=on when NETHER_STORAGE_PATH is one volume every node mounts",
      "NETHER_SETUP_CODE while the server has no account, so every node takes one code",
    ]);
    const ready = readConfig({
      ...base,
      NETHER_REDIS_URL: "redis://valkey:6379",
      NETHER_STORAGE_SHARED: "on",
      NETHER_SETUP_CODE: "abcd-efgh-jkmn-pqrs",
    });
    expect(await missing(db, ready)).toEqual([]);
    await expect(
      highAvailability().startup?.({ db, config: readConfig(base), log: quiet }),
    ).rejects.toThrow("NETHER_ENTERPRISE_HA is on, and several nodes need NETHER_REDIS_URL");
  });

  it("gives the extension the address NETHER_REDIS_URL names", () => {
    expect(extensionConnection("redis://valkey:6379")).toEqual({
      host: "valkey",
      port: 6379,
      options: {},
    });
    expect(extensionConnection("rediss://nether:p%40ss@[::1]:6380/2")).toEqual({
      host: "::1",
      port: 6380,
      options: { username: "nether", password: "p@ss", db: 2, tls: {} },
    });
  });
});

const withValkey = testRedisUrl !== "";

describe.skipIf(!withValkey)("the bus over Valkey", () => {
  it("carries a topic's hints to every bus subscribed, and says when it is back", async () => {
    const prefix = `test-${randomUUID()}:bus:`;
    const one = await ValkeyBus.connect(testRedisUrl, prefix, quiet);
    const two = await ValkeyBus.connect(testRedisUrl, prefix, quiet);
    closing.push(
      () => one.close(),
      () => two.close(),
    );
    const heard: string[] = [];
    two.subscribe("relay.a", (message) => heard.push(message));
    // Subscribed before the first hint.
    await new Promise((resolve) => setTimeout(resolve, 100));
    one.publish("relay.a", "hint");
    one.publish("relay.b", "elsewhere");
    await until(() => heard.length > 0);
    expect(heard).toEqual(["hint"]);

    let back = 0;
    two.onReconnect(() => back++);
    // Its subscribing connection cut, as a network or a Valkey restart does.
    const admin = await connectRedis(testRedisUrl);
    closing.push(async () => {
      await admin.quit();
    });
    const clients = String(await admin.call("CLIENT", "LIST"));
    const ids = clients
      .split("\n")
      .filter((line) => line.includes(`name=${prefix}subscriber`))
      .map((line) => /\bid=(\d+)/.exec(line)?.[1] ?? "");
    expect(ids).toHaveLength(2);
    for (const id of ids) await admin.call("CLIENT", "KILL", "ID", id);
    await until(() => back === 1);
    // And it hears again, subscribed anew.
    heard.length = 0;
    await until(async () => {
      one.publish("relay.a", "again");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return heard.includes("again");
    });
  });
});

/** Two nodes of one server, each with the `ha` module, over one database and one Valkey. */
async function cluster() {
  const module = highAvailability({ prefix: `test-${randomUUID()}` });
  const env = {
    NETHER_ENTERPRISE_HA: "on",
    NETHER_REDIS_URL: testRedisUrl,
    NETHER_STORAGE_SHARED: "on",
    NETHER_SETUP_CODE: "abcd-efgh-jkmn-pqrs",
  };
  const first = await startServer({ env, enterpriseModules: [module] });
  running.push(first);
  const setup: SetUp = await setUp(first);
  const second = await startServer({ env, enterpriseModules: [module], nodeOf: first });
  running.push(second);
  const urls: string[] = [];
  for (const node of [first, second]) {
    await node.server.listen({ host: "127.0.0.1", port: await freePort() });
    urls.push(`127.0.0.1:${String((node.server.server.address() as AddressInfo).port)}`);
  }
  const token = (await signIn(second.server, "ada@example.org", "a long password")).json<{
    token: string;
  }>().token;
  return { first, second, setup, token, urls: urls as [string, string] };
}

function connect(host: string, name: string, token: string): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url: `ws://${host}/api/sync`,
      name,
      token,
      document: new Y.Doc(),
      onSynced: () => {
        resolve(provider);
      },
      onAuthenticationFailed: ({ reason }) => {
        reject(new Error(reason));
      },
    });
    providers.push(provider);
  });
}

/** The note as the database holds it, or undefined before it is stored. */
async function stored(db: Database, workspace: string, note: string): Promise<Y.Doc | undefined> {
  const { rows } = await db.query(
    "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
    [workspace, note],
  );
  if (rows[0] === undefined) return undefined;
  const document = new Y.Doc();
  Y.applyUpdate(document, readBytes(rows[0], "state"));
  return document;
}

describe.skipIf(!withValkey)("two nodes over Valkey", () => {
  it("bring an edit on one to a client of the other before it is stored", async () => {
    const { first, setup, token, urls } = await cluster();
    const note = randomUUID();
    const name = `${setup.workspaceId}/${note}`;
    const laptop = await connect(urls[0], name, setup.token);
    const phone = await connect(urls[1], name, token);
    laptop.document.getText("content").insert(0, "Seen on the other node.");
    await until(
      () => phone.document.getText("content").toJSON() === "Seen on the other node.",
      1.5,
    );
    // Not stored yet: it came through Valkey, not the database.
    const kept = await stored(first.db, setup.workspaceId, note);
    expect(kept?.getText("content").toJSON() ?? "").not.toContain("other node");
  }, 30_000);

  it("read through the API the other node's open copy, not what is stored", async () => {
    const { first, second, setup, urls } = await cluster();
    const made = await first.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(setup.token),
      payload: { name: "Script", access: "write", password: "a long password" },
    });
    const secret = made.json<{ token: string }>().token;
    const created = await first.server.inject({
      method: "POST",
      url: `/api/v1/workspaces/${setup.workspaceId}/notes`,
      headers: bearer(secret),
      payload: { path: "Plans.md", markdown: "Stored first.\n" },
    });
    expect(created.statusCode).toBe(201);
    const note = created.json<{ id: string }>().id;
    const laptop = await connect(urls[0], `${setup.workspaceId}/${note}`, setup.token);
    const parsed = parseNote("Typed, not stored yet.\n");
    if ("error" in parsed) throw new Error(parsed.error);
    writeNote(laptop.document, parsed);
    const read = () =>
      second.server.inject({
        method: "GET",
        url: `/api/v1/workspaces/${setup.workspaceId}/notes/${note}`,
        headers: { ...bearer(secret), accept: "text/markdown" },
      });
    await until(async () => (await read()).body.includes("Typed, not stored yet."), 1.5);
    const kept = await stored(first.db, setup.workspaceId, note);
    expect(kept === undefined ? "" : documentNote(kept).markdown).not.toContain("Typed");
  }, 30_000);

  it("send a push through one to the other's relay subscriber at once", async () => {
    const { first, setup, token, urls } = await cluster();
    const b64 = (bytes: number) => randomBytes(bytes).toString("base64");
    await first.server.inject({
      method: "PUT",
      url: "/api/me/keys",
      headers: bearer(setup.token),
      payload: { publicKey: b64(32), recoveryBox: b64(73) },
    });
    const secret = await first.server.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(setup.token),
      payload: { name: "Secret", encryption: "end-to-end", sealedKey: b64(80) },
    });
    const name = `${secret.json<{ id: string }>().id}/${randomUUID()}`;
    const open = async (host: string, as: string) => {
      const socket = new WebSocket(`ws://${host}/api/relay`);
      sockets.push(socket);
      const received: Record<string, unknown>[] = [];
      socket.addEventListener("message", (event) => {
        received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", token: as }));
      });
      await until(() => received.some((message) => message.type === "ready"));
      socket.send(JSON.stringify({ type: "subscribe", name }));
      await until(() => received.some((message) => message.type === "subscribed"));
      return { socket, received };
    };
    const laptop = await open(urls[0], setup.token);
    const phone = await open(urls[1], token);
    const sent = Date.now();
    laptop.socket.send(JSON.stringify({ type: "push", id: "1", name, data: "AAEC" }));
    // Within a second, on the bus's hint, not at the next of the reads every five seconds.
    await until(
      () =>
        phone.received.some(
          (message) =>
            message.type === "updates" &&
            (message.updates as { data: string }[]).some((update) => update.data === "AAEC"),
        ),
      1,
    );
    expect(Date.now() - sent).toBeLessThan(1_000);
  }, 30_000);

  it("close a removed member's sockets on the node that did not remove them", async () => {
    const { first, setup, urls } = await cluster();
    const invited = await first.server.inject({
      method: "POST",
      url: `/api/workspaces/${setup.workspaceId}/invitations`,
      headers: bearer(setup.token),
      payload: { role: "member" },
    });
    const accepted = await first.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invited.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "Bea's long password",
      },
    });
    const bea = accepted.json<{ token: string; user: { id: string } }>();
    const relay = new WebSocket(`ws://${urls[1]}/api/relay`);
    sockets.push(relay);
    await new Promise<void>((resolve) => {
      relay.addEventListener("open", () => {
        relay.send(JSON.stringify({ type: "auth", token: bea.token }));
      });
      relay.addEventListener("message", () => {
        resolve();
      });
    });
    const closed = new Promise<number>((resolve) => {
      relay.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    const removed = await first.server.inject({
      method: "DELETE",
      url: `/api/workspaces/${setup.workspaceId}/members/${bea.user.id}`,
      headers: bearer(setup.token),
    });
    expect(removed.statusCode).toBe(204);
    expect(await closed).toBe(4403);
  }, 30_000);
});
