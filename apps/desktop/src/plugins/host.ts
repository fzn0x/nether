// Runs plugins and answers their calls (ADR 0055). Until the sandbox, only
// built-in plugins run: each is a manifest and a module, the module loaded
// when what its manifest declares is first used, a command chosen, a code
// block drawn, a block or a panel shown, and connected through the page by
// the same messages a sandboxed plugin will send through a port.
import {
  type BlockViewProps,
  type CodeBlockOutput,
  Endpoint,
  type Json,
  type JsonObject,
  type Localized,
  type Manifest,
  type PanelProps,
  type Plugin,
  type PluginContext,
  type Transport,
  apiVersion,
  isJsonObject,
  localize,
  pagePair,
  readManifest,
  satisfies,
  settingValues,
  startPlugin,
} from "@nether/plugin-api";
import { canBeShortcut } from "../shortcuts.ts";
import type { BlockDrawing, BlockRegistry } from "./blocks.ts";
import type {
  CodeBlockDrawing,
  CodeBlockRegistry,
  CodeBlockView,
  SlashOffer,
} from "./codeBlocks.ts";
import type { PanelDrawing, PanelHostView, PanelRegistry } from "./panels.ts";
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
  readonly panels: {
    /** Fills a panel the manifest declares with `view`. */
    view(id: string, view: PanelHostView): void;
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
  readonly blocks: BlockRegistry;
  readonly panels: PanelRegistry;
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
  /** What takes away what its manifest declares. */
  readonly removers: (() => void)[];
  /** The commands its code attached, each to the callback that runs it. */
  readonly attached: Map<string, number>;
  /** The code block languages its code attached, each to the callback that draws it. */
  readonly drawers: Map<string, number>;
  /** The live views of code blocks its code attached through the host, by language. */
  readonly views: Map<string, CodeBlockView>;
  /** The block types its code attached views to, each to the callback that runs the view. */
  readonly blockViews: Map<string, number>;
  /** The panels its code attached views to, by ID: a callback, or a live view through the host. */
  readonly panelViews: Map<string, number | PanelHostView>;
  /** Its connection, once its code has been asked for. */
  running?: Promise<readonly [Endpoint, Endpoint]> | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where a plugin's view mounts, by the slot named for it. */
interface Slot {
  readonly plugin: string;
  readonly element: HTMLElement;
  /** Told what a block's view changes the block to. */
  readonly onChange?: (attrs: JsonObject) => void;
}

/** A block view's props as they cross to a plugin. */
function blockProps(props: BlockViewProps): Json {
  return { attrs: props.attrs, editable: props.editable, theme: props.theme };
}

/** A panel's props as they cross to a plugin. */
function panelProps(props: PanelProps): Json {
  const { note } = props;
  return {
    theme: props.theme,
    ...(note === undefined ? {} : { note: { id: note.id, title: note.title, path: note.path } }),
  };
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
  readonly #slots = new Map<string, Slot>();
  #nextSlot = 0;
  /** Each plugin's settings as the vault keeps them, read through its fields when it starts. */
  readonly #stored = new Map<string, unknown>();

  constructor(registries: Registries, options: HostOptions) {
    this.#registries = registries;
    this.#options = options;
  }

  /**
   * Adds a built-in plugin: what its manifest declares is there at once,
   * and its code loads when one is first used. Returns what is wrong with
   * it, which keeps it out.
   */
  add(builtin: BuiltinPlugin): readonly string[] {
    const { manifest, problems } = readManifest(builtin.manifest);
    if (manifest === undefined) return problems;
    if (this.#plugins.has(manifest.id)) return [`A plugin ${manifest.id} is there already.`];
    if (!satisfies(apiVersion, manifest.api)) {
      return [`It works with API ${manifest.api}, and the app speaks ${apiVersion}.`];
    }
    const { language } = this.#options;
    const offer = (name: Localized, keywords: Localized | undefined): SlashOffer => ({
      name: () => localize(name, language),
      keywords: () => (keywords === undefined ? "" : localize(keywords, language)),
    });
    const taken = manifest.contributes.codeBlocks.flatMap((block) => {
      const other = this.#registries.codeBlocks.get(block.language);
      return other === undefined
        ? []
        : [`The plugin ${other.plugin} draws ${block.language} code blocks already.`];
    });
    if (taken.length > 0) return taken;
    const plugin: Added = {
      manifest,
      load: builtin.load,
      removers: [],
      attached: new Map(),
      drawers: new Map(),
      views: new Map(),
      blockViews: new Map(),
      panelViews: new Map(),
    };
    this.#plugins.set(manifest.id, plugin);
    for (const block of manifest.contributes.codeBlocks) {
      const { slash } = block;
      plugin.removers.push(
        this.#registries.codeBlocks.add({
          language: block.language,
          plugin: manifest.id,
          ...(slash === undefined
            ? {}
            : { slash: { ...offer(slash.name, slash.keywords), text: slash.text } }),
          load: () => this.#drawing(plugin, block.language),
        }),
      );
    }
    for (const { type, slash, attrs } of manifest.contributes.blocks) {
      plugin.removers.push(
        this.#registries.blocks.add({
          type: `${manifest.id}/${type}`,
          plugin: manifest.id,
          slash: offer(slash.name, slash.keywords),
          attrs,
          load: () => this.#blockDrawing(plugin, type),
        }),
      );
    }
    for (const panel of manifest.contributes.panels) {
      plugin.removers.push(
        this.#registries.panels.add({
          id: `${manifest.id}:${panel.id}`,
          plugin: manifest.id,
          place: panel.place,
          folded: panel.folded,
          name: () => localize(panel.name, language),
          load: () => this.#panelDrawing(plugin, panel.id),
        }),
      );
    }
    for (const command of manifest.contributes.commands) {
      plugin.removers.push(
        this.#registries.commands.add({
          id: `${manifest.id}:${command.id}`,
          name: () => localize(command.name, language),
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

  /**
   * A plugin's settings, as the vault keeps them: a plugin that starts
   * later starts with them, and one running is told of them.
   */
  setSettings(id: string, stored: unknown): void {
    this.#stored.set(id, stored);
    const plugin = this.#plugins.get(id);
    if (plugin?.running === undefined) return;
    const values = settingValues(plugin.manifest.contributes.settings, stored);
    plugin.running
      .then(([app]) => app.call("settings.changed", values))
      .catch((error: unknown) => {
        this.#options.onError?.(id, errorText(error));
      });
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

  /** Starts a plugin for a block, and gives what mounts its view of the block's type. */
  async #blockDrawing(plugin: Added, type: string): Promise<BlockDrawing> {
    const [app] = await this.#start(plugin);
    const missing = () => new Error(`Its code did not attach a view of ${type} blocks.`);
    if (!plugin.blockViews.has(type)) throw missing();
    return {
      mount: (element, props, onChange) => {
        // Looked up for each block, so that the plugin can take it away again.
        const callback = plugin.blockViews.get(type);
        if (callback === undefined) return Promise.reject(missing());
        return this.#mount(app, plugin, callback, element, blockProps, props, onChange);
      },
    };
  }

  /** Starts a plugin for a panel, and gives what fills it. */
  async #panelDrawing(plugin: Added, panel: string): Promise<PanelDrawing> {
    const [app] = await this.#start(plugin);
    const missing = () => new Error(`Its code did not attach a view of the ${panel} panel.`);
    const view = plugin.panelViews.get(panel);
    if (view === undefined) throw missing();
    if (typeof view !== "number") return { view };
    return {
      mount: (element, props) => {
        const callback = plugin.panelViews.get(panel);
        if (typeof callback !== "number") return Promise.reject(missing());
        return this.#mount(app, plugin, callback, element, panelProps, props);
      },
    };
  }

  /**
   * Mounts a plugin's view in `element`, through a slot named for it, and
   * gives what updates and unmounts it.
   */
  async #mount<P>(
    app: Endpoint,
    plugin: Added,
    callback: number,
    element: HTMLElement,
    toJson: (props: P) => Json,
    props: P,
    onChange?: (attrs: JsonObject) => void,
  ): Promise<{ update(props: P): Promise<void>; unmount(): void }> {
    const id = plugin.manifest.id;
    const slot = `${id}:${String(++this.#nextSlot)}`;
    this.#slots.set(slot, { plugin: id, element, ...(onChange === undefined ? {} : { onChange }) });
    try {
      await app.call("callback", callback, "mount", slot, toJson(props));
    } catch (error) {
      this.#slots.delete(slot);
      throw error;
    }
    return {
      update: async (next) => {
        if (!this.#slots.has(slot)) return;
        await app.call("callback", callback, "update", slot, toJson(next));
      },
      unmount: () => {
        if (!this.#slots.delete(slot)) return;
        // A plugin already stopped has nothing to unmount.
        app.call("callback", callback, "unmount", slot).catch(() => undefined);
      },
    };
  }

  #start(plugin: Added): Promise<readonly [Endpoint, Endpoint]> {
    plugin.running ??= this.#connect(plugin).catch((error: unknown) => {
      // The next time it is needed, it is tried again.
      plugin.running = undefined;
      throw error;
    });
    return plugin.running;
  }

  async #connect(plugin: Added): Promise<readonly [Endpoint, Endpoint]> {
    const [appSide, pluginSide] = (this.#options.connect ?? pagePair)();
    const app = new Endpoint(appSide);
    const { id, contributes } = plugin.manifest;
    /** Checks that the manifest declares `value` among `ids`, to attach to it. */
    const declared = (ids: ReadonlySet<string>, what: string, value: unknown): string => {
      if (typeof value !== "string" || !ids.has(value)) {
        throw new Error(`The manifest declares no ${what} ${JSON.stringify(value)}.`);
      }
      return value;
    };
    const commands = new Set(contributes.commands.map((command) => command.id));
    const languages = new Set(contributes.codeBlocks.map((block) => block.language));
    const types = new Set(contributes.blocks.map((block) => block.type));
    const panels = new Set(contributes.panels.map((panel) => panel.id));
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    /** Handles `<kind>.register` and `<kind>.unregister` for what the manifest declares. */
    const attachable = (
      kind: string,
      ids: ReadonlySet<string>,
      what: string,
      attached: Map<string, number | PanelHostView>,
    ) => {
      app.handle(`${kind}.register`, (value, callback) => {
        const at = declared(ids, what, value);
        if (typeof callback !== "number") throw new Error(`A ${what} needs a callback.`);
        attached.set(at, callback);
        return null;
      });
      app.handle(`${kind}.unregister`, (value) => {
        if (typeof value === "string") attached.delete(value);
        return null;
      });
    };
    app.handle("hello", () => ({
      id,
      api: apiVersion,
      language: this.#options.language,
      direction: this.#options.direction,
      settings: settingValues(contributes.settings, this.#stored.get(id)),
    }));
    attachable("commands", commands, "command", plugin.attached);
    attachable("codeBlocks", languages, "code block", plugin.drawers);
    attachable("blocks", types, "block", plugin.blockViews);
    attachable("panels", panels, "panel", plugin.panelViews);
    app.handle("blocks.change", (slot, attrs) => {
      const at = typeof slot === "string" ? this.#slots.get(slot) : undefined;
      // A plugin changes only the blocks its own views show.
      if (at?.plugin !== id || at.onChange === undefined) {
        throw new Error("The plugin shows no such block.");
      }
      if (!isJsonObject(attrs)) throw new Error("A block holds a JSON object.");
      at.onChange(attrs);
      return null;
    });
    app.handle("ready", () => {
      ready();
      return null;
    });
    const host: AppHost = {
      codeBlocks: {
        view: (language, view) => {
          plugin.views.set(declared(languages, "code block", language), view);
        },
      },
      panels: {
        view: (panel, view) => {
          plugin.panelViews.set(declared(panels, "panel", panel), view);
        },
      },
    };
    try {
      const { default: builtin } = await plugin.load();
      // Besides what crosses as messages, a built-in plugin gets the host.
      const withHost: Plugin = { activate: (context) => builtin.activate({ ...context, host }) };
      // A built-in plugin's end runs here, in the page, and its views mount
      // in the elements the app makes for them.
      const surface = {
        element: (slot: string) => {
          const at = this.#slots.get(slot);
          return at?.plugin === id ? at.element : undefined;
        },
      };
      const [end] = await Promise.all([startPlugin(withHost, pluginSide, surface), isReady]);
      return [app, end];
    } catch (error) {
      app.close();
      throw error;
    }
  }
}
