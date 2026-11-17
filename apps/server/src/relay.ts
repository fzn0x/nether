// The relay of end-to-end encrypted workspaces (ADR 0038). Their clients
// encrypt every update, so the server cannot merge them as Hocuspocus
// does: it keeps each in order, numbered from the documents' sequence, and
// sends it to the document's other subscribers. A socket signs in with its
// session's token; then, in JSON with data in base64:
//
//   { type: "subscribe", name, after }  ->  { type: "updates", name, updates: [{ seq, data }] }…,
//                                           { type: "subscribed", name, seq }
//   { type: "push", id, name, data }    ->  { type: "pushed", id, seq }
//   { type: "compact", id, name, through, data }  ->  { type: "compacted", id }
//   { type: "unsubscribe", name }
//
// Each update a subscriber missed while subscribing waits until the ones
// stored before it are sent, so a subscriber's numbers only grow. Pushing a
// note tells the vault document's subscribers, as { type: "stored", document, seq }.
//
// The database gives the relay its order (ADR 0082). A workspace's updates
// are numbered in the order they commit, so this node reads each workspace
// it has subscribers in after the last number it read, in order, and sends
// what it reads to its own subscribers: when it stores a push, when the bus
// hints that another node did, when a socket subscribes, and every few
// seconds. A pusher is told its number once this node has read past it, so
// it has been sent every update of the document numbered before it, and
// keeps that number as how far it has read. Answered as stored, two pushes
// could be told out of order, and a client would read past the one told
// last, never to be sent it (#174).
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Closable, ClusterBus, Unsubscribe } from "./cluster.ts";
import { type Database, readBytes, readCount, readText } from "./db.ts";
import { socketCookieToken } from "./cookies.ts";
import { lockNumbers } from "./numbers.ts";
import { sessionAccount } from "./sessions.ts";
import { parseDocumentName } from "./sync.ts";
import { base64Bytes } from "./workspaces.ts";
import { type Permissions, generalLevel, placeOf } from "./places.ts";
import { writesAt } from "./units.ts";

/** The most updates one message carries. */
const batch = 500;
/** An update's largest size, as Hocuspocus allows: 16 MiB. */
const largest = 16 * 1024 * 1024;
/** How often a node reads each workspace it has subscribers in, hints or none. */
const readEvery = 5_000;
/** How long a node waits to read again after a read failed. */
const retryAfter = 1_000;

interface Subscription {
  /** Whether the updates stored before it began have been sent. */
  ready: boolean;
  /** Updates read meanwhile, sent once it is ready. */
  readonly waiting: { seq: number; data: string }[];
}

interface Client {
  readonly socket: WebSocket;
  userId: string | undefined;
  readonly subscriptions: Map<string, Subscription>;
}

/** A workspace's updates as this node reads them, in order, for its own subscribers. */
interface Reader {
  /** The last number read. */
  watermark: number;
  /** The read under way, if one is. */
  reading: Promise<void> | undefined;
  /** Whether another read was asked for while one was under way. */
  again: boolean;
  /** Pushes waiting to be told their numbers, until this node has read past them. */
  readonly waiters: { readonly seq: number; readonly resolve: () => void }[];
  readonly unsubscribe: Unsubscribe;
}

type Message = Readonly<Record<string, unknown>>;

/** What the rest of the server asks of the relay. */
export interface RelayControl {
  /** Closes an account's sockets, so its apps connect again and are checked anew. */
  disconnect(userId: string): void;
  /** Every socket of the relay here. */
  sockets(): Iterable<Closable>;
}

/** The bus's topic for a workspace's encrypted updates: a hint that there are new ones to read. */
function topicOf(workspace: string): string {
  return `relay.${workspace}`;
}

export function registerRelay(
  app: FastifyInstance,
  db: Database,
  bus: ClusterBus,
  permissions: Permissions,
): RelayControl {
  /** Each document's subscribers. */
  const subscribers = new Map<string, Set<Client>>();
  const clients = new Set<Client>();
  /** How many subscriptions this node has in each workspace. */
  const subscribed = new Map<string, number>();
  /** Each workspace's reader, made as it gains its first subscription here. */
  const readers = new Map<string, Promise<Reader>>();
  /** Which socket here pushed each number not yet read: it is not sent its own update back. */
  const pushedBy = new Map<number, Client>();
  /** This node, which hears its own hints and passes them over. */
  const node = randomUUID();

  function send(client: Client, message: object): void {
    if (client.socket.readyState === client.socket.OPEN)
      client.socket.send(JSON.stringify(message));
  }

  function refuse(client: Client, id: unknown, message: string): void {
    send(client, { type: "error", ...(typeof id === "string" ? { id } : {}), message });
  }

  /** Sends an update to a document's subscribers but one, as each is ready for it. */
  function relay(name: string, update: { seq: number; data: string }, except?: Client): void {
    for (const client of subscribers.get(name) ?? []) {
      if (client === except) continue;
      const subscription = client.subscriptions.get(name);
      if (subscription === undefined) continue;
      if (subscription.ready) send(client, { type: "updates", name, updates: [update] });
      else subscription.waiting.push(update);
    }
  }

  /** Sends an update read to this node's subscribers, and tells of a note's to the vault's. */
  function deliver(workspace: string, document: string, seq: number, data: Uint8Array): void {
    const pusher = pushedBy.get(seq);
    pushedBy.delete(seq);
    relay(`${workspace}/${document}`, { seq, data: Buffer.from(data).toString("base64") }, pusher);
    if (document === "vault") return;
    for (const listener of subscribers.get(`${workspace}/vault`) ?? []) {
      if (listener !== pusher) send(listener, { type: "stored", document, seq });
    }
  }

  /** Whether a read was asked for while one went on; read anew after each wait. */
  function askedAgain(reader: Reader): boolean {
    return reader.again;
  }

  /** Reads a workspace's updates after the reader's last number, in order, and sends them on. */
  function read(workspace: string, reader: Reader): Promise<void> {
    if (reader.reading !== undefined) {
      reader.again = true;
      return reader.reading;
    }
    const reading = (async () => {
      try {
        do {
          reader.again = false;
          for (;;) {
            const { rows } = await db.query(
              `SELECT name, seq, data FROM encrypted_updates
                WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
              [workspace, reader.watermark, batch],
            );
            for (const row of rows) {
              const seq = readCount(row, "seq");
              deliver(workspace, readText(row, "name"), seq, readBytes(row, "data"));
              reader.watermark = seq;
            }
            for (const waiter of reader.waiters.filter((each) => each.seq <= reader.watermark)) {
              reader.waiters.splice(reader.waiters.indexOf(waiter), 1);
              waiter.resolve();
            }
            if (rows.length < batch) break;
          }
        } while (askedAgain(reader));
      } finally {
        // Cleared as it ends, so a read asked for from here on starts anew.
        reader.reading = undefined;
      }
    })();
    reader.reading = reading;
    reading.catch((error: unknown) => {
      app.log.error({ err: error }, "The relay could not read a workspace's updates");
      // Pushes wait on it: read again in a moment.
      setTimeout(() => {
        read(workspace, reader).catch(() => undefined);
      }, retryAfter).unref();
    });
    return reading;
  }

  /** The workspace's reader, made from the last number stored when this node has none. */
  function readerOf(workspace: string): Promise<Reader> {
    let made = readers.get(workspace);
    if (made === undefined) {
      made = (async () => {
        const { rows } = await db.query(
          "SELECT coalesce(max(seq), 0) AS seq FROM encrypted_updates WHERE workspace_id = $1",
          [workspace],
        );
        const reader: Reader = {
          watermark: readCount(rows[0], "seq"),
          reading: undefined,
          again: false,
          waiters: [],
          unsubscribe: bus.subscribe(topicOf(workspace), (message) => {
            if (message !== node) read(workspace, reader).catch(() => undefined);
          }),
        };
        return reader;
      })();
      readers.set(workspace, made);
      const kept = made;
      kept.catch(() => {
        if (readers.get(workspace) === kept) readers.delete(workspace);
      });
    }
    return made;
  }

  /** A client's subscription to a document ends; its workspace's reader goes with its last. */
  function leave(client: Client, name: string): void {
    if (!client.subscriptions.delete(name)) return;
    const listeners = subscribers.get(name);
    listeners?.delete(client);
    if (listeners?.size === 0) subscribers.delete(name);
    const workspace = parseDocumentName(name)?.workspaceId;
    if (workspace === undefined) return;
    const left = (subscribed.get(workspace) ?? 1) - 1;
    if (left > 0) {
      subscribed.set(workspace, left);
      return;
    }
    subscribed.delete(workspace);
    const made = readers.get(workspace);
    readers.delete(workspace);
    made
      ?.then((reader) => {
        reader.unsubscribe();
        // No one here is left to send to: what waited is told at once.
        for (const waiter of reader.waiters.splice(0)) waiter.resolve();
      })
      .catch(() => undefined);
  }

  // Each workspace read every few seconds, for any hint lost on the way.
  const timer = setInterval(() => {
    for (const [workspace, made] of readers) {
      made.then((reader) => read(workspace, reader)).catch(() => undefined);
    }
  }, readEvery);
  timer.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(timer);
    done();
  });

  /** The account's place in a document's workspace, if the document is an encrypted workspace's. */
  async function place(client: Client, name: unknown) {
    if (client.userId === undefined || typeof name !== "string") return undefined;
    const parsed = parseDocumentName(name);
    if (parsed === undefined) return undefined;
    const found = await placeOf(db, permissions, client.userId, parsed.workspaceId);
    if (found?.encryption !== "end-to-end") return undefined;
    return { ...found, ...parsed };
  }

  const refused = "Sign in, as a member of this document's encrypted workspace.";

  async function subscribe(client: Client, message: Message): Promise<void> {
    const { name } = message;
    const after = typeof message.after === "number" && message.after >= 0 ? message.after : 0;
    const found = await place(client, name);
    if (found === undefined || typeof name !== "string") {
      // Named, so the client knows which of its subscriptions failed.
      send(client, {
        type: "error",
        ...(typeof name === "string" ? { name } : {}),
        message: refused,
      });
      return;
    }
    // Subscribed first, so nothing stored while the stored updates are read is lost.
    leave(client, name);
    const subscription: Subscription = { ready: false, waiting: [] };
    client.subscriptions.set(name, subscription);
    let listeners = subscribers.get(name);
    if (listeners === undefined) {
      listeners = new Set();
      subscribers.set(name, listeners);
    }
    listeners.add(client);
    subscribed.set(found.workspaceId, (subscribed.get(found.workspaceId) ?? 0) + 1);
    // The reader sends what is stored from here on; what was before, this reads.
    await readerOf(found.workspaceId);
    let last = after;
    for (;;) {
      const { rows } = await db.query(
        `SELECT seq, data FROM encrypted_updates WHERE workspace_id = $1 AND name = $2 AND seq > $3
          ORDER BY seq LIMIT $4`,
        [found.workspaceId, found.document, last, batch],
      );
      if (rows.length === 0) break;
      const updates = rows.map((row) => ({
        seq: readCount(row, "seq"),
        data: Buffer.from(readBytes(row, "data")).toString("base64"),
      }));
      last = updates[updates.length - 1]?.seq ?? last;
      send(client, { type: "updates", name, updates });
      if (rows.length < batch) break;
    }
    const later = subscription.waiting.splice(0).filter((update) => update.seq > last);
    if (later.length > 0) send(client, { type: "updates", name, updates: later });
    subscription.ready = true;
    send(client, { type: "subscribed", name, seq: Math.max(last, ...later.map((u) => u.seq)) });
  }

  async function push(client: Client, message: Message): Promise<void> {
    const { id, name } = message;
    const found = await place(client, name);
    if (found === undefined || typeof name !== "string") {
      refuse(client, id, refused);
      return;
    }
    // An encrypted workspace is General alone: its role writes there at edit or more (ADR 0089).
    if (!writesAt(generalLevel(found.settings))) {
      refuse(client, id, "Your role reads this workspace, and does not change it.");
      return;
    }
    const data = typeof message.data === "string" ? base64Bytes(message.data, largest) : undefined;
    if (data === undefined) {
      refuse(client, id, "That is not an update.");
      return;
    }
    const workspace = found.workspaceId;
    let drawn: number | undefined;
    const seq = await db
      .transaction(async (tx) => {
        // Numbered in the order pushes commit (ADR 0082).
        await lockNumbers(tx, workspace);
        const { rows } = await tx.query(
          `INSERT INTO encrypted_updates (workspace_id, name, seq, data)
           VALUES ($1, $2, nextval('document_seq'), $3) RETURNING seq`,
          [workspace, found.document, data],
        );
        drawn = readCount(rows[0], "seq");
        // Known before the commit, so no read of it sends the pusher its own update.
        pushedBy.set(drawn, client);
        return drawn;
      })
      .catch((error: unknown) => {
        if (drawn !== undefined) pushedBy.delete(drawn);
        throw error;
      });
    // Other nodes read it on this hint; this node reads it before it answers.
    bus.publish(topicOf(workspace), node);
    const made = readers.get(workspace);
    if (made === undefined) {
      // No one here subscribes in the workspace, the pusher neither.
      pushedBy.delete(seq);
    } else {
      const reader = await made;
      if (reader.watermark < seq) {
        const told = new Promise<void>((resolve) => {
          reader.waiters.push({ seq, resolve });
        });
        read(workspace, reader).catch(() => undefined);
        await told;
      }
    }
    send(client, { type: "pushed", id, seq });
  }

  async function compact(client: Client, message: Message): Promise<void> {
    const { id, name, through } = message;
    const found = await place(client, name);
    if (found === undefined || typeof name !== "string") {
      refuse(client, id, refused);
      return;
    }
    // An encrypted workspace is General alone: its role writes there at edit or more (ADR 0089).
    if (!writesAt(generalLevel(found.settings))) {
      refuse(client, id, "Your role reads this workspace, and does not change it.");
      return;
    }
    const data = typeof message.data === "string" ? base64Bytes(message.data, largest) : undefined;
    if (data === undefined || typeof through !== "number" || !Number.isSafeInteger(through)) {
      refuse(client, id, "That is not a snapshot.");
      return;
    }
    // Every update numbered up to `through` has committed, as numbers follow commits.
    const done = await db.transaction(async (tx) => {
      // Only over what is there: a snapshot replaces stored updates, up to one
      // of them; anything else changes nothing.
      const { rows } = await tx.query(
        `SELECT 1 FROM encrypted_updates WHERE workspace_id = $1 AND name = $2 AND seq = $3
          FOR UPDATE`,
        [found.workspaceId, found.document, through],
      );
      if (rows.length === 0) return false;
      await tx.query(
        "DELETE FROM encrypted_updates WHERE workspace_id = $1 AND name = $2 AND seq <= $3",
        [found.workspaceId, found.document, through],
      );
      await tx.query(
        "INSERT INTO encrypted_updates (workspace_id, name, seq, data) VALUES ($1, $2, $3, $4)",
        [found.workspaceId, found.document, through, data],
      );
      return true;
    });
    if (!done) {
      refuse(client, id, "A snapshot must replace the updates up to one stored.");
      return;
    }
    send(client, { type: "compacted", id });
  }

  app.get("/api/relay", { websocket: true }, (socket, request) => {
    const client: Client = { socket, userId: undefined, subscriptions: new Map() };
    // The web app's page signs in with its cookie, from this server's own pages alone (ADR 0053).
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const cookieSession = socketCookieToken(headers);
    clients.add(client);
    // Messages are handled in order, one at a time.
    let queue = Promise.resolve();
    socket.on("message", (raw: Buffer) => {
      queue = queue
        .then(async () => {
          let message: Message;
          try {
            message = JSON.parse(raw.toString("utf8")) as Message;
          } catch {
            socket.close(4400, "Not JSON");
            return;
          }
          if (message.type === "auth") {
            const token =
              typeof message.token === "string" && message.token !== ""
                ? message.token
                : cookieSession;
            const account = token === undefined ? undefined : await sessionAccount(db, token);
            if (account === undefined) {
              socket.close(4401, "Sign in first");
              return;
            }
            client.userId = account.id;
            send(client, { type: "ready" });
            return;
          }
          if (client.userId === undefined) {
            socket.close(4401, "Sign in first");
            return;
          }
          if (message.type === "subscribe") await subscribe(client, message);
          else if (message.type === "push") await push(client, message);
          else if (message.type === "compact") await compact(client, message);
          else if (message.type === "unsubscribe" && typeof message.name === "string") {
            leave(client, message.name);
          } else {
            refuse(client, message.id, "That is not a message the relay knows.");
          }
        })
        .catch((error: unknown) => {
          app.log.error({ err: error }, "The relay could not handle a message");
          socket.close(1011, "Server error");
        });
    });
    socket.on("close", () => {
      clients.delete(client);
      for (const name of [...client.subscriptions.keys()]) leave(client, name);
    });
  });

  return {
    disconnect(userId) {
      for (const client of clients) {
        if (client.userId === userId) client.socket.close(4403, "Access changed");
      }
    },

    sockets() {
      return [...clients].map((client) => client.socket);
    },
  };
}
