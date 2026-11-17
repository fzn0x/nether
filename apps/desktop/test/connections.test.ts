// The person's connections and Nether's integrations (ADR 0090): the hub
// keeps connections with their secrets apart and sends plugins' requests
// with them; the host lets Nether's own plugins, run apart, reach the
// connections their manifests ask for, and keep a store on the device;
// a plugin from a vault that asks for a connection does not run; and a
// daily note's day is read back from its path.
import type { KeptConnection } from "@nether/integrations";
import {
  type Plugin,
  type PluginContext,
  definePlugin,
  portTransport,
  startPlugin,
} from "@nether/plugin-api";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionStore } from "../src/backend.ts";
import { ConnectionsHub } from "../src/connections.ts";
import { dayOfName, dayOfNote } from "../src/noteDay.ts";
import { BlockRegistry } from "../src/plugins/blocks.ts";
import { CodeBlockRegistry } from "../src/plugins/codeBlocks.ts";
import { PluginStoreAccess, refusedConnections, storeLimit } from "../src/plugins/connections.ts";
import { readFolders } from "../src/plugins/folders.ts";
import type { FrameOpener, FrameRequest } from "../src/plugins/frame.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { LayoutRegistry } from "../src/plugins/layouts.ts";
import { PanelRegistry } from "../src/plugins/panels.ts";
import { PropertyTypeRegistry } from "../src/plugins/propertyTypes.ts";
import { PropertyChangeRegistry } from "../src/plugins/propertyChanges.ts";
import { CommandRegistry } from "../src/plugins/registry.ts";
import { isOn } from "../src/plugins/state.ts";
import { ViewRegistry } from "../src/plugins/views.ts";
import { defaultSettings } from "../src/templates.ts";

const feedUrl = "https://calendar.example.org/private-abc123/basic.ics";
const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

/** Connections kept in memory, with a fetch that answers from a list and records each request. */
function memoryStore(answers: (() => Response)[] = []) {
  let kept: KeptConnection[] = [];
  const secrets = new Map<string, string>();
  const sent: { url: string; authorization: string | null }[] = [];
  let next = 0;
  const store: ConnectionStore = {
    list: () => Promise.resolve(kept.map((each) => ({ ...each }))),
    save(connection) {
      const made = connection.id === "" ? { ...connection, id: `c${String(++next)}` } : connection;
      kept = [...kept.filter((each) => each.id !== made.id), made];
      return Promise.resolve(made);
    },
    setSecret(id, secret) {
      if (id === "refuse") return Promise.reject(new Error("The keychain is locked."));
      secrets.set(id, secret);
      return Promise.resolve();
    },
    secret: (id) => Promise.resolve(secrets.get(id) ?? ""),
    remove(id) {
      kept = kept.filter((each) => each.id !== id);
      secrets.delete(id);
      return Promise.resolve();
    },
    fetch: (input, init) => {
      sent.push({
        url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const answer = answers.shift();
      return answer === undefined ? Promise.reject(new Error(feedUrl)) : Promise.resolve(answer());
    },
    http: true,
  };
  return { store, secrets, sent };
}

function feed(): KeptConnection {
  return {
    id: "",
    service: "ics",
    name: "Work",
    account: "ada",
    address: "calendar.example.org",
    web: "",
    origins: ["https://calendar.example.org"],
  };
}

describe("ConnectionsHub", () => {
  it("keeps a connection with its secret apart, and tells who listens", async () => {
    const { store, secrets } = memoryStore([() => new Response(ics)]);
    const hub = new ConnectionsHub(store);
    let told = 0;
    const stop = hub.subscribe(() => {
      told++;
    });
    expect(hub.http).toBe(true);
    expect(await hub.check(feed(), { address: feedUrl })).toBeUndefined();
    const kept = await hub.add(feed(), { address: feedUrl, user: "ada", password: "p" });
    expect(kept.id).toBe("c1");
    expect(JSON.parse(secrets.get("c1") ?? "{}")).toEqual({
      address: feedUrl,
      user: "ada",
      password: "p",
    });
    await hub.rename(kept, "Office");
    expect((await hub.list()).map((each) => each.name)).toEqual(["Office"]);
    stop();
    await hub.remove(kept.id);
    expect(await hub.list()).toEqual([]);
    expect(told).toBe(2);
  });

  it("forgets a connection whose secret the keychain would not keep", async () => {
    const { store } = memoryStore();
    store.save = (connection) => Promise.resolve({ ...connection, id: "refuse" });
    const hub = new ConnectionsHub(store);
    await expect(hub.add(feed(), { address: feedUrl })).rejects.toThrow("The keychain is locked.");
    expect(await hub.list()).toEqual([]);
  });

  it("gives the host connections as plugins see them, and sends with the secret", async () => {
    const { store, sent } = memoryStore([() => new Response(ics)]);
    const hub = new ConnectionsHub(store);
    const asked: string[] = [];
    const host = hub.host((service) => asked.push(service));
    await hub.add(feed(), { address: feedUrl, user: "ada", password: "p" });
    expect(await host.list()).toEqual([
      {
        id: "c1",
        service: "ics",
        name: "Work",
        account: "ada",
        address: "calendar.example.org",
        where: "device",
      },
    ]);
    const answer = await host.fetch(
      { connection: "c1", url: "", method: "GET", headers: {}, as: "text" },
      new AbortController().signal,
    );
    expect(answer.text).toBe(ics);
    expect(sent).toEqual([{ url: feedUrl, authorization: `Basic ${btoa("ada:p")}` }]);
    await expect(
      host.fetch(
        { connection: "c9", url: "", method: "GET", headers: {}, as: "text" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("The plugin has no such connection.");
    host.add("ics");
    expect(asked).toEqual(["ics"]);
  });
});

async function vaultWith(files: Readonly<Record<string, string>> = {}): Promise<Vault> {
  const vault = new Vault(new MemoryFiles({ "a.md": "A", ...files }), new MemoryStore());
  await vault.open();
  return vault;
}

describe("PluginStoreAccess", () => {
  it("keeps JSON by key in the vault's index, in turn, and forgets it all when empty", async () => {
    const vault = await vaultWith();
    const store = new PluginStoreAccess(() => vault.settings, "calendar");
    expect(await store.get("feed")).toBeUndefined();
    await Promise.all([store.set("a", 1), store.set("b", { c: [true, null] })]);
    expect(await store.keys()).toEqual(["a", "b"]);
    expect(await store.get("b")).toEqual({ c: [true, null] });
    await store.delete("a");
    await store.delete("missing");
    expect(await store.keys()).toEqual(["b"]);
    await store.delete("b");
    expect(await vault.settings.setting("plugin-store/calendar")).toBeUndefined();
    // Another plugin keeps its own.
    expect(await new PluginStoreAccess(() => vault.settings, "other").keys()).toEqual([]);
  });

  it("refuses more than its limit, and reads nothing from what does not read", async () => {
    const vault = await vaultWith();
    const store = new PluginStoreAccess(() => vault.settings, "calendar");
    await expect(store.set("big", "x".repeat(storeLimit))).rejects.toThrow(
      "A plugin keeps 5 MB at most on the device for a vault.",
    );
    // The next change still happens, after the one that failed.
    await store.set("small", 1);
    expect(await store.keys()).toEqual(["small"]);
    await vault.settings.setSetting("plugin-store/calendar", new TextEncoder().encode("{"));
    expect(await store.keys()).toEqual([]);
    await vault.settings.setSetting("plugin-store/calendar", new TextEncoder().encode("[1]"));
    expect(await store.get("small")).toBeUndefined();
    const none = new PluginStoreAccess(() => undefined, "calendar");
    await expect(none.get("a")).rejects.toThrow("No vault is open for the plugin.");
  });
});

/** A calendar-like plugin's manifest, asking for ICS feeds. */
const integration = {
  id: "feeds",
  name: "Feeds",
  version: "1.0.0",
  api: "^0.1.1",
  permissions: ["connection:ics"],
  contributes: { commands: [{ id: "read", name: "Read" }] },
};

describe("PluginHost, a built-in plugin that runs apart", () => {
  /** Opens a frame that runs `plugin` at the other end of a port, as the frame's worker would. */
  function frames(plugin: Plugin) {
    const opened: FrameRequest[] = [];
    const open: FrameOpener = (request) => {
      opened.push(request);
      const { port1, port2 } = new MessageChannel();
      void startPlugin(plugin, portTransport(port2));
      return {
        port: port1,
        close() {
          port1.close();
          port2.close();
        },
      };
    };
    return { open, opened };
  }

  const registries = () => ({
    commands: new CommandRegistry(),
    codeBlocks: new CodeBlockRegistry(),
    blocks: new BlockRegistry(),
    panels: new PanelRegistry(),
    views: new ViewRegistry(),
    layouts: new LayoutRegistry(),
    propertyTypes: new PropertyTypeRegistry(),
    propertyChanges: new PropertyChangeRegistry(),
  });

  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  /** Runs `use` with the plugin's context, through a host with a hub and a vault's store. */
  async function withPlugin(
    manifest: unknown,
    use: (context: PluginContext) => Promise<void>,
    answers: (() => Response)[] = [],
  ) {
    const { store, sent } = memoryStore(answers);
    const hub = new ConnectionsHub(store);
    await hub.add({ ...feed(), id: "" }, { address: feedUrl });
    await hub.add(
      {
        ...feed(),
        service: "github",
        name: "GitHub",
        origins: ["https://api.github.com"],
      },
      { token: "t" },
    );
    const vault = await vaultWith();
    const added: string[] = [];
    let result: unknown;
    const plugin = definePlugin({
      async activate(context) {
        await context.commands.register("read", async () => {
          try {
            await use(context);
            result = "done";
          } catch (error) {
            result = error instanceof Error ? error.message : String(error);
          }
        });
      },
    });
    const frame = frames(plugin);
    const commands = new CommandRegistry();
    const host = new PluginHost(
      { ...registries(), commands },
      {
        language: "en",
        direction: "ltr",
        openFrame: frame.open,
        connections: hub.host((service) => added.push(service)),
        settings: () => vault.settings,
      },
    );
    close = () => {
      host.close();
    };
    const code = () => Promise.resolve("the calendar's module");
    expect(host.add({ manifest, apart: code, off: true })).toEqual([]);
    expect(commands.get("feeds:read")?.fromVault).toBeUndefined();
    commands.get("feeds:read")?.run();
    await expect.poll(() => result).toBeDefined();
    return { result, sent, added, opened: frame.opened, hub, vault };
  }

  it("runs in a frame with the app's code, and reaches only the connections it asked for", async () => {
    let listed: unknown;
    const { result, sent, added, opened } = await withPlugin(
      integration,
      async (context) => {
        listed = (await context.connections.list()).map((each) => each.service);
        await context.connections.add("ics");
        const answer = await context.http.fetch({ connection: "c1" });
        listed = [listed, answer.status, answer.text];
      },
      [() => new Response(ics, { status: 200 })],
    );
    expect(result).toBe("done");
    expect(opened.map(({ code, network }) => [code, network])).toEqual([
      ["the calendar's module", false],
    ]);
    expect(listed).toEqual([["ics"], 200, ics]);
    expect(added).toEqual(["ics"]);
    expect(sent).toEqual([{ url: feedUrl, authorization: null }]);
  });

  it("refuses a connection of a service it did not ask for, and a header only the app sets", async () => {
    for (const [use, message] of [
      [
        (context: PluginContext) => context.http.fetch({ connection: "c2" }),
        "The plugin has no such connection.",
      ],
      [
        (context: PluginContext) =>
          context.http.fetch({ connection: "c1", headers: { Authorization: "Bearer x" } }),
        "Only the app sets the header Authorization.",
      ],
      [
        (context: PluginContext) => context.connections.add("github"),
        'The plugin did not ask for connections to "github".',
      ],
    ] as const) {
      const { result } = await withPlugin(integration, async (context) => {
        await use(context);
      });
      expect(result).toBe(message);
    }
  });

  it("refuses connections to a plugin that asked for none", async () => {
    const { result } = await withPlugin({ ...integration, permissions: [] }, async (context) => {
      await context.connections.list();
    });
    expect(result).toBe("The plugin did not ask for any connection.");
  });

  it("hears when the connections change, and keeps a store on the device", async () => {
    let heard = 0;
    const { result, hub, vault } = await withPlugin(integration, async (context) => {
      await context.connections.onChange((each) => {
        heard = each.length;
      });
      await context.store.set("feed", { read: 1 });
      if (JSON.stringify(await context.store.get("feed")) !== '{"read":1}') {
        throw new Error("The store did not keep it.");
      }
      if ((await context.store.keys()).join() !== "feed") throw new Error("No keys.");
      await context.store.delete("feed");
      if ((await context.store.get("feed")) !== undefined) throw new Error("Not forgotten.");
    });
    expect(result).toBe("done");
    await hub.add({ ...feed(), name: "Home" }, { address: feedUrl });
    // Both feeds, and not the GitHub connection.
    await expect.poll(() => heard).toBe(2);
    expect(await vault.settings.setting("plugin-store/feeds")).toBeUndefined();
  });

  it("does not run a plugin from a vault that asks for a connection", async () => {
    const host = new PluginHost(registries(), { language: "en", direction: "ltr" });
    expect(host.addFolder({ manifest: integration, code: "" })).toEqual([
      "It asks for connection:ics, which only Nether's own plugins may use for now.",
    ]);
    expect(refusedConnections({ permissions: ["vault:read"] })).toBeUndefined();
    expect(refusedConnections({ permissions: ["connection:ics", "connection:github"] })).toBe(
      "It asks for connection:ics and connection:github, which only Nether's own plugins may use for now.",
    );
    const vault = await vaultWith({
      ".nether/plugins/feeds/manifest.json": JSON.stringify(integration),
      ".nether/plugins/feeds/main.js": "export default {}",
    });
    const [entry] = await readFolders(vault, new Set());
    expect(entry?.problems).toEqual([
      "It asks for connection:ics, which only Nether's own plugins may use for now.",
    ]);
  });

  it("starts an integration off until the vault turns it on", () => {
    expect(isOn({ on: {} }, "calendar", true)).toBe(false);
    expect(isOn({ on: { calendar: true } }, "calendar", true)).toBe(true);
    expect(isOn({ on: {} }, "tags")).toBe(true);
  });
});

describe("dayOfNote", () => {
  it("reads a daily note's day back from its path by the vault's format", () => {
    expect(dayOfNote("2026-11-17.md", defaultSettings.day)).toBe("2026-11-17");
    expect(dayOfNote("Ideas.md", defaultSettings.day)).toBeUndefined();
    expect(dayOfNote("2026-02-30.md", defaultSettings.day)).toBeUndefined();
    expect(dayOfNote("2026-11-17.canvas", defaultSettings.day)).toBeUndefined();
    const journal = { ...defaultSettings.day, folder: "Journal", format: "YYYY/MM/YYYY-MM-DD" };
    expect(dayOfNote("Journal/2026/11/2026-11-17.md", journal)).toBe("2026-11-17");
    expect(dayOfNote("journal/2026/11/2026-11-17.md", journal)).toBe("2026-11-17");
    expect(dayOfNote("Notes/2026/11/2026-11-17.md", journal)).toBeUndefined();
  });

  it("reads names, ordinals, two-digit years and literal text, checked by writing them again", () => {
    expect(dayOfName("Tuesday, November 17th 2026", "dddd, MMMM Do YYYY")).toBe("2026-11-17");
    // The weekday must agree with the date.
    expect(dayOfName("Monday, November 17th 2026", "dddd, MMMM Do YYYY")).toBeUndefined();
    expect(dayOfName("17 Nov 26", "D MMM YY")).toBe("2026-11-17");
    expect(dayOfName("Day 2026.11.17", "[Day] YYYY.MM.DD")).toBe("2026-11-17");
    expect(dayOfName("2026-W47", "GGGG-[W]WW")).toBeUndefined();
    expect(dayOfName("17 Smarch 2026", "D MMMM YYYY")).toBeUndefined();
  });
});
