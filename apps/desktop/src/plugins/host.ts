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
  type LayoutProps,
  type Localized,
  type Manifest,
  type PaneViewProps,
  type PanelProps,
  type Plugin,
  type PropertyViewProps,
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
import type { PaneViewDrawing, PaneViewHost, ViewRegistry } from "./views.ts";
import type { LayoutActions, LayoutDrawing, LayoutHost, LayoutRegistry } from "./layouts.ts";
import type { PropertyTypeDrawing, PropertyTypeRegistry } from "./propertyTypes.ts";
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
  readonly views: {
    /** Fills a pane with `view`, for a view the manifest declares. */
    view(id: string, view: PaneViewHost): void;
  };
  readonly layouts: {
    /** Shows a database's rows with `view`, for a layout the manifest declares. */
    view(id: string, view: LayoutHost): void;
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
  /**
   * Whether its layouts keep the app's own names, as `board`, not
   * `plugin-id/board`: the built-in layouts' plugin (ADR 0056).
   */
  readonly appLayouts?: boolean;
}

/** The registries plugins add to. */
export interface Registries {
  readonly commands: CommandRegistry;
  readonly codeBlocks: CodeBlockRegistry;
  readonly blocks: BlockRegistry;
  readonly panels: PanelRegistry;
  readonly views: ViewRegistry;
  readonly layouts: LayoutRegistry;
  readonly propertyTypes: PropertyTypeRegistry;
}

export interface HostOptions {
  /** The app's language and its direction, which plugins are told. */
  readonly language: string;
  readonly direction: "ltr" | "rtl";
  /** The app's end and the plugin's of a connection: within the page, unless a test says otherwise. */
  readonly connect?: () => readonly [Transport, Transport];
  /** Told when a plugin cannot start, or one of its commands fails. */
  readonly onError?: (plugin: string, message: string) => void;
  /** Asked to open a plugin's view of its own, `plugin-id:view`, in the pane. */
  readonly onOpenView?: (id: string) => void;
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
  /** The views of panes its code attached, by ID: a callback, or a live view through the host. */
  readonly paneViews: Map<string, number | PaneViewHost>;
  /** The layouts its code attached views to, by ID: a callback, or a live view through the host. */
  readonly layoutViews: Map<string, number | LayoutHost>;
  /** The property types its code attached views to, each to the callback that runs the view. */
  readonly propertyViews: Map<string, number>;
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
  /** What a layout's view changes in its database. */
  readonly layout?: LayoutActions;
  /** Told what a property type's view sets its value to. */
  readonly setValue?: (value: Json) => void;
}

/** A property type's view's props as they cross to a plugin. */
function propertyProps(props: PropertyViewProps): Json {
  return { key: props.key, value: props.value, editable: props.editable, theme: props.theme };
}

/** A layout's props as they cross to a plugin. */
function layoutProps(props: LayoutProps): Json {
  return {
    view: { name: props.view.name, options: props.view.options },
    rows: props.rows.map((row) => ({ id: row.id, title: row.title, values: row.values })),
    ...(props.groups === undefined
      ? {}
      : { groups: props.groups.map((group) => ({ value: group.value, rows: [...group.rows] })) }),
    properties: props.properties.map((property) => ({
      key: property.key,
      name: property.name,
      type: property.type,
    })),
    editable: props.editable,
    theme: props.theme,
  };
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

/** A pane's view's props as they cross to a plugin. */
function paneProps(props: PaneViewProps): Json {
  const { file } = props;
  return { theme: props.theme, ...(file === undefined ? {} : { file: { path: file.path } }) };
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
    const taken = [
      ...manifest.contributes.codeBlocks.flatMap((block) => {
        const other = this.#registries.codeBlocks.get(block.language);
        return other === undefined
          ? []
          : [`The plugin ${other.plugin} draws ${block.language} code blocks already.`];
      }),
      ...manifest.contributes.views.flatMap((view) =>
        view.extensions.flatMap((extension) => {
          const other = this.#registries.views.forFile(`a.${extension}`);
          return other === undefined
            ? []
            : [`The plugin ${other.plugin} opens .${extension} files already.`];
        }),
      ),
    ];
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
      paneViews: new Map(),
      layoutViews: new Map(),
      propertyViews: new Map(),
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
    for (const view of manifest.contributes.views) {
      plugin.removers.push(
        this.#registries.views.add({
          id: `${manifest.id}:${view.id}`,
          plugin: manifest.id,
          extensions: view.extensions,
          name: () => localize(view.name, language),
          load: () => this.#paneDrawing(plugin, view.id),
        }),
      );
    }
    for (const layout of manifest.contributes.layouts) {
      plugin.removers.push(
        this.#registries.layouts.add({
          layout: builtin.appLayouts === true ? layout.id : `${manifest.id}/${layout.id}`,
          plugin: manifest.id,
          name: () => localize(layout.name, language),
          load: () => this.#layoutDrawing(plugin, layout.id),
        }),
      );
    }
    for (const property of manifest.contributes.propertyTypes) {
      plugin.removers.push(
        this.#registries.propertyTypes.add({
          type: `${manifest.id}/${property.id}`,
          plugin: manifest.id,
          stores: property.stores,
          name: () => localize(property.name, language),
          load: () => this.#propertyDrawing(plugin, property.id),
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
        return this.#mount(app, plugin, callback, element, blockProps, props, { onChange });
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

  /** Starts a plugin for a view of a pane, and gives what fills it. */
  async #paneDrawing(plugin: Added, id: string): Promise<PaneViewDrawing> {
    const [app] = await this.#start(plugin);
    const missing = () => new Error(`Its code did not attach the ${id} view.`);
    const view = plugin.paneViews.get(id);
    if (view === undefined) throw missing();
    if (typeof view !== "number") return { view };
    return {
      mount: (element, props) => {
        const callback = plugin.paneViews.get(id);
        if (typeof callback !== "number") return Promise.reject(missing());
        return this.#mount(app, plugin, callback, element, paneProps, props);
      },
    };
  }

  /** Starts a plugin for a database's view of its layout, and gives what shows it. */
  async #layoutDrawing(plugin: Added, id: string): Promise<LayoutDrawing> {
    const [app] = await this.#start(plugin);
    const missing = () => new Error(`Its code did not attach the ${id} layout.`);
    const view = plugin.layoutViews.get(id);
    if (view === undefined) throw missing();
    if (typeof view !== "number") return { view };
    return {
      mount: (element, props, actions) => {
        const callback = plugin.layoutViews.get(id);
        if (typeof callback !== "number") return Promise.reject(missing());
        return this.#mount(app, plugin, callback, element, layoutProps, props, {
          layout: actions,
        });
      },
    };
  }

  /** Starts a plugin for a value of a property type of its own, and gives what shows it. */
  async #propertyDrawing(plugin: Added, id: string): Promise<PropertyTypeDrawing> {
    const [app] = await this.#start(plugin);
    const missing = () => new Error(`Its code did not attach a view of the ${id} type.`);
    if (!plugin.propertyViews.has(id)) throw missing();
    return {
      mount: (element, props, onChange) => {
        const callback = plugin.propertyViews.get(id);
        if (callback === undefined) return Promise.reject(missing());
        return this.#mount(app, plugin, callback, element, propertyProps, props, {
          setValue: onChange,
        });
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
    told: Pick<Slot, "onChange" | "layout" | "setValue"> = {},
  ): Promise<{ update(props: P): Promise<void>; unmount(): void }> {
    const id = plugin.manifest.id;
    const slot = `${id}:${String(++this.#nextSlot)}`;
    this.#slots.set(slot, { plugin: id, element, ...told });
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
    const views = new Set(contributes.views.map((view) => view.id));
    const layouts = new Set(contributes.layouts.map((layout) => layout.id));
    const propertyTypes = new Set(contributes.propertyTypes.map((property) => property.id));
    // Those of their own, with no extensions, which a plugin may open.
    const ownViews = new Set(
      contributes.views.filter((view) => view.extensions.length === 0).map((view) => view.id),
    );
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    /** Handles `<kind>.register` and `<kind>.unregister` for what the manifest declares. */
    const attachable = (
      kind: string,
      ids: ReadonlySet<string>,
      what: string,
      attached: Map<string, number | PanelHostView | PaneViewHost | LayoutHost>,
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
    attachable("views", views, "view", plugin.paneViews);
    attachable("layouts", layouts, "layout", plugin.layoutViews);
    attachable("propertyTypes", propertyTypes, "property type", plugin.propertyViews);
    app.handle("propertyTypes.set", (slot, value) => {
      const at = typeof slot === "string" ? this.#slots.get(slot) : undefined;
      // A plugin sets only the values its own views show.
      if (at?.plugin !== id || at.setValue === undefined) {
        throw new Error("The plugin shows no such value.");
      }
      at.setValue(value ?? null);
      return null;
    });
    /** The database a slot's layout shows, for this plugin only. */
    const laidOut = (slot: unknown): LayoutActions => {
      const at = typeof slot === "string" ? this.#slots.get(slot) : undefined;
      if (at?.plugin !== id || at.layout === undefined) {
        throw new Error("The plugin shows no such layout.");
      }
      return at.layout;
    };
    app.handle("layouts.open", (slot, row) => {
      if (typeof row !== "string") throw new Error("A row is its note's ID.");
      laidOut(slot).openRow(row);
      return null;
    });
    app.handle("layouts.set", (slot, row, key, value) => {
      if (typeof row !== "string" || typeof key !== "string") {
        throw new Error("A row's value needs its row and its key.");
      }
      laidOut(slot).setValue(row, key, value ?? null);
      return null;
    });
    app.handle("layouts.options", (slot, options) => {
      if (!isJsonObject(options)) throw new Error("A layout's options are a JSON object.");
      laidOut(slot).setOptions(options);
      return null;
    });
    app.handle("views.open", (view) => {
      const at = declared(ownViews, "view of its own", view);
      this.#options.onOpenView?.(`${id}:${at}`);
      return null;
    });
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
      views: {
        view: (pane, view) => {
          plugin.paneViews.set(declared(views, "view", pane), view);
        },
      },
      layouts: {
        view: (layout, view) => {
          plugin.layoutViews.set(declared(layouts, "layout", layout), view);
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
