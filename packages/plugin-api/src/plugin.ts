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
  const callbacks = new Map<number, () => void | Promise<void>>();
  let next = 0;
  endpoint.handle("callback", async (id) => {
    const run = typeof id === "number" ? callbacks.get(id) : undefined;
    if (run === undefined) throw new Error("The plugin has no such callback.");
    await run();
    return null;
  });
  const hello = readHello(await endpoint.call("hello", apiVersion));
  if (!satisfies(hello.api, `^${apiVersion}`)) {
    endpoint.close();
    throw new Error(`The plugin was built for API ${apiVersion}, and the app speaks ${hello.api}.`);
  }
  const context: PluginContext = {
    ...hello,
    commands: {
      async register(id, run) {
        const callback = ++next;
        callbacks.set(callback, run);
        try {
          await endpoint.call("commands.register", id, callback);
        } catch (error) {
          callbacks.delete(callback);
          throw error;
        }
        return {
          async dispose() {
            if (!callbacks.delete(callback)) return;
            await endpoint.call("commands.unregister", id);
          },
        };
      },
    },
  };
  await plugin.activate(context);
  await endpoint.call("ready");
  return endpoint;
}
