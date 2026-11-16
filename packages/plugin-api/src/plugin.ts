// What a plugin's module exports, and the context it is activated with
// (ADR 0055). Every call crosses to the app as a message, so each is
// async, each value is JSON, and a function the app will call is sent as
// a number.
import { type Json, type JsonObject, isJsonObject } from "./json.ts";
import { Endpoint, type Transport } from "./protocol.ts";
import { apiVersion, satisfies } from "./version.ts";

/** Undoes a registration. */
export interface Disposable {
  dispose(): Promise<void>;
}

/** The commands a plugin's manifest declares, attached to what they do. */
export interface Commands {
  /** Runs `run` when the command the manifest declares as `id` is chosen. */
  register(id: string, run: () => void | Promise<void>): Promise<Disposable>;
}

/** Where a code block is drawn: below its code in a note open in the app, or in its place in an HTML page, as an export. */
export type CodeBlockTarget = "editor" | "html";

/** What the app says about a code block it asks a plugin to draw. */
export interface CodeBlockContext {
  /** The fence's language, lowercase, as the manifest declares it. */
  readonly language: string;
  /** The fence's whole info string, as `mermaid title="Flow"`. */
  readonly info: string;
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
  readonly target: CodeBlockTarget;
}

/**
 * What a code block shows: HTML, an error the app shows in its place, or
 * nothing, which leaves the code alone. Draw with plain HTML and SVG: the
 * app may take scripts and event handlers out.
 */
export type CodeBlockOutput = { readonly html: string } | { readonly error: string } | null;

/** Draws a code block's text, which the app passes as written. */
export type CodeBlockRenderer = (
  source: string,
  context: CodeBlockContext,
) => CodeBlockOutput | Promise<CodeBlockOutput>;

/** The code block languages a plugin's manifest declares, attached to what draws them. */
export interface CodeBlocks {
  /** Draws code blocks in the language the manifest declares as `language` with `render`. */
  register(language: string, render: CodeBlockRenderer): Promise<Disposable>;
}

/** What a block's view is given when it mounts, and again as it changes. */
export interface BlockViewProps {
  /** What the block holds, as its note's file writes it. */
  readonly attrs: JsonObject;
  /** Whether the note can be changed here; in a note that cannot, the view only shows. */
  readonly editable: boolean;
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
}

/** The block a view shows. */
export interface ViewedBlock {
  /** Changes what the block holds, as an edit in its note that can be undone. */
  setAttrs(attrs: JsonObject): Promise<void>;
}

/** A mounted view, which the app updates and unmounts. */
export interface MountedView {
  update?(props: BlockViewProps): void;
  unmount?(): void;
}

/**
 * Shows blocks of a type the manifest declares. `mount` draws into the
 * element it is given, with any framework or none: an element of its own,
 * never one of the app's.
 */
export interface BlockView {
  mount(element: HTMLElement, props: BlockViewProps, block: ViewedBlock): MountedView | undefined;
}

/** The block types a plugin's manifest declares, attached to their views. */
export interface Blocks {
  /** Shows blocks of the type the manifest declares as `type` with `view`. */
  register(type: string, view: BlockView): Promise<Disposable>;
}

/** What a panel's view is given when it mounts, and again as it changes. */
export interface PanelProps {
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
  /** Beside a note, the note open, as the vault names it. */
  readonly note?: { readonly id: string; readonly title: string; readonly path: string };
}

/** A mounted panel, which the app updates and unmounts. */
export interface MountedPanel {
  update?(props: PanelProps): void;
  unmount?(): void;
}

/** Fills a panel the manifest declares, drawing into an element of its own. */
export interface PanelView {
  mount(element: HTMLElement, props: PanelProps): MountedPanel | undefined;
}

/** The panels a plugin's manifest declares, attached to their views. */
export interface Panels {
  /** Fills the panel the manifest declares as `id` with `view`. */
  register(id: string, view: PanelView): Promise<Disposable>;
}

/** What a pane's view is given when it mounts, and again as it changes. */
export interface PaneViewProps {
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
  /** For a view of files, the file open, by its path in the vault. */
  readonly file?: { readonly path: string };
}

/** A mounted view of a pane, which the app updates and unmounts. */
export interface MountedPaneView {
  update?(props: PaneViewProps): void;
  unmount?(): void;
}

/** Fills a pane with a view the manifest declares, drawing into an element of its own. */
export interface PaneView {
  mount(element: HTMLElement, props: PaneViewProps): MountedPaneView | undefined;
}

/** The views a plugin's manifest declares, attached to what draws them. */
export interface Views {
  /** Draws the view the manifest declares as `id` with `view`. */
  register(id: string, view: PaneView): Promise<Disposable>;
  /** Opens a view of its own, one the manifest declares with no extensions, in the pane. */
  open(id: string): Promise<void>;
}

/**
 * Where a plugin's views mount: the element made for each, by the slot
 * the app names for it. A built-in plugin is given the page's, and a
 * plugin running apart will make its own.
 */
export interface PluginSurface {
  element(slot: string): HTMLElement | undefined;
}

/** A plugin's settings, as its manifest's fields declare them and the app's settings change them. */
export interface Settings {
  /** Each field's value, by its ID: the same object until they change. */
  values(): JsonObject;
  /** Calls `listener` with the new values when they change in the app's settings. */
  onChange(listener: (values: JsonObject) => void): Disposable;
}

/** What a plugin is given when it starts. */
export interface PluginContext {
  /** The plugin's ID, from its manifest. */
  readonly id: string;
  /** The version of the API the app speaks. */
  readonly api: string;
  /** The app's language, as `en` or `pt-BR`, for the plugin's own strings. */
  readonly language: string;
  /** Which way the app's text runs. */
  readonly direction: "ltr" | "rtl";
  readonly commands: Commands;
  readonly codeBlocks: CodeBlocks;
  readonly blocks: Blocks;
  readonly panels: Panels;
  readonly views: Views;
  readonly settings: Settings;
}

/** A plugin, as its module's default export is. */
export interface Plugin {
  /** Attaches what the manifest declares; the app undoes it all when the plugin stops. */
  activate(context: PluginContext): void | Promise<void>;
}

/** Defines a plugin, for its module's default export. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** What the app calls back: a command to run, a block to draw, a view to mount. */
type Callback = (...args: Json[]) => Promise<Json>;

/** A mounted view of a block or a panel, as the plugin's end keeps it. */
interface Mounted {
  update?(props: never): void;
  unmount?(): void;
}

/** What the app answers a plugin's `hello` with. */
export interface Hello {
  readonly id: string;
  readonly api: string;
  readonly language: string;
  readonly direction: "ltr" | "rtl";
  /** The plugin's settings when it starts. */
  readonly settings: JsonObject;
}

function readHello(value: Json): Hello {
  const hello = value as Partial<Hello> | null;
  if (
    typeof hello?.id !== "string" ||
    typeof hello.api !== "string" ||
    typeof hello.language !== "string" ||
    (hello.direction !== "ltr" && hello.direction !== "rtl") ||
    !isJsonObject(hello.settings)
  ) {
    throw new Error("The app did not say who the plugin is.");
  }
  return {
    id: hello.id,
    api: hello.api,
    language: hello.language,
    direction: hello.direction,
    settings: hello.settings,
  };
}

/**
 * Starts a plugin at its end of a connection: tells the app the API it
 * was built with, activates it with what the app answers, and tells the
 * app it is ready. Returns its end, which the app closes to stop it.
 * `surface` gives the elements its views mount in.
 */
export async function startPlugin(
  plugin: Plugin,
  transport: Transport,
  surface?: PluginSurface,
): Promise<Endpoint> {
  const endpoint = new Endpoint(transport);
  const callbacks = new Map<number, Callback>();
  /** The views mounted, by the slot the app named for each. */
  const views = new Map<string, Mounted>();
  let next = 0;
  endpoint.handle("callback", async (id, ...args) => {
    const run = typeof id === "number" ? callbacks.get(id) : undefined;
    if (run === undefined) throw new Error("The plugin has no such callback.");
    return (await run(...args)) ?? null;
  });
  const hello = readHello(await endpoint.call("hello", apiVersion));
  if (!satisfies(hello.api, `^${apiVersion}`)) {
    endpoint.close();
    throw new Error(`The plugin was built for API ${apiVersion}, and the app speaks ${hello.api}.`);
  }
  /** Tells the app that `run` answers for what the manifest declares as `id` among `kind`. */
  async function attach(kind: string, id: string, run: Callback): Promise<Disposable> {
    const callback = ++next;
    callbacks.set(callback, run);
    try {
      await endpoint.call(`${kind}.register`, id, callback);
    } catch (error) {
      callbacks.delete(callback);
      throw error;
    }
    return {
      async dispose() {
        if (!callbacks.delete(callback)) return;
        await endpoint.call(`${kind}.unregister`, id);
      },
    };
  }
  /**
   * What the app calls to mount a view in the element of a slot it names,
   * to update the view and to unmount it.
   */
  function viewCallback(
    mount: (element: HTMLElement, props: never, slot: string) => Mounted | undefined,
  ): Callback {
    return (action, slot, props) =>
      // What a view throws, the app is told of.
      Promise.resolve().then(() => {
        if (typeof slot !== "string") throw new Error("The app named no view.");
        // As the app sends them: a block's or a panel's props.
        const viewProps = props as never;
        switch (action) {
          case "mount": {
            const element = surface?.element(slot);
            if (element === undefined) throw new Error("The app gave the view no element.");
            views.set(slot, mount(element, viewProps, slot) ?? {});
            return null;
          }
          case "update":
            views.get(slot)?.update?.(viewProps);
            return null;
          case "unmount":
            views.get(slot)?.unmount?.();
            views.delete(slot);
            return null;
          default:
            throw new Error(`A view cannot ${JSON.stringify(action)}.`);
        }
      });
  }
  let settings = hello.settings;
  const settingsListeners = new Set<(values: JsonObject) => void>();
  endpoint.handle("settings.changed", (values) => {
    if (!isJsonObject(values)) throw new Error("Settings are a JSON object.");
    settings = values;
    for (const listener of settingsListeners) listener(values);
    return null;
  });
  const context: PluginContext = {
    id: hello.id,
    api: hello.api,
    language: hello.language,
    direction: hello.direction,
    settings: {
      values: () => settings,
      onChange(listener) {
        // A new function each time, so that each registration has its own disposal.
        const each = (values: JsonObject) => {
          listener(values);
        };
        settingsListeners.add(each);
        return {
          dispose() {
            settingsListeners.delete(each);
            return Promise.resolve();
          },
        };
      },
    },
    commands: {
      register: (id, run) =>
        attach("commands", id, async () => {
          await run();
          return null;
        }),
    },
    codeBlocks: {
      register: (language, render) =>
        attach("codeBlocks", language, async (source, context) => {
          const output = await render(
            typeof source === "string" ? source : "",
            context as unknown as CodeBlockContext,
          );
          return output ?? null;
        }),
    },
    blocks: {
      register: (type, view) =>
        attach(
          "blocks",
          type,
          viewCallback((element, props: BlockViewProps, slot) =>
            view.mount(element, props, {
              async setAttrs(attrs) {
                await endpoint.call("blocks.change", slot, attrs);
              },
            }),
          ),
        ),
    },
    panels: {
      register: (id, view) =>
        attach(
          "panels",
          id,
          viewCallback((element, props: PanelProps) => view.mount(element, props)),
        ),
    },
    views: {
      register: (id, view) =>
        attach(
          "views",
          id,
          viewCallback((element, props: PaneViewProps) => view.mount(element, props)),
        ),
      async open(id) {
        await endpoint.call("views.open", id);
      },
    },
  };
  await plugin.activate(context);
  await endpoint.call("ready");
  return endpoint;
}
