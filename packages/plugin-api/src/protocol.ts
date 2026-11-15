// The messages between a plugin and the app (ADR 0055): each side calls
// the other's methods by name, with JSON values, and gets back a result or
// an error. Built-in plugins send them within the page; a sandboxed plugin
// will send the same messages through a port.
import type { Json } from "./json.ts";

export type Message =
  | {
      readonly kind: "call";
      readonly id: number;
      readonly method: string;
      readonly args: readonly Json[];
    }
  | { readonly kind: "result"; readonly id: number; readonly value: Json }
  | { readonly kind: "error"; readonly id: number; readonly message: string };

/** One side's way to send messages to the other and hear its replies. */
export interface Transport {
  send(message: Message): void;
  /** Calls `receive` with each message from the other side; returns a function that stops it. */
  listen(receive: (message: Message) => void): () => void;
  close(): void;
}

/** What a method answers with: a value, nothing, or a promise of either. */
export type Handler = (...args: Json[]) => Json | undefined | Promise<Json | undefined>;

/** Whether a value received is a message, as a port may carry anything. */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "number") return false;
  switch (message.kind) {
    case "call":
      return typeof message.method === "string" && Array.isArray(message.args);
    case "result":
      return "value" in message;
    case "error":
      return typeof message.message === "string";
    default:
      return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One side of a connection: the methods it answers, and calls to the other side. */
export class Endpoint {
  readonly #transport: Transport;
  readonly #handlers = new Map<string, Handler>();
  readonly #waiting = new Map<
    number,
    { readonly resolve: (value: Json) => void; readonly reject: (error: Error) => void }
  >();
  readonly #stop: () => void;
  #next = 0;
  #closed = false;

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#stop = transport.listen((message) => {
      this.#receive(message);
    });
  }

  /** Answers the other side's calls of `method`; returns a function that stops. */
  handle(method: string, handler: Handler): () => void {
    this.#handlers.set(method, handler);
    return () => {
      if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
    };
  }

  /** Calls the other side's `method`, for what it answers. */
  call(method: string, ...args: Json[]): Promise<Json> {
    if (this.#closed) return Promise.reject(new Error("The connection is closed."));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#transport.send({ kind: "call", id, method, args });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Ends the connection: calls still waiting fail, and nothing more is answered. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    this.#transport.close();
    for (const { reject } of this.#waiting.values()) reject(new Error("The connection is closed."));
    this.#waiting.clear();
  }

  #receive(message: Message): void {
    if (this.#closed) return;
    if (message.kind === "call") {
      void this.#answer(message);
      return;
    }
    const waiting = this.#waiting.get(message.id);
    if (waiting === undefined) return;
    this.#waiting.delete(message.id);
    if (message.kind === "result") waiting.resolve(message.value);
    else waiting.reject(new Error(message.message));
  }

  async #answer(call: Extract<Message, { kind: "call" }>): Promise<void> {
    let reply: Message;
    try {
      const handler = this.#handlers.get(call.method);
      if (handler === undefined) throw new Error(`Nothing answers ${call.method}.`);
      const value = await handler(...call.args);
      reply = { kind: "result", id: call.id, value: value ?? null };
    } catch (error) {
      reply = { kind: "error", id: call.id, message: errorText(error) };
    }
    if (!this.#closed) this.#transport.send(reply);
  }
}

/**
 * Two transports that hand each other their messages as they are, within
 * the page: what built-in plugins use. A message arrives after the code
 * that sent it has run, as through a port.
 */
export function pagePair(): readonly [Transport, Transport] {
  const sides = [new Set<(message: Message) => void>(), new Set<(message: Message) => void>()];
  let open = true;
  const side = (own: number): Transport => ({
    send(message) {
      if (!open) return;
      const other = sides[1 - own];
      void Promise.resolve().then(() => {
        if (open) for (const receive of other ?? []) receive(message);
      });
    },
    listen(receive) {
      sides[own]?.add(receive);
      return () => sides[own]?.delete(receive);
    },
    close() {
      open = false;
    },
  });
  return [side(0), side(1)];
}

/**
 * What a port calls with a message. Declared as a method's type, which
 * TypeScript checks either way round, so a browser's `MessagePort`, whose
 * handler takes a whole `MessageEvent`, is a `PortLike` too.
 */
type PortListener = {
  bivariant(event: { readonly data: unknown }): void;
}["bivariant"];

/** The part of a `MessagePort` a transport uses. */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: PortListener | null;
  close(): void;
}

/**
 * A transport over a message port, as a sandboxed plugin will use: what
 * arrives that is not a message is left unanswered.
 */
export function portTransport(port: PortLike): Transport {
  const listeners = new Set<(message: Message) => void>();
  port.onmessage = (event) => {
    if (!isMessage(event.data)) return;
    const message = event.data;
    for (const receive of listeners) receive(message);
  };
  return {
    send(message) {
      port.postMessage(message);
    },
    listen(receive) {
      listeners.add(receive);
      return () => listeners.delete(receive);
    },
    close() {
      port.onmessage = null;
      port.close();
    },
  };
}
