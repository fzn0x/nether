// Runs plugins and answers their calls (ADR 0055). Until the sandbox, only
// built-in plugins run: each is a manifest and a module, the module loaded
// when one of the commands its manifest declares is first chosen, and
// connected through the page by the same messages a sandboxed plugin will
// send through a port.
import {
  Endpoint,
  type Manifest,
  type Plugin,
  type Transport,
  apiVersion,
  localize,
  pagePair,
  readManifest,
  satisfies,
  startPlugin,
} from "@nether/plugin-api";
import { canBeShortcut } from "../shortcuts.ts";
import type { CommandRegistry } from "./registry.ts";

/** A plugin that comes with the app. */
export interface BuiltinPlugin {
  /** As its manifest.json would hold it. */
  readonly manifest: unknown;
  readonly load: () => Promise<{ readonly default: Plugin }>;
}

export interface HostOptions {
  /** The app's language and its direction, which plugins are told. */
  readonly language: string;
  readonly direction: "ltr" | "rtl";
  /** The app's end and the plugin's of a connection: within the page, unless a test says otherwise. */
  readonly connect?: () => readonly [Transport, Transport];
  /** Told when a plugin cannot start, or one of its commands fails. */
  readonly onError?: (plugin: string, message: string) => void;
}

interface Added {
  readonly manifest: Manifest;
  readonly load: BuiltinPlugin["load"];
  readonly removeCommands: (() => void)[];
  /** The commands its code attached, each to the callback that runs it. */
  readonly attached: Map<string, number>;
  /** Its connection, once its code has been asked for. */
  running?: Promise<readonly [Endpoint, Endpoint]> | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginHost {
  readonly #registry: CommandRegistry;
  readonly #options: HostOptions;
  readonly #plugins = new Map<string, Added>();

  constructor(registry: CommandRegistry, options: HostOptions) {
    this.#registry = registry;
    this.#options = options;
  }

  /**
   * Adds a built-in plugin: the commands its manifest declares show at
   * once, and its code loads when one is first chosen. Returns what is
   * wrong with it, which keeps it out.
   */
  add(builtin: BuiltinPlugin): readonly string[] {
    const { manifest, problems } = readManifest(builtin.manifest);
    if (manifest === undefined) return problems;
    if (this.#plugins.has(manifest.id)) return [`A plugin ${manifest.id} is there already.`];
    if (!satisfies(apiVersion, manifest.api)) {
      return [`It works with API ${manifest.api}, and the app speaks ${apiVersion}.`];
    }
    const plugin: Added = {
      manifest,
      load: builtin.load,
      removeCommands: [],
      attached: new Map(),
    };
    this.#plugins.set(manifest.id, plugin);
    for (const command of manifest.contributes.commands) {
      plugin.removeCommands.push(
        this.#registry.add({
          id: `${manifest.id}:${command.id}`,
          name: () => localize(command.name, this.#options.language),
          menu: command.menu,
          keys: command.keys.filter(canBeShortcut),
          plugin: manifest.id,
          enabled: () => true,
          run: () => {
            void this.#run(plugin, command.id);
          },
        }),
      );
    }
    return [];
  }

  /** The plugins added, by ID. */
  ids(): readonly string[] {
    return [...this.#plugins.keys()];
  }

  /** Stops a plugin, and takes away what it added. */
  remove(id: string): void {
    const plugin = this.#plugins.get(id);
    if (plugin === undefined) return;
    this.#plugins.delete(id);
    for (const remove of plugin.removeCommands) remove();
    void plugin.running?.then(
      (ends) => {
        for (const end of ends) end.close();
      },
      () => undefined,
    );
  }

  /** Stops every plugin. */
  close(): void {
    for (const id of this.ids()) this.remove(id);
  }

  async #run(plugin: Added, command: string): Promise<void> {
    try {
      const [app] = await this.#start(plugin);
      const callback = plugin.attached.get(command);
      if (callback === undefined) throw new Error(`Its code did not attach ${command}.`);
      await app.call("callback", callback);
    } catch (error) {
      this.#options.onError?.(plugin.manifest.id, errorText(error));
    }
  }

  #start(plugin: Added): Promise<readonly [Endpoint, Endpoint]> {
    plugin.running ??= this.#connect(plugin).catch((error: unknown) => {
      // The next command chosen tries again.
      plugin.running = undefined;
      throw error;
    });
    return plugin.running;
  }

  async #connect(plugin: Added): Promise<readonly [Endpoint, Endpoint]> {
    const [appSide, pluginSide] = (this.#options.connect ?? pagePair)();
    const app = new Endpoint(appSide);
    const { id, contributes } = plugin.manifest;
    const declared = new Set(contributes.commands.map((command) => command.id));
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    app.handle("hello", () => ({
      id,
      api: apiVersion,
      language: this.#options.language,
      direction: this.#options.direction,
    }));
    app.handle("commands.register", (command, callback) => {
      if (typeof command !== "string" || !declared.has(command)) {
        throw new Error(`The manifest declares no command ${JSON.stringify(command)}.`);
      }
      if (typeof callback !== "number") throw new Error("A command needs a callback.");
      plugin.attached.set(command, callback);
      return null;
    });
    app.handle("commands.unregister", (command) => {
      if (typeof command === "string") plugin.attached.delete(command);
      return null;
    });
    app.handle("ready", () => {
      ready();
      return null;
    });
    try {
      const module = await plugin.load();
      // A built-in plugin's end runs here, in the page.
      const [end] = await Promise.all([startPlugin(module.default, pluginSide), isReady]);
      return [app, end];
    } catch (error) {
      app.close();
      throw error;
    }
  }
}
