// Runs plugins and answers their calls (ADR 0055). Until the sandbox, only
// built-in plugins run: each is a manifest and a module, the module loaded
// when one of the commands its manifest declares is first chosen, or a code
// block in one of its languages is first drawn, and connected through the
// page by the same messages a sandboxed plugin will send through a port.
import {
  type CodeBlockOutput,
  Endpoint,
  type Json,
  type Manifest,
  type Plugin,
  type PluginContext,
  type Transport,
  apiVersion,
  localize,
  pagePair,
  readManifest,
  satisfies,
  startPlugin,
} from "@nether/plugin-api";
import { canBeShortcut } from "../shortcuts.ts";
import type { CodeBlockDrawing, CodeBlockRegistry, CodeBlockView } from "./codeBlocks.ts";
import type { CommandRegistry } from "./registry.ts";

/**
 * What only built-in plugins get, as `context.host`: what cannot cross to a
 * sandboxed plugin, such as a React view. It is not part of the SDK, and
 * has no version.
 */
export interface AppHost {
  readonly codeBlocks: {
    /** Shows `view` below code blocks in a language the manifest declares, in a note open in the app. */
    view(language: string, view: CodeBlockView): void;
  };
}

/** A built-in plugin's context: the SDK's, and the host's. */
export interface BuiltinContext extends PluginContext {
  readonly host: AppHost;
}

/** A built-in plugin's module, which may use the host; any SDK plugin is one. */
export interface BuiltinModule {
  activate(context: BuiltinContext): void | Promise<void>;
}

/** A plugin that comes with the app. */
export interface BuiltinPlugin {
  /** As its manifest.json would hold it. */
  readonly manifest: unknown;
  readonly load: () => Promise<{ readonly default: BuiltinModule }>;
}

/** The registries plugins add to. */
export interface Registries {
  readonly commands: CommandRegistry;
  readonly codeBlocks: CodeBlockRegistry;
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
  /** What takes away the commands and code blocks its manifest declares. */
  readonly removers: (() => void)[];
  /** The commands its code attached, each to the callback that runs it. */
  readonly attached: Map<string, number>;
  /** The code block languages its code attached, each to the callback that draws it. */
  readonly drawers: Map<string, number>;
  /** The live views its code attached through the host, by language. */
  readonly views: Map<string, CodeBlockView>;
  /** Its connection, once its code has been asked for. */
  running?: Promise<readonly [Endpoint, Endpoint]> | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a plugin drew, as the SDK says it may be. */
function readOutput(value: Json): CodeBlockOutput {
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const { html, error } = value as { readonly html?: Json; readonly error?: Json };
    if (typeof html === "string") return { html };
    if (typeof error === "string") return { error };
  }
  throw new Error("Its code block gave neither HTML nor an error.");
}

export class PluginHost {
  readonly #registries: Registries;
  readonly #options: HostOptions;
  readonly #plugins = new Map<string, Added>();

  constructor(registries: Registries, options: HostOptions) {
    this.#registries = registries;
    this.#options = options;
  }

  /**
   * Adds a built-in plugin: the commands and code block languages its
   * manifest declares are there at once, and its code loads when one is
   * first used. Returns what is wrong with it, which keeps it out.
   */
  add(builtin: BuiltinPlugin): readonly string[] {
    const { manifest, problems } = readManifest(builtin.manifest);
    if (manifest === undefined) return problems;
    if (this.#plugins.has(manifest.id)) return [`A plugin ${manifest.id} is there already.`];
    if (!satisfies(apiVersion, manifest.api)) {
      return [`It works with API ${manifest.api}, and the app speaks ${apiVersion}.`];
    }
    const taken = manifest.contributes.codeBlocks.flatMap(({ language }) => {
      const other = this.#registries.codeBlocks.get(language);
      return other === undefined
        ? []
        : [`The plugin ${other.plugin} draws ${language} code blocks already.`];
    });
    if (taken.length > 0) return taken;
    const plugin: Added = {
      manifest,
      load: builtin.load,
      removers: [],
      attached: new Map(),
      drawers: new Map(),
      views: new Map(),
    };
    this.#plugins.set(manifest.id, plugin);
    for (const { language } of manifest.contributes.codeBlocks) {
      plugin.removers.push(
        this.#registries.codeBlocks.add({
          language,
          plugin: manifest.id,
          load: () => this.#drawing(plugin, language),
        }),
      );
    }
    for (const command of manifest.contributes.commands) {
      plugin.removers.push(
        this.#registries.commands.add({
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
    for (const remove of plugin.removers) remove();
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

  /** Starts a plugin for a code block, and gives what its code attached to draw the block's language. */
  async #drawing(plugin: Added, language: string): Promise<CodeBlockDrawing> {
    const [app] = await this.#start(plugin);
    const view = plugin.views.get(language);
    const missing = () => new Error(`Its code did not attach ${language} code blocks.`);
    if (view === undefined && !plugin.drawers.has(language)) throw missing();
    return {
      ...(view === undefined ? {} : { view }),
      ...(plugin.drawers.has(language)
        ? {
            render: async (source, { info, theme, target }) => {
              // Looked up for each block, so that the plugin can take it away again.
              const callback = plugin.drawers.get(language);
              if (callback === undefined) throw missing();
              const context = { language, info, theme, target };
              return readOutput(await app.call("callback", callback, source, context));
            },
          }
        : {}),
    };
  }

  #start(plugin: Added): Promise<readonly [Endpoint, Endpoint]> {
    plugin.running ??= this.#connect(plugin).catch((error: unknown) => {
      // The next command chosen, or block drawn, tries again.
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
    const languages = new Set(contributes.codeBlocks.map((block) => block.language));
    const declaredLanguage = (language: unknown): string => {
      if (typeof language !== "string" || !languages.has(language)) {
        throw new Error(`The manifest declares no code block ${JSON.stringify(language)}.`);
      }
      return language;
    };
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
    app.handle("codeBlocks.register", (language, callback) => {
      const declaredAs = declaredLanguage(language);
      if (typeof callback !== "number") throw new Error("A code block needs a callback.");
      plugin.drawers.set(declaredAs, callback);
      return null;
    });
    app.handle("codeBlocks.unregister", (language) => {
      if (typeof language === "string") plugin.drawers.delete(language);
      return null;
    });
    app.handle("ready", () => {
      ready();
      return null;
    });
    const host: AppHost = {
      codeBlocks: {
        view: (language, view) => {
          plugin.views.set(declaredLanguage(language), view);
        },
      },
    };
    try {
      const { default: builtin } = await plugin.load();
      // Besides what crosses as messages, a built-in plugin gets the host.
      const withHost: Plugin = { activate: (context) => builtin.activate({ ...context, host }) };
      // A built-in plugin's end runs here, in the page.
      const [end] = await Promise.all([startPlugin(withHost, pluginSide), isReady]);
      return [app, end];
    } catch (error) {
      app.close();
      throw error;
    }
  }
}
