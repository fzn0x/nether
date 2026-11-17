// The plugin host and its registries (ADR 0055): a built-in plugin's
// commands, code block languages and block types are there before its
// code loads, its code loads when one is first used, and the same plugin
// runs within the page and through a port, as a sandboxed one will.
import {
  type CodeBlockContext,
  type JsonObject,
  type LaidOut,
  type Plugin,
  type Transport,
  definePlugin,
  portTransport,
} from "@nether/plugin-api";
import { describe, expect, it } from "vitest";
import { coreMenus, commandIds } from "../src/commands.ts";
import { BlockRegistry, slashEntries } from "../src/plugins/blocks.ts";
import { PanelRegistry } from "../src/plugins/panels.ts";
import { ViewRegistry, extensionOf } from "../src/plugins/views.ts";
import { type LayoutActions, LayoutRegistry } from "../src/plugins/layouts.ts";
import { PropertyTypeRegistry } from "../src/plugins/propertyTypes.ts";
import { isOn, readBuiltins, readOn } from "../src/plugins/state.ts";
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
    const all = registry.all();
    expect(registry.all()).toBe(all);
    remove();
    remove();
    expect(registry.get("abc")).toBeUndefined();
    expect(registry.all()).toEqual([]);
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

const tallies = {
  id: "tally",
  name: "Tally",
  version: "1.0.0",
  api: "^0.1",
  contributes: {
    blocks: [
      {
        type: "count",
        name: { en: "Tally", fr: "Comptage" },
        keywords: { fr: "compter" },
        attrs: { count: 0 },
      },
      { type: "forgotten", name: "Never attached" },
    ],
  },
};

/** A plugin whose view of a tally shows its count, and counts up when asked. */
function tallier(extra?: (context: BuiltinContext) => Promise<void>) {
  const seen: string[] = [];
  let countUp: (() => Promise<void>) | undefined;
  const module = {
    async activate(context: BuiltinContext) {
      await context.blocks.register("count", {
        mount(element, props, block) {
          let count = typeof props.attrs.count === "number" ? props.attrs.count : 0;
          element.textContent = String(count);
          countUp = () => block.setAttrs({ count: ++count });
          return {
            update(next) {
              seen.push(`update ${JSON.stringify(next.attrs)} ${next.theme}`);
            },
            unmount() {
              seen.push("unmount");
            },
          };
        },
      });
      await extra?.(context);
    },
  };
  return {
    seen,
    countUp: () => countUp?.(),
    load: () => Promise.resolve({ default: module }),
  };
}

const shown = { attrs: { count: 1 }, editable: true, theme: "light" } as const;

const counter = {
  id: "counter",
  name: "Counter",
  version: "1.0.0",
  api: "^0.1",
  contributes: {
    panels: [
      { id: "words", name: { en: "Words", fr: "Mots" }, place: "note", folded: true },
      { id: "stats", name: "Statistics", place: "sidebar" },
    ],
  },
};

/** A plugin whose panel shows the title of the note it is beside. */
function counting(extra?: (context: BuiltinContext) => void) {
  const seen: string[] = [];
  const module = {
    async activate(context: BuiltinContext) {
      await context.panels.register("words", {
        mount(element, props) {
          element.textContent = props.note?.title ?? "";
          return {
            update(next) {
              seen.push(`update ${next.note?.title ?? ""} ${next.theme}`);
            },
            unmount() {
              seen.push("unmount");
            },
          };
        },
      });
      extra?.(context);
    },
  };
  return { seen, load: () => Promise.resolve({ default: module }) };
}

const beside = (title: string) =>
  ({ theme: "light", note: { id: "n1", title, path: `${title}.md` } }) as const;

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
      blocks = new BlockRegistry(),
      panels = new PanelRegistry(),
      views = new ViewRegistry(),
      opened: string[] = [],
      layouts = new LayoutRegistry(),
      propertyTypes = new PropertyTypeRegistry(),
    ) =>
      new PluginHost(
        { commands: registry, codeBlocks, blocks, panels, views, layouts, propertyTypes },
        {
          language: "fr",
          direction: "ltr",
          ...(connect === undefined ? {} : { connect }),
          onError: (plugin, message) => {
            errors.push(`${plugin}: ${message}`);
          },
          onOpenView: (id) => {
            opened.push(id);
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

    it("shows a plugin's block with its view, mounted in the element the app made for it", async () => {
      const blocks = new BlockRegistry();
      const plugins = host(new CommandRegistry(), [], new CodeBlockRegistry(), blocks);
      const { seen, countUp, load } = tallier();
      expect(plugins.add({ manifest: tallies, load })).toEqual([]);
      const count = blocks.get("tally/count");
      expect(count?.slash.name()).toBe("Comptage");
      expect(count?.slash.keywords()).toBe("compter");
      expect(blocks.get("tally/forgotten")?.slash.keywords()).toBe("");
      expect(count?.attrs).toEqual({ count: 0 });
      const element = { textContent: "" } as HTMLElement;
      const changes: JsonObject[] = [];
      const drawing = await count?.load();
      const view = await drawing?.mount(element, shown, (attrs) => {
        changes.push(attrs);
      });
      expect(element.textContent).toBe("1");
      await countUp();
      expect(changes).toEqual([{ count: 2 }]);
      await view?.update({ ...shown, attrs: { count: 2 }, theme: "dark" });
      view?.unmount();
      view?.unmount();
      await settle();
      // Once unmounted, the view hears nothing more.
      await view?.update(shown);
      expect(seen).toEqual(['update {"count":2} dark', "unmount"]);
      plugins.remove("tally");
      expect(blocks.get("tally/count")).toBeUndefined();
    });

    it("says when its code attached no view of a block, or one its manifest does not declare", async () => {
      const blocks = new BlockRegistry();
      const plugins = host(new CommandRegistry(), [], new CodeBlockRegistry(), blocks);
      const { load } = tallier();
      plugins.add({ manifest: tallies, load });
      await expect(blocks.get("tally/forgotten")?.load()).rejects.toThrow(
        "Its code did not attach a view of forgotten blocks.",
      );
      const other = new BlockRegistry();
      const refusing = host(new CommandRegistry(), [], new CodeBlockRegistry(), other);
      refusing.add({
        manifest: tallies,
        load: tallier(async (context) => {
          await context.blocks.register("zzz", { mount: () => undefined });
        }).load,
      });
      await expect(other.get("tally/count")?.load()).rejects.toThrow(
        'The manifest declares no block "zzz".',
      );
      plugins.close();
      refusing.close();
    });

    it("lets a plugin take a block's view away again", async () => {
      const blocks = new BlockRegistry();
      const plugins = host(new CommandRegistry(), [], new CodeBlockRegistry(), blocks);
      let undo: (() => Promise<void>) | undefined;
      plugins.add({
        manifest: tallies,
        load: tallier(async (context) => {
          const again = await context.blocks.register("forgotten", { mount: () => undefined });
          undo = () => again.dispose();
        }).load,
      });
      const drawing = await blocks.get("tally/forgotten")?.load();
      await undo?.();
      await expect(drawing?.mount({} as HTMLElement, shown, () => undefined)).rejects.toThrow(
        "Its code did not attach a view of forgotten blocks.",
      );
      plugins.close();
    });

    it("fills a plugin's panel with its view, mounted beside a note", async () => {
      const panels = new PanelRegistry();
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        panels,
      );
      const { seen, load } = counting();
      expect(plugins.add({ manifest: counter, load })).toEqual([]);
      const words = panels.get("counter:words");
      expect(words?.name()).toBe("Mots");
      expect([words?.place, words?.folded]).toEqual(["note", true]);
      expect([panels.get("counter:stats")?.place, panels.get("counter:stats")?.folded]).toEqual([
        "sidebar",
        false,
      ]);
      const drawing = await words?.load();
      expect(drawing?.view).toBeUndefined();
      const element = { textContent: "" } as HTMLElement;
      const view = await drawing?.mount?.(element, beside("Roadmap"));
      expect(element.textContent).toBe("Roadmap");
      await view?.update({ ...beside("Ideas"), theme: "dark" });
      view?.unmount();
      await settle();
      expect(seen).toEqual(["update Ideas dark", "unmount"]);
      // A panel its code attached no view of says so.
      await expect(panels.get("counter:stats")?.load()).rejects.toThrow(
        "Its code did not attach a view of the stats panel.",
      );
      plugins.remove("counter");
      expect(panels.all()).toEqual([]);
    });

    it("gives a built-in plugin's panel a live view through the host", async () => {
      const panels = new PanelRegistry();
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        panels,
      );
      const view = () => null;
      let refused: unknown;
      plugins.add({
        manifest: counter,
        load: counting((context) => {
          context.host.panels.view("stats", view);
          try {
            context.host.panels.view("nope", view);
          } catch (error) {
            refused = error;
          }
        }).load,
      });
      expect((await panels.get("counter:stats")?.load())?.view).toBe(view);
      expect(String(refused)).toBe('Error: The manifest declares no panel "nope".');
      plugins.close();
    });

    it("starts a plugin with its settings as the vault keeps them, and tells it of changes", async () => {
      const registry = new CommandRegistry();
      const plugins = host(registry);
      const heard: unknown[] = [];
      let started: unknown;
      const goals = {
        ...manifest,
        contributes: {
          ...manifest.contributes,
          settings: [
            { id: "goal", name: "Goal", type: "number", default: 500 },
            { id: "live", name: "Live", type: "toggle", default: true },
          ],
        },
      };
      const { load } = fixture((context) => {
        started = context.settings.values();
        context.settings.onChange((values) => heard.push(values));
        return Promise.resolve();
      });
      // A plugin not added yet takes them when it is.
      plugins.setSettings("word-count", { goal: 750, live: "no" });
      plugins.add({ manifest: goals, load });
      // One not started is told nothing until it starts.
      plugins.setSettings("word-count", { goal: 800 });
      registry.get("word-count:count")?.run();
      await settle();
      expect(started).toEqual({ goal: 800, live: true });
      plugins.setSettings("word-count", { goal: 900, live: false });
      await settle();
      expect(heard).toEqual([{ goal: 900, live: false }]);
      plugins.close();
    });

    it("opens a plugin's files by their extension, and its views of their own when it asks", async () => {
      const views = new ViewRegistry();
      const opened: string[] = [];
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        new PanelRegistry(),
        views,
        opened,
      );
      const stats = () => null;
      let open: ((id: string) => Promise<void>) | undefined;
      const sheets = {
        id: "sheets",
        name: "Sheets",
        version: "1.0.0",
        api: "^0.1",
        contributes: {
          views: [
            { id: "sheet", name: { en: "Sheet", fr: "Feuille" }, extensions: ["csv", "tsv"] },
            { id: "stats", name: "Statistics" },
          ],
        },
      };
      plugins.add({
        manifest: sheets,
        load: () =>
          Promise.resolve({
            default: {
              async activate(context: BuiltinContext) {
                await context.views.register("sheet", {
                  mount(element, props) {
                    element.textContent = props.file?.path ?? "";
                    return undefined;
                  },
                });
                context.host.views.view("stats", stats);
                open = (id) => context.views.open(id);
              },
            },
          }),
      });
      const sheet = views.forFile("Data/Prices.CSV");
      expect([sheet?.id, sheet?.name()]).toEqual(["sheets:sheet", "Feuille"]);
      expect(views.forFile("Notes/a.md")).toBeUndefined();
      expect(views.forFile("README")).toBeUndefined();
      const element = { textContent: "" } as HTMLElement;
      const drawing = await sheet?.load();
      const view = await drawing?.mount?.(element, {
        theme: "light",
        file: { path: "Data/Prices.CSV" },
      });
      expect(element.textContent).toBe("Data/Prices.CSV");
      view?.unmount();
      expect((await views.get("sheets:stats")?.load())?.view).toBe(stats);
      await open?.("stats");
      expect(opened).toEqual(["sheets:stats"]);
      // A view of files opens with its files, not by itself.
      await expect(open?.("sheet")).rejects.toThrow(
        'The manifest declares no view of its own "sheet".',
      );
      plugins.close();
      expect(views.all()).toEqual([]);
    });

    it("shows a database's rows in a plugin's layout, which changes them through the app", async () => {
      const layouts = new LayoutRegistry();
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        new PanelRegistry(),
        new ViewRegistry(),
        [],
        layouts,
      );
      let database: LaidOut | undefined;
      plugins.add({
        manifest: {
          id: "maps",
          name: "Maps",
          version: "1.0.0",
          api: "^0.1",
          contributes: { layouts: [{ id: "pins", name: { en: "Map", fr: "Carte" } }] },
        },
        load: () =>
          Promise.resolve({
            default: {
              async activate(context: BuiltinContext) {
                await context.layouts.register("pins", {
                  mount(element, props, laidOut) {
                    element.textContent = props.rows.map((row) => row.title).join(", ");
                    database = laidOut;
                    return undefined;
                  },
                });
              },
            },
          }),
      });
      const pins = layouts.get("maps/pins");
      expect([pins?.plugin, pins?.name()]).toEqual(["maps", "Carte"]);
      const told: string[] = [];
      const actions: LayoutActions = {
        openRow: (row) => told.push(`open ${row}`),
        setValue: (row, key, value) => told.push(`set ${row} ${key} ${JSON.stringify(value)}`),
        setOptions: (options) => told.push(`options ${JSON.stringify(options)}`),
      };
      const element = { textContent: "" } as HTMLElement;
      const drawing = await pins?.load();
      const view = await drawing?.mount?.(
        element,
        {
          view: { name: "Map", options: {} },
          rows: [{ id: "r1", title: "Paris", values: { visited: false } }],
          properties: [{ key: "visited", name: "visited", type: "checkbox" }],
          editable: true,
          theme: "light",
        },
        actions,
      );
      expect(element.textContent).toBe("Paris");
      await database?.setValue("r1", "visited", true);
      await database?.openRow("r1");
      await database?.setOptions({ zoom: 3 });
      expect(told).toEqual(["set r1 visited true", "open r1", 'options {"zoom":3}']);
      view?.unmount();
      plugins.close();
      expect(layouts.all()).toEqual([]);
    });

    it("shows a value of a plugin's property type in its view, which sets it through the app", async () => {
      const propertyTypes = new PropertyTypeRegistry();
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        new PanelRegistry(),
        new ViewRegistry(),
        [],
        new LayoutRegistry(),
        propertyTypes,
      );
      let setValue: ((value: number) => Promise<void>) | undefined;
      plugins.add({
        manifest: {
          id: "stars",
          name: "Stars",
          version: "1.0.0",
          api: "^0.1",
          contributes: {
            propertyTypes: [{ id: "rating", name: { en: "Rating", fr: "Note" }, stores: "number" }],
          },
        },
        load: () =>
          Promise.resolve({
            default: {
              async activate(context: BuiltinContext) {
                await context.propertyTypes.register("rating", {
                  mount(element, props, property) {
                    element.textContent = JSON.stringify(props.value);
                    setValue = (value) => property.setValue(value);
                    return undefined;
                  },
                });
              },
            },
          }),
      });
      const rating = propertyTypes.get("stars/rating");
      expect([rating?.plugin, rating?.stores, rating?.name()]).toEqual(["stars", "number", "Note"]);
      const element = { textContent: "" } as HTMLElement;
      const set: unknown[] = [];
      const drawing = await rating?.load();
      const view = await drawing?.mount(
        element,
        { key: "rating", value: 3, editable: true, theme: "light" },
        (value) => set.push(value),
      );
      expect(element.textContent).toBe("3");
      await setValue?.(4);
      expect(set).toEqual([4]);
      view?.unmount();
      plugins.close();
      expect(propertyTypes.all()).toEqual([]);
    });

    it("refuses a view of a panel its manifest does not declare", async () => {
      const panels = new PanelRegistry();
      const plugins = host(
        new CommandRegistry(),
        [],
        new CodeBlockRegistry(),
        new BlockRegistry(),
        panels,
      );
      plugins.add({
        manifest: counter,
        load: () =>
          Promise.resolve({
            default: {
              async activate(context: BuiltinContext) {
                await context.panels.register("nope", { mount: () => undefined });
              },
            },
          }),
      });
      await expect(panels.get("counter:words")?.load()).rejects.toThrow(
        'The manifest declares no panel "nope".',
      );
      plugins.close();
    });

    it("says when a view cannot mount, and keeps no slot for it", async () => {
      const blocks = new BlockRegistry();
      const plugins = host(new CommandRegistry(), [], new CodeBlockRegistry(), blocks);
      plugins.add({
        manifest: tallies,
        load: tallier(async (context) => {
          await context.blocks.register("forgotten", {
            mount: () => {
              throw new Error("No room.");
            },
          });
        }).load,
      });
      const drawing = await blocks.get("tally/forgotten")?.load();
      await expect(drawing?.mount({} as HTMLElement, shown, () => undefined)).rejects.toThrow(
        "No room.",
      );
      plugins.close();
    });
  });
}

describe("the vault's plugins", () => {
  it("reads which plugins are on, leaving out what is not true or false", () => {
    expect(readOn({ tags: false, query: true, odd: "no" })).toEqual({ tags: false, query: true });
    expect(readOn([true])).toEqual({});
    expect(readOn(undefined)).toEqual({});
  });

  it("has a built-in plugin on unless the vault turned it off", () => {
    const state = { on: { tags: false, query: true }, settings: {} };
    expect([isOn(state, "tags"), isOn(state, "query"), isOn(state, "outline")]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("reads the built-in plugins' manifests, leaving out one that does not read", () => {
    const read = readBuiltins([...builtinPlugins, { manifest: { id: "x" }, load: fixture().load }]);
    expect(read.map((each) => each.manifest.id)).toEqual(
      builtinPlugins.map((each) => {
        const id = (each.manifest as { readonly id: string }).id;
        return id;
      }),
    );
    expect(
      read.find((each) => each.manifest.id === "backlinks")?.manifest.contributes.settings,
    ).toHaveLength(1);
  });
});

describe("PluginHost, adding", () => {
  const plugins = (
    codeBlocks = new CodeBlockRegistry(),
    commands = new CommandRegistry(),
    blocks = new BlockRegistry(),
    panels = new PanelRegistry(),
    views = new ViewRegistry(),
    layouts = new LayoutRegistry(),
    propertyTypes = new PropertyTypeRegistry(),
  ) =>
    new PluginHost(
      { commands, codeBlocks, blocks, panels, views, layouts, propertyTypes },
      { language: "en", direction: "ltr" },
    );
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

  it("adds the built-in plugins, with their languages and panels", () => {
    const codeBlocks = new CodeBlockRegistry();
    const panels = new PanelRegistry();
    const host = plugins(codeBlocks, new CommandRegistry(), new BlockRegistry(), panels);
    for (const builtin of builtinPlugins) expect(host.add(builtin)).toEqual([]);
    expect(codeBlocks.get("mermaid")?.plugin).toBe("mermaid");
    expect(codeBlocks.get("base")?.plugin).toBe("query");
    expect(codeBlocks.get("Meta-Bind-Button")?.plugin).toBe("automations");
    // The slash menu's Diagram, Query and Button come from them.
    expect(
      slashEntries(codeBlocks.all(), []).map(({ id, title, insert }) => [
        id,
        title,
        "codeBlock" in insert ? insert.text.split("\n")[0] : "",
      ]),
    ).toEqual([
      ["code:mermaid", "Diagram", "flowchart LR"],
      ["code:base", "Query", "views:"],
      ["code:meta-bind-button", "Button", "label: Mark done"],
    ]);
    // The sidebar's Tags and Assigned, and the outline, backlinks and unlinked mentions beside a note.
    expect(
      panels.all().map((panel) => [panel.id, panel.place, panel.name(), panel.folded]),
    ).toEqual([
      ["tags:tags", "sidebar", "Tags", false],
      ["assigned:assigned", "sidebar", "Assigned", false],
      ["outline:outline", "note", "Outline", false],
      ["backlinks:linked", "note", "Linked from", false],
      ["backlinks:unlinked", "note", "Unlinked mentions", true],
    ]);
  });

  it("gives the built-in layouts plugin's layouts the app's own names, and others the plugin's", () => {
    const layouts = new LayoutRegistry();
    const host = plugins(
      new CodeBlockRegistry(),
      new CommandRegistry(),
      new BlockRegistry(),
      new PanelRegistry(),
      new ViewRegistry(),
      layouts,
    );
    for (const builtin of builtinPlugins) host.add(builtin);
    expect(layouts.all().map((layout) => [layout.layout, layout.plugin, layout.name()])).toEqual([
      ["board", "layouts", "Board"],
      ["gallery", "layouts", "Gallery"],
      ["list", "layouts", "List"],
      ["calendar", "layouts", "Calendar"],
      ["timeline", "layouts", "Timeline"],
    ]);
    // A plugin of its own is named for its plugin, even as `board`.
    host.add({
      manifest: { ...manifest, contributes: { layouts: [{ id: "board", name: "Board" }] } },
      load,
    });
    expect(layouts.get("word-count/board")?.plugin).toBe("word-count");
  });

  it("keeps out a plugin that opens files another plugin opens", () => {
    const views = new ViewRegistry();
    const host = plugins(
      new CodeBlockRegistry(),
      new CommandRegistry(),
      new BlockRegistry(),
      new PanelRegistry(),
      views,
    );
    for (const builtin of builtinPlugins) host.add(builtin);
    expect(views.forFile("Boards/Plan.canvas")?.id).toBe("canvas:canvas");
    expect(views.get("graph:graph")?.extensions).toEqual([]);
    const other = {
      ...manifest,
      contributes: { views: [{ id: "whiteboard", name: "Whiteboard", extensions: ["canvas"] }] },
    };
    expect(host.add({ manifest: other, load })).toEqual([
      "The plugin canvas opens .canvas files already.",
    ]);
  });

  it("reads a file's extension, lowercase and without the dot", () => {
    expect(["a/b.Canvas", "a.b/c", ".hidden", "x.tar.gz", "plain"].map(extensionOf)).toEqual([
      "canvas",
      "",
      "",
      "gz",
      "",
    ]);
  });

  it("keeps a panel for the plugin that had it", () => {
    const panels = new PanelRegistry();
    const panel = {
      id: "a:b",
      plugin: "a",
      place: "note",
      folded: false,
      name: () => "B",
      load: () => Promise.reject(new Error("unused")),
    } as const;
    panels.add(panel);
    expect(() => {
      panels.add(panel);
    }).toThrow("A panel a:b is there already.");
  });

  it("offers a plugin's blocks in the slash menu, after its code blocks", () => {
    const codeBlocks = new CodeBlockRegistry();
    const blocks = new BlockRegistry();
    const host = plugins(codeBlocks, new CommandRegistry(), blocks);
    host.add({ manifest: tallies, load: tallier().load });
    host.add({
      manifest: {
        ...drawing,
        contributes: { codeBlocks: [{ language: "abc", name: "Tune", text: "X:1" }] },
      },
      load,
    });
    expect(slashEntries(codeBlocks.all(), blocks.all())).toEqual([
      {
        id: "code:abc",
        title: "Tune",
        keywords: "",
        insert: { codeBlock: "abc", text: "X:1" },
      },
      {
        id: "block:tally/count",
        title: "Tally",
        // No English keywords: the first there are.
        keywords: "compter",
        insert: { pluginBlock: "tally/count", attrs: { count: 0 } },
      },
      {
        id: "block:tally/forgotten",
        title: "Never attached",
        keywords: "",
        insert: { pluginBlock: "tally/forgotten", attrs: {} },
      },
    ]);
  });

  it("keeps a block type for the plugin that had it", () => {
    const blocks = new BlockRegistry();
    const processor = blocks.all();
    blocks.add({
      type: "a/b",
      plugin: "a",
      slash: { name: () => "B", keywords: () => "" },
      attrs: {},
      load: () => Promise.reject(new Error("unused")),
    });
    expect(blocks.all()).not.toBe(processor);
    expect(() => {
      blocks.add({
        type: "a/b",
        plugin: "a",
        slash: { name: () => "B", keywords: () => "" },
        attrs: {},
        load: () => Promise.reject(new Error("unused")),
      });
    }).toThrow("A block type a/b is there already.");
  });

  it("says when a plugin's code cannot load", async () => {
    const registry = new CommandRegistry();
    const errors: string[] = [];
    const host = new PluginHost(
      {
        commands: registry,
        codeBlocks: new CodeBlockRegistry(),
        blocks: new BlockRegistry(),
        panels: new PanelRegistry(),
        views: new ViewRegistry(),
        layouts: new LayoutRegistry(),
        propertyTypes: new PropertyTypeRegistry(),
      },
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
