// Failover with two processes (ADR 0082): two nodes of one server, each a
// process of its own with the `ha` module, share PostgreSQL and Valkey,
// behind small TCP proxies that send each connection to a node that is up,
// the laptop's preferring the first node and the phone's the second. Both
// devices edit a plain note through Hocuspocus and push to an encrypted one
// through the relay. The first node is killed with SIGKILL, then started
// again, and the second is stopped with SIGTERM; each time the devices
// reconnect through their proxies to the node left, and in the end every
// edit and every push has reached both devices and the database, none lost.
// It runs when NETHER_TEST_DATABASE_URL and NETHER_TEST_REDIS_URL name a
// PostgreSQL and a Valkey every process reaches, as CI's do; locally, with
// both in Docker. Windows ends a process at SIGTERM at once, so there the
// test does not ask that the second node drained.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { type Database, connectPostgres, readBytes } from "@nether/server/src/db.ts";
import { testRedisUrl } from "@nether/server/test/app.ts";
import { freePort } from "@nether/server/test/ports.ts";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

const databaseUrl = process.env.NETHER_TEST_DATABASE_URL ?? "";
const setupCode = "abcd-efgh-jkmn-pqrs";

/** What the test leaves behind if it fails partway: stopped in afterAll. */
const cleanups: (() => unknown)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Gone already.
    }
  }
});

async function until(what: string, check: () => boolean | Promise<boolean>, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A node of the server: a process running test/node.ts, on a port of its own. */
class Node {
  readonly #name: string;
  readonly port: number;
  readonly #env: NodeJS.ProcessEnv;
  #process: ChildProcess | undefined;
  /** The last lines it logged, to say what went wrong. */
  readonly lines: string[] = [];

  constructor(name: string, port: number, env: NodeJS.ProcessEnv) {
    this.#name = name;
    this.port = port;
    this.#env = env;
  }

  /** Starts the process, and resolves once it listens. */
  async start(): Promise<void> {
    const child = spawn(process.execPath, ["test/node.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...this.#env,
        NETHER_NODE_NAME: this.#name,
        NETHER_PORT: String(this.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#process = child;
    const keep = (line: string) => {
      this.lines.push(line);
      if (this.lines.length > 40) this.lines.shift();
    };
    createInterface({ input: child.stderr }).on("line", keep);
    await new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        keep(line);
        if (line.includes("Server listening at")) resolve();
      });
      child.once("exit", (code) => {
        reject(
          new Error(
            `${this.#name} exited with ${String(code)} before it listened:\n${this.lines.join("\n")}`,
          ),
        );
      });
    });
  }

  /** Sends the process `signal`, and resolves with its exit code once it ends. */
  async stop(signal: NodeJS.Signals): Promise<number | null> {
    const child = this.#process;
    if (child?.exitCode !== null || child.signalCode !== null) return null;
    const ended = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        resolve(code);
      });
    });
    child.kill(signal);
    return ended;
  }
}

/**
 * A TCP proxy that sends each connection to the first of `ports` that
 * answers, so a client's reconnection reaches a node that is up.
 */
async function proxy(ports: readonly number[]): Promise<number> {
  const open = new Set<Socket>();
  const server: Server = createServer((client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => client.destroy());
    client.pause();
    const reach = (index: number) => {
      const port = ports[index];
      if (port === undefined) {
        client.destroy();
        return;
      }
      const upstream = connect(port, "127.0.0.1");
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        open.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", () => {
        if (connected) client.destroy();
        else reach(index + 1);
      });
      upstream.on("close", () => {
        open.delete(upstream);
        if (connected) client.destroy();
      });
      client.on("close", () => upstream.destroy());
    };
    reach(0);
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  );
  return port;
}

/** A device's relay connection to an encrypted note: it pushes, and keeps what it hears and what is taken. */
class RelayDevice {
  readonly heard = new Set<string>();
  readonly taken = new Set<string>();
  readonly #pending = new Map<string, string>();
  readonly #url: string;
  readonly #token: string;
  readonly #name: string;
  #socket: WebSocket | undefined;
  #subscribed = false;
  #cursor = 0;
  #stopped = false;

  constructor(url: string, token: string, name: string) {
    this.#url = url;
    this.#token = token;
    this.#name = name;
    this.#connect();
    cleanups.push(() => {
      this.stop();
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    this.#subscribed = false;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: this.#token }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "ready") {
        socket.send(JSON.stringify({ type: "subscribe", name: this.#name, after: this.#cursor }));
      } else if (message.type === "updates") {
        for (const update of message.updates as { seq: number; data: string }[]) {
          this.heard.add(Buffer.from(update.data, "base64").toString("utf8"));
          this.#cursor = Math.max(this.#cursor, update.seq);
        }
      } else if (message.type === "subscribed") {
        this.#cursor = Math.max(this.#cursor, Number(message.seq));
        this.#subscribed = true;
        // What was pushed and never taken goes again.
        for (const [id, data] of this.#pending) this.#send(id, data);
      } else if (message.type === "pushed" && typeof message.id === "string") {
        const data = this.#pending.get(message.id);
        if (data === undefined) return;
        this.#pending.delete(message.id);
        this.taken.add(data);
        this.#cursor = Math.max(this.#cursor, Number(message.seq));
      }
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#subscribed = false;
      setTimeout(() => {
        this.#connect();
      }, 200);
    });
  }

  #send(id: string, data: string): void {
    if (!this.#subscribed || this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify({
        type: "push",
        id,
        name: this.#name,
        data: Buffer.from(data, "utf8").toString("base64"),
      }),
    );
  }

  push(data: string): void {
    const id = randomUUID();
    this.#pending.set(id, data);
    this.#send(id, data);
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.close();
  }
}

/** A device's Hocuspocus provider for the plain note, through its proxy. */
function syncDevice(url: string, name: string, token: string): HocuspocusProvider {
  const provider = new HocuspocusProvider({ url, name, token, document: new Y.Doc() });
  cleanups.push(() => {
    provider.destroy();
  });
  return provider;
}

const textOf = (provider: HocuspocusProvider) => provider.document.getText("content").toJSON();

function type(provider: HocuspocusProvider, words: string): void {
  const text = provider.document.getText("content");
  text.insert(text.length, ` ${words}`);
}

async function call(port: number, method: string, path: string, body?: unknown, token?: string) {
  const answer = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`${method} ${path}: ${String(answer.status)} ${text}`);
  return (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
}

describe.skipIf(databaseUrl === "" || testRedisUrl === "")("failover with two processes", () => {
  it("loses no edit and no push when a node is killed, and when one is stopped", async () => {
    // A schema of the test's own, and attachments in a folder both nodes share.
    const schema = `failover_${randomUUID().replaceAll("-", "")}`;
    const admin: Database = connectPostgres(databaseUrl);
    await admin.query(`CREATE SCHEMA ${schema}`);
    cleanups.push(async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    });
    const separator = databaseUrl.includes("?") ? "&" : "?";
    const url = `${databaseUrl}${separator}options=-c%20search_path%3D${schema}`;
    const db = connectPostgres(url);
    cleanups.push(() => db.close());
    const files = mkdtempSync(join(tmpdir(), "nether-failover-"));
    cleanups.push(() => {
      rmSync(files, { recursive: true, force: true });
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NETHER_HOST: "127.0.0.1",
      NETHER_DATABASE_URL: url,
      NETHER_REDIS_URL: testRedisUrl,
      NETHER_ENTERPRISE_HA: "on",
      NETHER_STORAGE_PATH: files,
      NETHER_STORAGE_SHARED: "on",
      NETHER_SETUP_CODE: setupCode,
      NETHER_DRAIN_SECONDS: "1",
      NETHER_WEB_APP: "off",
      NETHER_LOG_LEVEL: "info",
      NETHER_TEST_HA_PREFIX: `test-${randomUUID()}`,
    };
    const first = new Node("first", await freePort(), env);
    const second = new Node("second", await freePort(), env);
    cleanups.push(
      () => first.stop("SIGKILL"),
      () => second.stop("SIGKILL"),
    );
    // One after the other, so one migrates and the other finds it done.
    await first.start();
    await second.start();

    // Set up through the first node, and signed in on each device.
    const made = await call(first.port, "POST", "/api/setup", {
      code: setupCode,
      name: "Ada",
      email: "ada@example.org",
      password: "a long password",
      workspace: "Team",
    });
    const workspace = (made.workspace as { id: string }).id;
    const signIn = async (port: number) =>
      String(
        (
          await call(port, "POST", "/api/sessions", {
            email: "ada@example.org",
            password: "a long password",
          })
        ).token,
      );
    const laptopToken = await signIn(first.port);
    const phoneToken = await signIn(second.port);
    const b64 = (bytes: number) => randomBytes(bytes).toString("base64");
    await call(
      first.port,
      "PUT",
      "/api/me/keys",
      { publicKey: b64(32), recoveryBox: b64(73) },
      laptopToken,
    );
    const secret = await call(
      first.port,
      "POST",
      "/api/workspaces",
      { name: "Secret", encryption: "end-to-end", sealedKey: b64(80) },
      laptopToken,
    );
    const plain = `${workspace}/${randomUUID()}`;
    const encrypted = `${String(secret.id)}/${randomUUID()}`;

    // The laptop prefers the first node, the phone the second.
    const laptopPort = await proxy([first.port, second.port]);
    const phonePort = await proxy([second.port, first.port]);
    const laptop = syncDevice(`ws://127.0.0.1:${String(laptopPort)}/api/sync`, plain, laptopToken);
    const phone = syncDevice(`ws://127.0.0.1:${String(phonePort)}/api/sync`, plain, phoneToken);
    const laptopRelay = new RelayDevice(
      `ws://127.0.0.1:${String(laptopPort)}/api/relay`,
      laptopToken,
      encrypted,
    );
    const phoneRelay = new RelayDevice(
      `ws://127.0.0.1:${String(phonePort)}/api/relay`,
      phoneToken,
      encrypted,
    );
    await until("both devices to sync", () => laptop.isSynced && phone.isSynced);

    const edits: string[] = [];
    const pushes: string[] = [];
    const round = (n: number) => {
      for (const [device, relay, who] of [
        [laptop, laptopRelay, "laptop"],
        [phone, phoneRelay, "phone"],
      ] as const) {
        const words = `${who}-${String(n)}`;
        type(device, words);
        edits.push(words);
        relay.push(words);
        pushes.push(words);
      }
    };
    const everywhere = async (what: string) => {
      await until(`${what}: every edit on both devices`, () =>
        edits.every((words) => textOf(laptop).includes(words) && textOf(phone).includes(words)),
      );
      await until(`${what}: every push taken, and heard by the other device`, () =>
        pushes.every((words) => {
          const fromLaptop = words.startsWith("laptop");
          const pusher = fromLaptop ? laptopRelay : phoneRelay;
          const listener = fromLaptop ? phoneRelay : laptopRelay;
          return pusher.taken.has(words) && listener.heard.has(words);
        }),
      );
    };

    // Both nodes up: each device on its own node.
    round(1);
    await everywhere("both nodes up");

    // The first node killed while it holds the laptop's newest edit, not stored.
    round(2);
    await first.stop("SIGKILL");
    round(3);
    await everywhere("the first node killed");

    // The first node back, and the second stopped as Kubernetes stops a pod.
    await first.start();
    round(4);
    const stopped = second.stop("SIGTERM");
    round(5);
    const code = await stopped;
    // Drained and closed, its open documents stored, where SIGTERM is a signal.
    if (process.platform !== "win32") expect(code).toBe(0);
    await everywhere("the second node stopped");

    // And everything is in the database, stored by the node left.
    await until(
      "every edit stored",
      async () => {
        const { rows } = await db.query(
          "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
          [workspace, plain.slice(workspace.length + 1)],
        );
        if (rows[0] === undefined) return false;
        const document = new Y.Doc();
        Y.applyUpdate(document, readBytes(rows[0], "state"));
        const text = document.getText("content").toJSON();
        return edits.every((words) => text.includes(words));
      },
      30,
    );
    const { rows } = await db.query("SELECT data FROM encrypted_updates WHERE workspace_id = $1", [
      String(secret.id),
    ]);
    const kept = new Set(rows.map((row) => Buffer.from(readBytes(row, "data")).toString("utf8")));
    expect(pushes.filter((words) => !kept.has(words))).toEqual([]);
    const last = await first.stop("SIGTERM");
    if (process.platform !== "win32") expect(last).toBe(0);
  }, 240_000);
});
