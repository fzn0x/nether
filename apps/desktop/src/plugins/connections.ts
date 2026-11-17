// What the host gives plugins of the person's connections, and what it
// keeps for them on the device (ADR 0090). Connections are the app's: a
// plugin lists those of the services its manifest asks for, asks the app
// to add one, and sends requests the app makes with their secrets, never
// seeing one. Only Nether's own plugins may use them for now. A plugin's
// store is JSON in the vault's index on this device, outside its folder.
import {
  type Connection,
  type Json,
  type Manifest,
  type Service,
  connectionServices,
  isJsonObject,
} from "@nether/plugin-api";
import type { Answer, PluginRequest } from "@nether/integrations";
import type { VaultSettings } from "@nether/storage";

/** The person's connections, as the host reaches them for its plugins. */
export interface HostConnections {
  /** The connections this app has, from this device and the account's server. */
  list(): Promise<readonly Connection[]>;
  /** Calls `listener` when they change; gives the way to stop. */
  subscribe(listener: () => void): () => void;
  /** Sends a plugin's request with its connection's secret; rejects with why it could not. */
  fetch(request: PluginRequest, signal: AbortSignal): Promise<Answer>;
  /** Shows the person how to add a connection to a service, in the app's settings. */
  add(service: Service): void;
}

/**
 * Why a plugin that is not Nether's own cannot run with the connections it
 * asks for; none when it asks for none.
 */
export function refusedConnections(manifest: Pick<Manifest, "permissions">): string | undefined {
  const asked = connectionServices(manifest).map((service) => `connection:${service}`);
  if (asked.length === 0) return undefined;
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(asked);
  return `It asks for ${list}, which only Nether's own plugins may use for now.`;
}

/** The most a plugin keeps on the device for a vault, as JSON. */
export const storeLimit = 5 * 1024 * 1024;

const storeKey = (plugin: string) => `plugin-store/${plugin}`;

/** What a plugin keeps, as the vault's index has it; nothing when what is there does not read. */
async function readStore(settings: VaultSettings, plugin: string): Promise<Record<string, Json>> {
  const bytes = await settings.setting(storeKey(plugin));
  if (bytes === undefined) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    return isJsonObject(value) ? { ...value } : {};
  } catch {
    return {};
  }
}

/**
 * A plugin's store in the vault's index: each change read, made and
 * written in turn, so two at once do not lose one.
 */
export class PluginStoreAccess {
  readonly #settings: () => VaultSettings | undefined;
  readonly #plugin: string;
  #turn: Promise<unknown> = Promise.resolve();

  constructor(settings: () => VaultSettings | undefined, plugin: string) {
    this.#settings = settings;
    this.#plugin = plugin;
  }

  #reach(): VaultSettings {
    const settings = this.#settings();
    if (settings === undefined) throw new Error("No vault is open for the plugin.");
    return settings;
  }

  /** Runs `change` after those before it, whether they failed or not. */
  #inTurn<T>(change: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(change, change);
    this.#turn = next.catch(() => undefined);
    return next;
  }

  async get(key: string): Promise<Json | undefined> {
    const values = await readStore(this.#reach(), this.#plugin);
    return Object.hasOwn(values, key) ? values[key] : undefined;
  }

  async keys(): Promise<readonly string[]> {
    return Object.keys(await readStore(this.#reach(), this.#plugin));
  }

  set(key: string, value: Json): Promise<void> {
    return this.#inTurn(async () => {
      const settings = this.#reach();
      const values = await readStore(settings, this.#plugin);
      values[key] = value;
      await this.#write(settings, values);
    });
  }

  delete(key: string): Promise<void> {
    return this.#inTurn(async () => {
      const settings = this.#reach();
      const values = await readStore(settings, this.#plugin);
      if (!Object.hasOwn(values, key)) return;
      await this.#write(
        settings,
        Object.fromEntries(Object.entries(values).filter(([each]) => each !== key)),
      );
    });
  }

  async #write(settings: VaultSettings, values: Record<string, Json>): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    if (bytes.length > storeLimit) {
      throw new Error("A plugin keeps 5 MB at most on the device for a vault.");
    }
    await settings.setSetting(
      storeKey(this.#plugin),
      Object.keys(values).length === 0 ? undefined : bytes,
    );
  }
}
