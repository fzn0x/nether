// Closing an account's sockets on every node (ADR 0082): the node that is
// asked closes its own at once and tells the others through the bus, fire
// and forget.
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type ClusterBus, ProcessBus, shareDisconnects } from "../src/cluster.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";
import { freePort } from "./ports.ts";

const running: TestServer[] = [];
const providers: HocuspocusProvider[] = [];
const sockets: WebSocket[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const provider of providers.splice(0)) provider.destroy();
  for (const socket of sockets.splice(0)) socket.close();
  // The second node first: the first closes the database they share.
  for (const node of running.splice(0).reverse()) await node.close();
});

/** A log that keeps what is said, by level. */
function logOf() {
  const said: { level: string; details: unknown; message: string }[] = [];
  const at =
    (level: string) =>
    (details: unknown, message = "") => {
      said.push({ level, details, message });
    };
  const log = {
    said,
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
    trace: at("trace"),
    fatal: at("fatal"),
    silent: () => undefined,
    level: "info",
    child: () => log,
  };
  return log as typeof log & FastifyBaseLogger;
}

/** A socket that says when and how it was closed. */
function socketOf(user: string) {
  const socket = {
    user,
    closed: [] as { code: number; at: number }[],
    close(code: number) {
      socket.closed.push({ code, at: performance.now() });
    },
  };
  return socket;
}

/** A node's sockets, as `shareDisconnects` sees them. */
function nodeOf(open: ReturnType<typeof socketOf>[]) {
  return {
    disconnect(userId: string) {
      for (const socket of open) if (socket.user === userId) socket.close(4403);
    },
  };
}

async function until(check: () => boolean, seconds = 10): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("closing an account's sockets on every node", () => {
  it("closes this node's at once and the other node's on its hint, each once", async () => {
    const bus = new ProcessBus();
    const here = [socketOf("bea"), socketOf("cy")];
    const there = [socketOf("bea"), socketOf("cy")];
    const first = shareDisconnects(bus, "one", nodeOf(here), logOf());
    const second = shareDisconnects(bus, "two", nodeOf(there), logOf());
    stops.push(first.stop, second.stop);
    first.disconnect("bea");
    // Closed here before the call returns; there, once the hint arrives.
    expect(here[0]?.closed.map((close) => close.code)).toEqual([4403]);
    await until(() => (there[0]?.closed.length ?? 0) > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(here[0]?.closed).toHaveLength(1);
    expect(there[0]?.closed.map((close) => close.code)).toEqual([4403]);
    expect([here[1]?.closed, there[1]?.closed]).toEqual([[], []]);
  });

  it("closes this node's when the bus cannot send, and says so", () => {
    const log = logOf();
    const broken = new ProcessBus();
    broken.publish = () => {
      throw new Error("The bus is away");
    };
    const here = [socketOf("bea")];
    const node = shareDisconnects(broken, "one", nodeOf(here), log);
    stops.push(node.stop);
    expect(() => {
      node.disconnect("bea");
    }).not.toThrow();
    expect(here[0]?.closed).toHaveLength(1);
    expect(log.said.filter((entry) => entry.level === "error")).toHaveLength(1);
  });
});

/** Two nodes over one database and one bus, set up, with Bea a member of the workspace. */
async function cluster(bus: ClusterBus) {
  const first = await startServer({ bus });
  running.push(first);
  const setup: SetUp = await setUp(first);
  const second = await startServer({ bus, nodeOf: first });
  running.push(second);
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
  await second.server.listen({ host: "127.0.0.1", port: await freePort() });
  const port = String((second.server.server.address() as AddressInfo).port);
  return { first, second, setup, bea: { token: bea.token, id: bea.user.id }, port };
}

/** Bea's apps on the second node: the vault synced, and a relay socket signed in. */
async function beaOn(port: string, workspace: string, token: string) {
  const sync = { synced: 0, refused: undefined as string | undefined };
  await new Promise<void>((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/api/sync`,
      name: `${workspace}/vault`,
      token,
      document: new Y.Doc(),
      onSynced: () => {
        sync.synced++;
        resolve();
      },
      onAuthenticationFailed: ({ reason }) => {
        sync.refused = reason;
        reject(new Error(reason));
      },
    });
    providers.push(provider);
  });
  const relay = new WebSocket(`ws://127.0.0.1:${port}/api/relay`);
  sockets.push(relay);
  await new Promise<void>((resolve) => {
    relay.addEventListener("open", () => {
      relay.send(JSON.stringify({ type: "auth", token }));
    });
    relay.addEventListener("message", () => {
      resolve();
    });
  });
  const relayClosed = new Promise<number>((resolve) => {
    relay.addEventListener("close", (event) => {
      resolve(event.code);
    });
  });
  return { sync, relayClosed };
}

describe("two nodes", () => {
  it("close a removed member's sync and relay sockets on the node that did not remove them", async () => {
    const { first, setup, bea, port } = await cluster(new ProcessBus());
    const apps = await beaOn(port, setup.workspaceId, bea.token);
    const removed = await first.server.inject({
      method: "DELETE",
      url: `/api/workspaces/${setup.workspaceId}/members/${bea.id}`,
      headers: bearer(setup.token),
    });
    expect(removed.statusCode).toBe(204);
    expect(await apps.relayClosed).toBe(4403);
    // The sync app connects again, and is refused.
    await until(() => apps.sync.refused !== undefined);
  }, 30_000);
});
