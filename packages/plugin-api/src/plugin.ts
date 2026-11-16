// What a plugin's module exports, and the context it is activated with
// (ADR 0055). Every call crosses to the app as a message, so each is
// async, each value is JSON, and a function the app will call is sent as
// a number.
import type { Json } from "./json.ts";
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

/** What the app calls back: a command to run, a block to draw. */
type Callback = (...args: Json[]) => Promise<Json>;

/** What the app answers a plugin's `hello` with. */
export interface Hello {
  readonly id: string;
  readonly api: string;
  readonly language: string;
  readonly direction: "ltr" | "rtl";
}

function readHello(value: Json): Hello {
  const hello = value as Partial<Hello> | null;
  if (
    typeof hello?.id !== "string" ||
    typeof hello.api !== "string" ||
    typeof hello.language !== "string" ||
    (hello.direction !== "ltr" && hello.direction !== "rtl")
  ) {
    throw new Error("The app did not say who the plugin is.");
  }
  return { id: hello.id, api: hello.api, language: hello.language, direction: hello.direction };
}

/**
 * Starts a plugin at its end of a connection: tells the app the API it
 * was built with, activates it with what the app answers, and tells the
 * app it is ready. Returns its end, which the app closes to stop it.
 */
export async function startPlugin(plugin: Plugin, transport: Transport): Promise<Endpoint> {
  const endpoint = new Endpoint(transport);
  const callbacks = new Map<number, Callback>();
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
  const context: PluginContext = {
    ...hello,
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
  };
  await plugin.activate(context);
  await endpoint.call("ready");
  return endpoint;
}
