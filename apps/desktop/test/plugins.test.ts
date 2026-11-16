// The plugin host and its registries (ADR 0055): a built-in plugin's
// commands and code block languages are there before its code loads, its
// code loads when one is first used, and the same plugin runs within the
// page and through a port, as a sandboxed one will.
import {
  type CodeBlockContext,
  type Plugin,
  type Transport,
  definePlugin,
  portTransport,
} from "@nether/plugin-api";
import { describe, expect, it } from "vitest";
import { coreMenus, commandIds } from "../src/commands.ts";
import { builtinPlugins } from "../src/plugins/builtins.ts";
import { CodeBlockRegistry, type CodeBlockView } from "../src/plugins/codeBlocks.ts";
import { type BuiltinContext, PluginHost } from "../src/plugins/host.ts";
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

describe("CodeBlockRegistry", () => {
  const processor = (language: string, plugin = "abc") => ({
    language,
    plugin,
    load: () => Promise.resolve({}),
  });

  it("finds a language whatever its case, and tells listeners of each change", () => {
    const registry = new CodeBlockRegistry();
    let told = 0;
    registry.subscribe(() => {
      told++;
    });
    const remove = registry.add(processor("abc"));
    expect(registry.get("ABC")?.plugin).toBe("abc");
    remove();
    remove();
    expect(registry.get("abc")).toBeUndefined();
    expect(told).toBe(2);
  });

  it("keeps a language for the plugin that had it first", () => {
    const registry = new CodeBlockRegistry();
    registry.add(processor("abc"));
    expect(() => registry.add(processor("abc", "other"))).toThrow(
      "The plugin abc draws abc code blocks already.",
    );
  });

  it("gives no HTML for a language nothing draws as HTML", async () => {
    const registry = new CodeBlockRegistry();
    registry.add(processor("abc"));
    registry.add({
      language: "broken",
      plugin: "broken",
      load: () => Promise.reject(new Error("No such module.")),
    });
    expect(await registry.html("abc", "abc", "x")).toBeUndefined();
    expect(await registry.html("broken", "broken", "x")).toBeUndefined();
    expect(await registry.html("other", "other", "x")).toBeUndefined();
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

const drawing = {
  id: "abc",
  name: "ABC notation",
  version: "1.0.0",
  api: "^0.1",
  contributes: { codeBlocks: [{ language: "abc" }, { language: "forgotten" }] },
};

/** A plugin that draws `abc` code blocks, and counts how often its code loaded. */
function drawer(extra?: (context: BuiltinContext) => void | Promise<void>) {
  const seen = { loads: 0 };
  const module = {
    async activate(context: BuiltinContext) {
      await context.codeBlocks.register("abc", (source, block) =>
        source === "bad"
          ? { error: "Not ABC." }
          : source === "garbled"
            ? ({ svg: source } as unknown as null)
            : { html: `<b>${source}</b> ${block.theme} ${block.target} ${block.info}` },
      );
      await extra?.(context);
    },
  };
  return {
    seen,
    load: () => {
      seen.loads++;
      return Promise.resolve({ default: module });
    },
  };
}

const editorBlock: CodeBlockContext = {
  language: "abc",
  info: "abc x=1",
  theme: "dark",
  target: "editor",
};

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
    const host = (
      registry: CommandRegistry,
      errors: string[] = [],
      codeBlocks = new CodeBlockRegistry(),
    ) =>
      new PluginHost(
        { commands: registry, codeBlocks },
        {
          language: "fr",
          direction: "ltr",
          ...(connect === undefined ? {} : { connect }),
          onError: (plugin, message) => {
            errors.push(`${plugin}: ${message}`);
          },
        },
      );

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

    it("draws a plugin's code blocks, its code loaded with the first", async () => {
      const codeBlocks = new CodeBlockRegistry();
      const plugins = host(new CommandRegistry(), [], codeBlocks);
      const { seen, load } = drawer();
      expect(plugins.add({ manifest: drawing, load })).toEqual([]);
      const abc = codeBlocks.get("ABC");
      expect(abc?.plugin).toBe("abc");
      expect(seen.loads).toBe(0);
      const { render, view } = (await abc?.load()) ?? {};
      expect(view).toBeUndefined();
      expect(await render?.("X:1", editorBlock)).toEqual({
        html: "<b>X:1</b> dark editor abc x=1",
      });
      expect(await render?.("bad", editorBlock)).toEqual({ error: "Not ABC." });
      await expect(render?.("garbled", editorBlock)).rejects.toThrow(
        "Its code block gave neither HTML nor an error.",
      );
      // As an export draws it: on a light page, in the code's place.
      expect(await codeBlocks.html("Abc", "Abc", "X:2")).toBe("<b>X:2</b> light html Abc");
      expect(await codeBlocks.html("abc", "abc", "bad")).toBeUndefined();
      await expect(codeBlocks.get("forgotten")?.load()).rejects.toThrow(
        "Its code did not attach forgotten code blocks.",
      );
      expect(await codeBlocks.html("forgotten", "forgotten", "x")).toBeUndefined();
      expect(seen.loads).toBe(1);
      plugins.remove("abc");
      expect(codeBlocks.get("abc")).toBeUndefined();
    });

    it("refuses a code block its manifest does not declare", async () => {
      const codeBlocks = new CodeBlockRegistry();
      const plugins = host(new CommandRegistry(), [], codeBlocks);
      const { load } = drawer(async (context) => {
        await context.codeBlocks.register("zzz", () => null);
      });
      plugins.add({ manifest: drawing, load });
      await expect(codeBlocks.get("abc")?.load()).rejects.toThrow(
        'The manifest declares no code block "zzz".',
      );
      plugins.close();
    });

    it("lets a plugin take a code block away again", async () => {
      const codeBlocks = new CodeBlockRegistry();
      const plugins = host(new CommandRegistry(), [], codeBlocks);
      let undo: (() => Promise<void>) | undefined;
      const { load } = drawer(async (context) => {
        const again = await context.codeBlocks.register("forgotten", () => null);
        undo = () => again.dispose();
      });
      plugins.add({ manifest: drawing, load });
      const { render } = (await codeBlocks.get("forgotten")?.load()) ?? {};
      expect(await render?.("x", editorBlock)).toBeNull();
      await undo?.();
      await expect(render?.("x", editorBlock)).rejects.toThrow(
        "Its code did not attach forgotten code blocks.",
      );
      plugins.close();
    });

    it("gives a built-in plugin the host, for a live view of a code block", async () => {
      const codeBlocks = new CodeBlockRegistry();
      const plugins = host(new CommandRegistry(), [], codeBlocks);
      const view: CodeBlockView = () => null;
      let refused: unknown;
      const { load } = drawer((context) => {
        context.host.codeBlocks.view("forgotten", view);
        try {
          context.host.codeBlocks.view("zzz", view);
        } catch (error) {
          refused = error;
        }
      });
      plugins.add({ manifest: drawing, load });
      const forgotten = await codeBlocks.get("forgotten")?.load();
      expect(forgotten?.view).toBe(view);
      expect(forgotten?.render).toBeUndefined();
      expect(String(refused)).toBe('Error: The manifest declares no code block "zzz".');
      plugins.close();
    });
  });
}

describe("PluginHost, adding", () => {
  const plugins = (codeBlocks = new CodeBlockRegistry(), commands = new CommandRegistry()) =>
    new PluginHost({ commands, codeBlocks }, { language: "en", direction: "ltr" });
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

  it("keeps out a plugin that draws a language another plugin draws", () => {
    const commands = new CommandRegistry();
    const host = plugins(new CodeBlockRegistry(), commands);
    expect(host.add({ manifest: drawing, load })).toEqual([]);
    const second = {
      ...manifest,
      contributes: { ...manifest.contributes, codeBlocks: [{ language: "abc" }] },
    };
    expect(host.add({ manifest: second, load })).toEqual([
      "The plugin abc draws abc code blocks already.",
    ]);
    expect(commands.all()).toEqual([]);
    expect(host.ids()).toEqual(["abc"]);
  });

  it("adds the built-in plugins, each drawing its language", () => {
    const codeBlocks = new CodeBlockRegistry();
    const host = plugins(codeBlocks);
    for (const builtin of builtinPlugins) expect(host.add(builtin)).toEqual([]);
    expect(codeBlocks.get("mermaid")?.plugin).toBe("mermaid");
    expect(codeBlocks.get("base")?.plugin).toBe("query");
  });

  it("says when a plugin's code cannot load", async () => {
    const registry = new CommandRegistry();
    const errors: string[] = [];
    const host = new PluginHost(
      { commands: registry, codeBlocks: new CodeBlockRegistry() },
      {
        language: "en",
        direction: "ltr",
        onError: (plugin, message) => {
          errors.push(`${plugin}: ${message}`);
        },
      },
    );
    host.add({ manifest, load: () => Promise.reject(new Error("No such module.")) });
    registry.get("word-count:count")?.run();
    await settle();
    expect(errors).toEqual(["word-count: No such module."]);
  });
});
