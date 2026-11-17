// What the nodes of one server tell each other (ADR 0082): hints on a
// topic, such as that a workspace has new encrypted updates to read, or
// that an account's sockets must close. A hint is never the data a node
// depends on: a node that misses one reads the database a few seconds
// later anyway. One process uses the bus below; several nodes use one over
// Valkey, which the `ha` module gives.
import type { FastifyBaseLogger } from "fastify";

/** Gets the hints of a topic, until the function it gave back is called. */
export type Unsubscribe = () => void;

/** The nodes' bus: hints published on a topic reach every node subscribed to it, this one too. */
export interface ClusterBus {
  /** Sends a hint, fire and forget: a bus that cannot send it logs why. */
  publish(topic: string, message: string): void;
  subscribe(topic: string, handler: (message: string) => void): Unsubscribe;
}

/** The bus of a single process: what it publishes it hears, a moment later. */
export class ProcessBus implements ClusterBus {
  readonly #handlers = new Map<string, Set<(message: string) => void>>();

  publish(topic: string, message: string): void {
    const handlers = this.#handlers.get(topic);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      // Heard after the publisher goes on, as from another node.
      queueMicrotask(() => {
        handler(message);
      });
    }
  }

  subscribe(topic: string, handler: (message: string) => void): Unsubscribe {
    let handlers = this.#handlers.get(topic);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(topic, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.#handlers.get(topic) === handlers) {
        this.#handlers.delete(topic);
      }
    };
  }
}

/** The topic on which a node asks every node to close an account's sockets. */
const disconnectTopic = "sockets.disconnect";

/** This node's sockets: Hocuspocus's and the relay's. */
export interface NodeSockets {
  /** Closes this node's sockets of an account, or of a share-link visitor. */
  disconnect(userId: string): void;
}

/**
 * Closes an account's sockets on every node (ADR 0082): this node's at
 * once, the others' on a hint through the bus.
 */
export function shareDisconnects(
  bus: ClusterBus,
  node: string,
  sockets: NodeSockets,
  log: FastifyBaseLogger,
): { readonly disconnect: (userId: string) => void; readonly stop: () => void } {
  const unsubscribe = bus.subscribe(disconnectTopic, (message) => {
    let asked: unknown;
    try {
      asked = JSON.parse(message);
    } catch {
      return;
    }
    const { node: from, userId } = (asked ?? {}) as { node?: unknown; userId?: unknown };
    // This node closed its own as it asked.
    if (from !== node && typeof userId === "string") sockets.disconnect(userId);
  });
  return {
    disconnect(userId) {
      sockets.disconnect(userId);
      try {
        bus.publish(disconnectTopic, JSON.stringify({ node, userId }));
      } catch (error) {
        log.error({ err: error }, "Could not ask the other nodes to close an account's sockets");
      }
    },
    stop() {
      unsubscribe();
    },
  };
}
