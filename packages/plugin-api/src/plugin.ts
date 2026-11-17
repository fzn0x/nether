// What a plugin's module exports, and the context it is activated with
// (ADR 0055). Every call crosses to the app as a message, so each is
// async, each value is JSON, and a function the app will call is sent as
// a number.
import { type Json, type JsonObject, isJsonObject } from "./json.ts";
import { type Service, isService } from "./manifest.ts";
import { Endpoint, type Transport } from "./protocol.ts";
import { apiVersion, satisfies } from "./version.ts";

/** Undoes a registration. */
export interface Disposable {
  dispose(): Promise<void>;
}

/**
 * The note something is drawn for or beside, as the vault names it, with
 * the day it stands for when it is a daily note, as `2026-11-17`.
 */
export interface NoteContext {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  /** The day a daily note is for, as the vault's daily notes settings read its path. */
  readonly day?: string;
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
  /** The note the block is in, when the app knows it. */
  readonly note?: NoteContext;
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
  /** Beside a note, the note open, as the vault names it, with its day for a daily note. */
  readonly note?: NoteContext;
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

/** A database's row, as a layout shows it. */
export interface LayoutRow {
  /** The row's note's ID. */
  readonly id: string;
  readonly title: string;
  /** The values of the properties the view shows, by key; one the row has not is left out. */
  readonly values: JsonObject;
}

/** A property a layout's view shows. */
export interface LayoutProperty {
  readonly key: string;
  readonly name: string;
  /** Its type, as `text`, `number`, `select` or `date`. */
  readonly type: string;
}

/** What a layout's view is given when it mounts, and again as the rows change. */
export interface LayoutProps {
  /** The database's view: its name, and the layout's options, as the plugin set them. */
  readonly view: { readonly name: string; readonly options: JsonObject };
  /** The rows the view's filter finds, in its order. */
  readonly rows: readonly LayoutRow[];
  /** When the view groups its rows: each group's value, and its rows' IDs. */
  readonly groups?: readonly { readonly value: Json; readonly rows: readonly string[] }[];
  /** The properties the view shows, in order. */
  readonly properties: readonly LayoutProperty[];
  /** Whether the database can be changed here. */
  readonly editable: boolean;
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
}

/** The database a layout's view shows, which it changes through the app. */
export interface LaidOut {
  /** Opens a row's note, as a link does. */
  openRow(id: string): Promise<void>;
  /** Sets a property of a row, as its note's frontmatter holds it. */
  setValue(row: string, key: string, value: Json): Promise<void>;
  /** Keeps the layout's options in the view, in the database's schema. */
  setOptions(options: JsonObject): Promise<void>;
}

/** A mounted view of a layout, which the app updates and unmounts. */
export interface MountedLayout {
  update?(props: LayoutProps): void;
  unmount?(): void;
}

/** Shows a database's rows in a layout the manifest declares, drawing into an element of its own. */
export interface LayoutView {
  mount(element: HTMLElement, props: LayoutProps, database: LaidOut): MountedLayout | undefined;
}

/** The layouts a plugin's manifest declares, attached to their views. */
export interface Layouts {
  /** Shows the layout the manifest declares as `id` with `view`. */
  register(id: string, view: LayoutView): Promise<Disposable>;
}

/** What a property type's view is given when it mounts, and again as the value changes. */
export interface PropertyViewProps {
  /** The property's key, in the note's frontmatter. */
  readonly key: string;
  /** Its value, as the app's type the plugin's type stores as holds it; null when empty. */
  readonly value: Json;
  /** Whether the note can be changed here. */
  readonly editable: boolean;
  /** Whether the page it shows on is light or dark. */
  readonly theme: "light" | "dark";
}

/** The property a view shows. */
export interface ViewedProperty {
  /** Sets its value, which the app checks as the type it stores as before writing it. */
  setValue(value: Json): Promise<void>;
}

/** A mounted view of a property, which the app updates and unmounts. */
export interface MountedProperty {
  update?(props: PropertyViewProps): void;
  unmount?(): void;
}

/** Shows and edits values of a property type the manifest declares, drawing into an element of its own. */
export interface PropertyView {
  mount(
    element: HTMLElement,
    props: PropertyViewProps,
    property: ViewedProperty,
  ): MountedProperty | undefined;
}

/** The property types a plugin's manifest declares, attached to their views. */
export interface PropertyTypes {
  /** Shows values of the type the manifest declares as `id` with `view`. */
  register(id: string, view: PropertyView): Promise<Disposable>;
}

/**
 * Where a plugin's views mount: the element made for each, by the slot
 * the app names for it. A built-in plugin is given the page's, and a
 * plugin running apart will make its own.
 */
export interface PluginSurface {
  element(slot: string): HTMLElement | undefined;
  /** Lets go of the element of a slot whose view has unmounted. */
  release?(slot: string): void;
}

/** A plugin's settings, as its manifest's fields declare them and the app's settings change them. */
export interface Settings {
  /** Each field's value, by its ID: the same object until they change. */
  values(): JsonObject;
  /** Calls `listener` with the new values when they change in the app's settings. */
  onChange(listener: (values: JsonObject) => void): Disposable;
}

/** A note of the vault, as a plugin lists it. */
export interface VaultNote {
  /** Its ID, which stays when it is renamed or moved. */
  readonly id: string;
  /** Its path in the vault, as `Projects/Plan.md`. */
  readonly path: string;
  readonly title: string;
}

/**
 * The vault's notes and files, as far as the plugin's manifest asks
 * (ADR 0064): reading with `vault:read`, changing with `vault:write`. The
 * app refuses any other call, and any path in a hidden folder.
 */
export interface PluginVault {
  /** The vault's notes. */
  notes(): Promise<readonly VaultNote[]>;
  /** A note's Markdown, frontmatter and all, as it is now. */
  read(path: string): Promise<string>;
  /** The paths of the vault's files that are not notes, as images and PDFs. */
  files(): Promise<readonly string[]>;
  /** A file's bytes, up to 20 MB. */
  readFile(path: string): Promise<Uint8Array>;
  /** Changes a note to `text`, or makes it, as an edit the app makes; its path ends in `.md`. */
  write(path: string, text: string): Promise<void>;
  /** Moves a note to the vault's trash. */
  remove(path: string): Promise<void>;
  /** Calls `listener` with the paths of notes as they change. */
  onChange(listener: (paths: readonly string[]) => void): Promise<Disposable>;
}

/**
 * The person's access to one account at one service, as a plugin sees it
 * (ADR 0090): never its token, its password, or a feed's secret address.
 */
export interface Connection {
  readonly id: string;
  readonly service: Service;
  /** What the person calls it, as "Work calendar". */
  readonly name: string;
  /** Who it acts as there, as `octocat`, when the service says. */
  readonly account?: string;
  /** The base address its requests go under, without its secret: an ICS feed's host alone. */
  readonly address: string;
  /** The service's web host, for links to it, as `github.com`. */
  readonly web?: string;
  /** Where the app keeps it: on this device, or on the account's server. */
  readonly where: "device" | "server";
}

/**
 * The person's connections to the services the manifest asks for, as
 * `connection:<service>` permissions. The app adds them, in a dialog of its
 * own, and keeps their secrets.
 */
export interface Connections {
  /** The connections to the services the plugin asked for. */
  list(): Promise<readonly Connection[]>;
  /** Asks the app to show the person how to add a connection to a service. */
  add(service: Service): Promise<void>;
  /** Calls `listener` with the connections again when they change. */
  onChange(listener: (connections: readonly Connection[]) => void): Promise<Disposable>;
}

/** The methods a request through the app may use. */
export const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "PROPFIND",
  "REPORT",
] as const;

export type HttpMethod = (typeof httpMethods)[number];

/** A request the app sends for a plugin, with a connection's credential. */
export interface HttpRequest {
  /** The connection's ID. */
  readonly connection: string;
  /**
   * Resolved against the connection's address: none or `""` is the address
   * itself, as an ICS feed; a path goes under it; a full address must be at
   * one of the connection's origins.
   */
  readonly url?: string;
  /** `GET` unless it says another. */
  readonly method?: HttpMethod;
  /** Its headers, but for `Authorization`, `Cookie`, `Host` and `Proxy-*`, which the app refuses. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Up to 1 MB. */
  readonly body?: string;
  /** How the answer's body is given: as text, unless `bytes`. */
  readonly as?: "text" | "bytes";
}

/** What a request through the app was answered with. */
export interface HttpResponse {
  readonly status: number;
  /** The headers a plugin needs, by their lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Its body as text, unless the request asked for bytes. */
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

/** Requests the app sends for a plugin to the services its connections reach. */
export interface Http {
  /** Sends a request with its connection's credential; rejects with why the app would not. */
  fetch(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * What a plugin keeps on this device for a vault, as a cache: JSON values
 * by key, outside the vault's folder, so it never syncs. Up to 5 MB.
 */
export interface PluginStore {
  /** A value kept; undefined when none is. */
  get(key: string): Promise<Json | undefined>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
  /** The keys of the values kept. */
  keys(): Promise<readonly string[]>;
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
  readonly layouts: Layouts;
  readonly propertyTypes: PropertyTypes;
  readonly settings: Settings;
  readonly vault: PluginVault;
  /** The person's connections, as far as the manifest asks (ADR 0090). */
  readonly connections: Connections;
  /** Requests through the app, with a connection's credential. */
  readonly http: Http;
  /** What the plugin keeps on this device for the vault. */
  readonly store: PluginStore;
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

/** Bytes the app sends as Base64, as a `Uint8Array`. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function readTexts(value: Json): string[] {
  return Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];
}

/** Connections as the app lists them; any it gives that do not read are left out. */
export function readConnections(value: Json): Connection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each): Connection[] => {
    if (!isJsonObject(each)) return [];
    const { id, service, name, account, address, web, where } = each;
    if (
      typeof id !== "string" ||
      !isService(service) ||
      typeof name !== "string" ||
      typeof address !== "string" ||
      (where !== "device" && where !== "server")
    ) {
      return [];
    }
    return [
      {
        id,
        service,
        name,
        address,
        where,
        ...(typeof account === "string" ? { account } : {}),
        ...(typeof web === "string" ? { web } : {}),
      },
    ];
  });
}

/** An answer to a request through the app, as it crosses. */
function readResponse(value: Json): HttpResponse {
  if (!isJsonObject(value) || typeof value.status !== "number" || !isJsonObject(value.headers)) {
    throw new Error("The app gave no answer to the request.");
  }
  const headers: Record<string, string> = {};
  for (const [name, text] of Object.entries(value.headers)) {
    if (typeof text === "string") headers[name] = text;
  }
  const { status, text, base64 } = value;
  return {
    status,
    headers,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof base64 === "string" ? { bytes: fromBase64(base64) } : {}),
  };
}

function readNotes(value: Json): VaultNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each) => {
    if (!isJsonObject(each)) return [];
    const { id, path, title } = each;
    return typeof id === "string" && typeof path === "string" && typeof title === "string"
      ? [{ id, path, title }]
      : [];
  });
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
            try {
              views.set(slot, mount(element, viewProps, slot) ?? {});
            } catch (error) {
              surface?.release?.(slot);
              throw error;
            }
            return null;
          }
          case "update":
            views.get(slot)?.update?.(viewProps);
            return null;
          case "unmount":
            try {
              views.get(slot)?.unmount?.();
            } finally {
              views.delete(slot);
              surface?.release?.(slot);
            }
            return null;
          default:
            throw new Error(`A view cannot ${JSON.stringify(action)}.`);
        }
      });
  }
  const changeListeners = new Set<(paths: readonly string[]) => void>();
  endpoint.handle("vault.changed", (paths) => {
    const changed = readTexts(paths ?? null);
    for (const listener of changeListeners) listener(changed);
    return null;
  });
  let settings = hello.settings;
  const settingsListeners = new Set<(values: JsonObject) => void>();
  endpoint.handle("settings.changed", (values) => {
    if (!isJsonObject(values)) throw new Error("Settings are a JSON object.");
    settings = values;
    for (const listener of settingsListeners) listener(values);
    return null;
  });
  const connectionListeners = new Set<(connections: readonly Connection[]) => void>();
  endpoint.handle("connections.changed", (value) => {
    const changed = readConnections(value ?? null);
    for (const listener of connectionListeners) listener(changed);
    return null;
  });
  const context: PluginContext = {
    id: hello.id,
    api: hello.api,
    language: hello.language,
    direction: hello.direction,
    connections: {
      list: async () => readConnections(await endpoint.call("connections.list")),
      async add(service) {
        await endpoint.call("connections.add", service);
      },
      async onChange(listener) {
        // A new function each time, so that each has its own disposal.
        const each = (connections: readonly Connection[]) => {
          listener(connections);
        };
        if (connectionListeners.size === 0) await endpoint.call("connections.watch");
        connectionListeners.add(each);
        return {
          async dispose() {
            if (!connectionListeners.delete(each)) return;
            if (connectionListeners.size === 0) await endpoint.call("connections.unwatch");
          },
        };
      },
    },
    http: {
      async fetch(request) {
        const { connection, url, method, headers, body, as } = request;
        const answer = await endpoint.call("http.fetch", {
          connection,
          url: url ?? "",
          method: method ?? "GET",
          headers: { ...headers },
          ...(body === undefined ? {} : { body }),
          as: as ?? "text",
        });
        return readResponse(answer);
      },
    },
    store: {
      async get(key) {
        const answer = await endpoint.call("store.get", key);
        return isJsonObject(answer) && "value" in answer ? answer.value : undefined;
      },
      async set(key, value) {
        await endpoint.call("store.set", key, value);
      },
      async delete(key) {
        await endpoint.call("store.delete", key);
      },
      keys: async () => readTexts(await endpoint.call("store.keys")),
    },
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
    vault: {
      notes: async () => readNotes(await endpoint.call("vault.notes")),
      async read(path) {
        const text = await endpoint.call("vault.read", path);
        if (typeof text !== "string") throw new Error("The app gave no note.");
        return text;
      },
      files: async () => readTexts(await endpoint.call("vault.files")),
      async readFile(path) {
        const data = await endpoint.call("vault.readFile", path);
        if (typeof data !== "string") throw new Error("The app gave no file.");
        return fromBase64(data);
      },
      async write(path, text) {
        await endpoint.call("vault.write", path, text);
      },
      async remove(path) {
        await endpoint.call("vault.remove", path);
      },
      async onChange(listener) {
        // A new function each time, so that each has its own disposal.
        const each = (paths: readonly string[]) => {
          listener(paths);
        };
        if (changeListeners.size === 0) await endpoint.call("vault.watch");
        changeListeners.add(each);
        return {
          async dispose() {
            if (!changeListeners.delete(each)) return;
            if (changeListeners.size === 0) await endpoint.call("vault.unwatch");
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
    layouts: {
      register: (id, view) =>
        attach(
          "layouts",
          id,
          viewCallback((element, props: LayoutProps, slot) =>
            view.mount(element, props, {
              async openRow(row) {
                await endpoint.call("layouts.open", slot, row);
              },
              async setValue(row, key, value) {
                await endpoint.call("layouts.set", slot, row, key, value);
              },
              async setOptions(options) {
                await endpoint.call("layouts.options", slot, options);
              },
            }),
          ),
        ),
    },
    propertyTypes: {
      register: (id, view) =>
        attach(
          "propertyTypes",
          id,
          viewCallback((element, props: PropertyViewProps, slot) =>
            view.mount(element, props, {
              async setValue(value) {
                await endpoint.call("propertyTypes.set", slot, value);
              },
            }),
          ),
        ),
    },
  };
  await plugin.activate(context);
  await endpoint.call("ready");
  return endpoint;
}
