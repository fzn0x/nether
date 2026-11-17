// The nodes' bus over Valkey or Redis (ADR 0082): each topic a pub/sub
// channel under a prefix, published on one connection and heard on another,
// since a connection that subscribes does nothing else. A hint is never data
// a node depends on, so a lost one costs time, not data; when the
// subscribing connection comes back after it was lost, the handlers given
// to `onReconnect` run, and the server closes its sockets in case it missed
// a close.
import type { ClusterBus, Unsubscribe } from "@nether/server/src/cluster.ts";
import { connectRedis } from "@nether/server/src/redis.ts";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

export class ValkeyBus implements ClusterBus {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #prefix: string;
  readonly #log: FastifyBaseLogger;
  readonly #handlers = new Map<string, Set<(message: string) => void>>();
  readonly #reconnects = new Set<() => void>();
  /** Whether a publish failed since the last that went through, so the log says so once. */
  #failing = false;
  /** Whether the bus is closing, so its connections' ends are no loss. */
  #closing = false;

  private constructor(publisher: Redis, subscriber: Redis, prefix: string, log: FastifyBaseLogger) {
    this.#publisher = publisher;
    this.#subscriber = subscriber;
    this.#prefix = prefix;
    this.#log = log;
    subscriber.on("message", (channel: string, message: string) => {
      const topic = channel.slice(prefix.length);
      for (const handler of [...(this.#handlers.get(topic) ?? [])]) {
        try {
          handler(message);
        } catch (error) {
          log.error({ err: error, topic }, "A handler of the cluster bus failed");
        }
      }
    });
    // Lost and back: the client subscribes again on its own, and what was
    // published meanwhile is gone.
    let lost = false;
    subscriber.on("close", () => {
      if (lost || this.#closing) return;
      lost = true;
      log.error(
        "Lost the cluster bus's connection to Valkey: other nodes' hints wait until it is back",
      );
    });
    subscriber.on("ready", () => {
      if (!lost) return;
      lost = false;
      log.warn("The cluster bus is back after its connection to Valkey was lost");
      for (const handler of [...this.#reconnects]) handler();
    });
    for (const client of [publisher, subscriber]) {
      // Said where the connection is watched; an error event with no listener would end the process.
      client.on("error", () => undefined);
    }
  }

  /** Connects to Valkey at `url`, its channels under `prefix`, as `nether:bus:`. */
  static async connect(url: string, prefix: string, log: FastifyBaseLogger): Promise<ValkeyBus> {
    const publisher = await connectRedis(url, { connectionName: `${prefix}publisher` });
    try {
      const subscriber = await connectRedis(url, { connectionName: `${prefix}subscriber` });
      return new ValkeyBus(publisher, subscriber, prefix, log);
    } catch (error) {
      publisher.disconnect();
      throw error;
    }
  }

  publish(topic: string, message: string): void {
    this.#publisher.publish(this.#prefix + topic, message).then(
      () => {
        this.#failing = false;
      },
      (error: unknown) => {
        if (this.#failing) return;
        this.#failing = true;
        this.#log.error({ err: error, topic }, "Could not publish on the cluster bus");
      },
    );
  }

  subscribe(topic: string, handler: (message: string) => void): Unsubscribe {
    let handlers = this.#handlers.get(topic);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(topic, handlers);
      this.#subscriber.subscribe(this.#prefix + topic).catch((error: unknown) => {
        this.#log.error({ err: error, topic }, "Could not subscribe on the cluster bus");
      });
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size > 0 || this.#handlers.get(topic) !== handlers) return;
      this.#handlers.delete(topic);
      this.#subscriber.unsubscribe(this.#prefix + topic).catch(() => undefined);
    };
  }

  onReconnect(handler: () => void): Unsubscribe {
    this.#reconnects.add(handler);
    return () => {
      this.#reconnects.delete(handler);
    };
  }

  /** Closes both connections. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#handlers.clear();
    this.#reconnects.clear();
    await Promise.allSettled([this.#publisher.quit(), this.#subscriber.quit()]);
  }
}
