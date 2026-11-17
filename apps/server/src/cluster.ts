// What the nodes of one server tell each other (ADR 0082): hints on a
// topic, such as that a workspace has new encrypted updates to read. A
// hint is never the data a node depends on: a node that misses one reads
// the database a few seconds later anyway. One process uses the bus below;
// several nodes use one over Valkey, which the `ha` module gives.

/** Gets the hints of a topic, until the function it gave back is called. */
export type Unsubscribe = () => void;

/** The nodes' bus: hints published on a topic reach every node subscribed to it, this one too. */
export interface ClusterBus {
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
