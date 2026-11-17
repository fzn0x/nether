// The person's connections in this app (ADR 0090), which every vault's
// plugins share: kept by the backend, on this device for now, listed for
// the Connections tab and for Nether's own plugins, and used to send their
// requests, the secret read from the keychain as each is sent and never
// handed to a plugin.
import {
  type Answer,
  type CheckProblem,
  type ConnectionSecret,
  type KeptConnection,
  type PluginRequest,
  checkConnection,
  readSecret,
  sendRequest,
  shownConnection,
  writeSecret,
} from "@nether/integrations";
import type { Connection, Service } from "@nether/plugin-api";
import type { ConnectionStore } from "./backend.ts";
import type { HostConnections } from "./plugins/connections.ts";

export class ConnectionsHub {
  readonly #store: ConnectionStore;
  readonly #listeners = new Set<() => void>();

  constructor(store: ConnectionStore) {
    this.#store = store;
  }

  /** Whether `http:` addresses may be typed, as on the desktop. */
  get http(): boolean {
    return this.#store.http;
  }

  list(): Promise<readonly KeptConnection[]> {
    return this.#store.list();
  }

  /** Calls `listener` when a connection is added, changed or removed; gives the way to stop. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Checks a connection before it is kept; undefined when it works. */
  check(connection: KeptConnection, secret: ConnectionSecret): Promise<CheckProblem | undefined> {
    return checkConnection(connection, secret, this.#store.fetch, this.#store.http);
  }

  /** Keeps a connection with its secret, a new one when its ID is empty; gives it as kept. */
  async add(connection: KeptConnection, secret: ConnectionSecret): Promise<KeptConnection> {
    const kept = await this.#store.save(connection);
    try {
      await this.#store.setSecret(kept.id, writeSecret(secret));
    } catch (error) {
      // A connection without its secret would reach nothing.
      await this.#store.remove(kept.id);
      throw error;
    }
    this.#changed();
    return kept;
  }

  /** Renames a connection. */
  async rename(connection: KeptConnection, name: string): Promise<void> {
    await this.#store.save({ ...connection, name });
    this.#changed();
  }

  /** Forgets a connection, and its secret leaves the keychain. */
  async remove(id: string): Promise<void> {
    await this.#store.remove(id);
    this.#changed();
  }

  /** What the plugin host reaches of the connections; `add` shows where to add one. */
  host(add: (service: Service) => void): HostConnections {
    return {
      list: async (): Promise<readonly Connection[]> =>
        (await this.#store.list()).map((each) => shownConnection(each, "device")),
      subscribe: (listener) => this.subscribe(listener),
      fetch: (request, signal) => this.#send(request, signal),
      add,
    };
  }

  async #send(request: PluginRequest, signal: AbortSignal): Promise<Answer> {
    const connection = (await this.#store.list()).find((each) => each.id === request.connection);
    if (connection === undefined) throw new Error("The plugin has no such connection.");
    const secret = readSecret(await this.#store.secret(connection.id));
    return sendRequest({
      connection,
      secret,
      request,
      fetch: this.#store.fetch,
      http: this.#store.http,
      signal,
    });
  }
}
