// The plugin host and the command registry (ADR 0055): a built-in
// plugin's commands show before its code loads, its code loads when one
// is first chosen, and the same plugin runs within the page and through a
// port, as a sandboxed one will.
import { type Plugin, type Transport, definePlugin, portTransport } from "@nether/plugin-api";
import { describe, expect, it } from "vitest";
import { coreMenus, commandIds } from "../src/commands.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { type Command, CommandRegistry } from "../src/plugins/registry.ts";

function command(id: string, keys: readonly string[] = [], plugin?: string): Command {
  return {
    id,
    name: () => id,
    menu: "plugins",
    keys,
    enabled: () => true,
    run: () => undefined,
    ...(plugin === undefined ? {} : { plugin }),
  };
}

describe("CommandRegistry", () => {
  it("keeps commands in the order they came, telling listeners of each change", () => {
    const registry = new CommandRegistry();
    let told = 0;
    registry.subscribe(() => {
      told++;
    });
    const removeA = registry.add(command("a"));
    registry.add(command("b"));
    const before = registry.all();
    expect(before.map((each) => each.id)).toEqual(["a", "b"]);
    expect(registry.all()).toBe(before);
    removeA();
    removeA();
    expect(registry.all().map((each) => each.id)).toEqual(["b"]);
    expect(registry.get("a")).toBeUndefined();
    expect(told).toBe(3);
  });

  it("refuses a second command with the same ID", () => {
    const registry = new CommandRegistry();
    registry.add(command("a"));
    expect(() => registry.add(command("a"))).toThrow("A command a is there already.");
  });

  it("leaves keys another command had first to that command", () => {
    const registry = new CommandRegistry();
    registry.add(command("newNote", ["Mod+N"]));
    registry.add(command("word-count:count", ["Mod+N", "Mod+Shift+K"], "word-count"));
    registry.add(command("other:only", ["Mod+N"], "other"));
    expect(registry.defaults()).toEqual({
      newNote: ["Mod+N"],
      "word-count:count": ["Mod+Shift+K"],
    });
  });
});

describe("the app's menus", () => {
  it("hold every one of the app's commands, each once", () => {
    const inMenus = coreMenus.flatMap((menu) => menu.entries.filter((id) => id !== "separator"));
    expect([...inMenus].sort()).toEqual([...commandIds].sort());
  });
});

const manifest = {
  id: "word-count",
  name: { en: "Word count", fr: "Nombre de mots" },
  version: "1.0.0",
  api: "^0.1",
  contributes: {
    commands: [
      { id: "count", name: { en: "Count words", fr: "Compter les mots" }, keys: ["Mod+Shift+K"] },
      { id: "forgotten", name: "Never attached", menu: "note", keys: ["K"] },
    ],
  },
};

/** A plugin that counts how often its command ran, and whether its code loaded. */
function fixture(extra?: (context: Parameters<Plugin["activate"]>[0]) => Promise<void>) {
  const seen = { loads: 0, counts: 0, language: "" };
  const plugin = definePlugin({
    async activate(context) {
      seen.language = context.language;
      await context.commands.register("count", () => {
        seen.counts++;
      });
      await extra?.(context);
    },
  });
  return {
    seen,
    load: () => {
      seen.loads++;
      return Promise.resolve({ default: plugin });
    },
  };
}

/** Waits for what a command set going to finish, as menus run commands without waiting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const connections: Record<string, (() => readonly [Transport, Transport]) | undefined> = {
  "within the page": undefined,
  "through a port": () => {
    const { port1, port2 } = new MessageChannel();
    return [portTransport(port1), portTransport(port2)];
  },
};

for (const [name, connect] of Object.entries(connections)) {
  describe(`PluginHost, ${name}`, () => {
    const host = (registry: CommandRegistry, errors: string[] = []) =>
      new PluginHost(registry, {
        language: "fr",
        direction: "ltr",
        ...(connect === undefined ? {} : { connect }),
        onError: (plugin, message) => {
          errors.push(`${plugin}: ${message}`);
        },
      });

    it("shows a plugin's commands before its code loads, and loads it when one is first chosen", async () => {
      const registry = new CommandRegistry();
      const plugins = host(registry);
      const { seen, load } = fixture();
      expect(plugins.add({ manifest, load })).toEqual([]);
      const count = registry.get("word-count:count");
      expect(count?.name()).toBe("Compter les mots");
      expect(count?.menu).toBe("plugins");
      expect(count?.plugin).toBe("word-count");
      expect(registry.get("word-count:forgotten")?.menu).toBe("note");
      // Keys that cannot be a shortcut are left out.
      expect(registry.defaults()).toEqual({ "word-count:count": ["Mod+Shift+K"] });
      expect(seen.loads).toBe(0);
      count?.run();
      count?.run();
      await settle();
      expect(seen).toEqual({ loads: 1, counts: 2, language: "fr" });
      plugins.close();
    });

    it("says when a command's code did not attach it", async () => {
      const registry = new CommandRegistry();
      const errors: string[] = [];
      const plugins = host(registry, errors);
      plugins.add({ manifest, load: fixture().load });
      registry.get("word-count:forgotten")?.run();
      await settle();
      expect(errors).toEqual(["word-count: Its code did not attach forgotten."]);
      plugins.close();
    });

    it("says when its code attaches a command its manifest does not declare, and tries again next time", async () => {
      const registry = new CommandRegistry();
      const errors: string[] = [];
      const plugins = host(registry, errors);
      const { seen, load } = fixture(async (context) => {
        await context.commands.register("undeclared", () => undefined);
      });
      plugins.add({ manifest, load });
      registry.get("word-count:count")?.run();
      await settle();
      registry.get("word-count:count")?.run();
      await settle();
      expect(errors).toEqual([
        'word-count: The manifest declares no command "undeclared".',
        'word-count: The manifest declares no command "undeclared".',
      ]);
      expect(seen.loads).toBe(2);
      plugins.close();
    });

    it("lets a plugin take a command away again", async () => {
      const registry = new CommandRegistry();
      const errors: string[] = [];
      const plugins = host(registry, errors);
      const { seen, load } = fixture(async (context) => {
        const again = await context.commands.register("forgotten", () => undefined);
        await again.dispose();
      });
      plugins.add({ manifest, load });
      registry.get("word-count:forgotten")?.run();
      await settle();
      expect(errors).toEqual(["word-count: Its code did not attach forgotten."]);
      expect(seen.loads).toBe(1);
      plugins.close();
    });

    it("takes a plugin's commands away when it stops", async () => {
      const registry = new CommandRegistry();
      const plugins = host(registry);
      plugins.add({ manifest, load: fixture().load });
      registry.get("word-count:count")?.run();
      await settle();
      expect(plugins.ids()).toEqual(["word-count"]);
      plugins.remove("word-count");
      plugins.remove("word-count");
      expect(registry.all()).toEqual([]);
      expect(plugins.ids()).toEqual([]);
    });
  });
}

describe("PluginHost, adding", () => {
  const plugins = () => new PluginHost(new CommandRegistry(), { language: "en", direction: "ltr" });
  const load = fixture().load;

  it("keeps out a plugin whose manifest is wrong, or which needs another API", () => {
    expect(plugins().add({ manifest: { id: "x" }, load })).toContain("name is not a name.");
    expect(plugins().add({ manifest: { ...manifest, api: "^9.0" }, load })).toEqual([
      "It works with API ^9.0, and the app speaks 0.1.0.",
    ]);
  });

  it("keeps out a second plugin with the same ID", () => {
    const host = plugins();
    expect(host.add({ manifest, load })).toEqual([]);
    expect(host.add({ manifest, load })).toEqual(["A plugin word-count is there already."]);
  });

  it("says when a plugin's code cannot load", async () => {
    const registry = new CommandRegistry();
    const errors: string[] = [];
    const host = new PluginHost(registry, {
      language: "en",
      direction: "ltr",
      onError: (plugin, message) => {
        errors.push(`${plugin}: ${message}`);
      },
    });
    host.add({ manifest, load: () => Promise.reject(new Error("No such module.")) });
    registry.get("word-count:count")?.run();
    await settle();
    expect(errors).toEqual(["word-count: No such module."]);
  });
});
