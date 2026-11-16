import { describe, expect, it } from "vitest";
import type { Json } from "../src/json.ts";
import { definePlugin, startPlugin } from "../src/plugin.ts";
import { Endpoint, pagePair } from "../src/protocol.ts";
import { apiVersion } from "../src/version.ts";

/** The app's end, answering as the app would, and recording what it was told. */
function fakeApp(
  hello: Json = {
    id: "word-count",
    api: apiVersion,
    language: "fr",
    direction: "ltr",
    settings: { goal: 500 },
  },
) {
  const [appSide, pluginSide] = pagePair();
  const app = new Endpoint(appSide);
  const registered = new Map<string, number>();
  const told: string[] = [];
  app.handle("hello", (api) => {
    told.push(`hello ${api as string}`);
    return hello;
  });
  app.handle("commands.register", (id, callback) => {
    if (id === "undeclared") throw new Error("The manifest declares no command undeclared.");
    registered.set(id as string, callback as number);
    told.push(`register ${id as string}`);
    return null;
  });
  app.handle("commands.unregister", (id) => {
    registered.delete(id as string);
    told.push(`unregister ${id as string}`);
    return null;
  });
  app.handle("codeBlocks.register", (language, callback) => {
    registered.set(`block ${language as string}`, callback as number);
    told.push(`register block ${language as string}`);
    return null;
  });
  app.handle("codeBlocks.unregister", (language) => {
    registered.delete(`block ${language as string}`);
    told.push(`unregister block ${language as string}`);
    return null;
  });
  app.handle("blocks.register", (type, callback) => {
    registered.set(`view ${type as string}`, callback as number);
    told.push(`register view ${type as string}`);
    return null;
  });
  app.handle("views.register", (id, callback) => {
    registered.set(`view-of ${id as string}`, callback as number);
    return null;
  });
  app.handle("views.open", (id) => {
    told.push(`open ${id as string}`);
    return null;
  });
  app.handle("panels.register", (id, callback) => {
    registered.set(`panel ${id as string}`, callback as number);
    told.push(`register panel ${id as string}`);
    return null;
  });
  app.handle("blocks.change", (slot, attrs) => {
    told.push(`change ${slot as string} ${JSON.stringify(attrs)}`);
    return null;
  });
  app.handle("ready", () => {
    told.push("ready");
    return null;
  });
  return { app, pluginSide, registered, told };
}

describe("startPlugin", () => {
  it("says hello, activates the plugin with the app's answer, and says when it is ready", async () => {
    const { app, pluginSide, told } = fakeApp();
    let seen: unknown;
    const endpoint = await startPlugin(
      definePlugin({
        activate(context) {
          seen = { id: context.id, language: context.language, direction: context.direction };
        },
      }),
      pluginSide,
    );
    expect(seen).toEqual({ id: "word-count", language: "fr", direction: "ltr" });
    expect(told).toEqual([`hello ${apiVersion}`, "ready"]);
    endpoint.close();
    app.close();
  });

  it("registers commands the app runs by their callback, until they are disposed", async () => {
    const { app, pluginSide, registered, told } = fakeApp();
    let counted = 0;
    let disposable: { dispose(): Promise<void> } | undefined;
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          disposable = await context.commands.register("count", () => {
            counted++;
          });
        },
      }),
      pluginSide,
    );
    const callback = registered.get("count");
    expect(callback).toBeTypeOf("number");
    await app.call("callback", callback ?? 0);
    await app.call("callback", callback ?? 0);
    expect(counted).toBe(2);
    await disposable?.dispose();
    await disposable?.dispose();
    expect(told.filter((line) => line.startsWith("unregister"))).toEqual(["unregister count"]);
    await expect(app.call("callback", callback ?? 0)).rejects.toThrow(
      "The plugin has no such callback.",
    );
    await expect(app.call("callback", "not a number")).rejects.toThrow(
      "The plugin has no such callback.",
    );
    endpoint.close();
    app.close();
  });

  it("draws code blocks the app asks for, with what the app says about each", async () => {
    const { app, pluginSide, registered, told } = fakeApp();
    let disposable: { dispose(): Promise<void> } | undefined;
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          disposable = await context.codeBlocks.register("abc", (source, block) =>
            source === ""
              ? null
              : source === "bad"
                ? { error: "Not ABC." }
                : { html: `<b>${source}</b> ${block.language} ${block.theme} ${block.target}` },
          );
        },
      }),
      pluginSide,
    );
    const callback = registered.get("block abc") ?? 0;
    const block = { language: "abc", info: "abc x=1", theme: "dark", target: "editor" };
    expect(await app.call("callback", callback, "X:1", block)).toEqual({
      html: "<b>X:1</b> abc dark editor",
    });
    expect(await app.call("callback", callback, "bad", block)).toEqual({ error: "Not ABC." });
    expect(await app.call("callback", callback, "", block)).toBeNull();
    // Whatever else the app passes as the code is no code.
    expect(await app.call("callback", callback, 3, block)).toBeNull();
    await disposable?.dispose();
    expect(told).toContain("unregister block abc");
    endpoint.close();
    app.close();
  });

  it("mounts a block's view in the element its slot names, updates it and unmounts it", async () => {
    const { app, pluginSide, registered, told } = fakeApp();
    const element = { textContent: "" } as HTMLElement;
    const seen: string[] = [];
    let change: ((attrs: { readonly count: number }) => Promise<void>) | undefined;
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          await context.blocks.register("tally", {
            mount(into, props, block) {
              into.textContent = `${JSON.stringify(props.attrs)} ${String(props.editable)}`;
              change = (attrs) => block.setAttrs(attrs);
              return {
                update(next) {
                  seen.push(`update ${JSON.stringify(next.attrs)}`);
                },
                unmount() {
                  seen.push("unmount");
                },
              };
            },
          });
          await context.blocks.register("plain", {
            mount(into) {
              into.textContent = "plain";
            },
          });
        },
      }),
      pluginSide,
      { element: (slot) => (slot === "s1" || slot === "s2" ? element : undefined) },
    );
    const tally = registered.get("view tally") ?? 0;
    const props = { attrs: { count: 1 }, editable: true, theme: "light" };
    await app.call("callback", tally, "mount", "s1", props);
    expect(element.textContent).toBe('{"count":1} true');
    await change?.({ count: 2 });
    expect(told).toContain('change s1 {"count":2}');
    await app.call("callback", tally, "update", "s1", { ...props, attrs: { count: 2 } });
    await app.call("callback", tally, "unmount", "s1");
    // Once unmounted, the view hears nothing more.
    await app.call("callback", tally, "update", "s1", props);
    expect(seen).toEqual(['update {"count":2}', "unmount"]);
    // A view that returns nothing mounts, updates and unmounts all the same.
    const plain = registered.get("view plain") ?? 0;
    await app.call("callback", plain, "mount", "s2", props);
    expect(element.textContent).toBe("plain");
    await app.call("callback", plain, "update", "s2", props);
    await app.call("callback", plain, "unmount", "s2");
    await expect(app.call("callback", tally, "mount", "elsewhere", props)).rejects.toThrow(
      "The app gave the view no element.",
    );
    await expect(app.call("callback", tally, "mount", 3, props)).rejects.toThrow(
      "The app named no view.",
    );
    await expect(app.call("callback", tally, "dance", "s1", props)).rejects.toThrow(
      'A view cannot "dance".',
    );
    endpoint.close();
    app.close();
  });

  it("mounts a panel's view, tells it of the note it is beside, and unmounts it", async () => {
    const { app, pluginSide, registered } = fakeApp();
    const element = { textContent: "" } as HTMLElement;
    const seen: string[] = [];
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          await context.panels.register("words", {
            mount(into, props) {
              into.textContent = props.note?.title ?? "";
              return {
                update(next) {
                  seen.push(next.note?.title ?? "");
                },
                unmount() {
                  seen.push("unmount");
                },
              };
            },
          });
        },
      }),
      pluginSide,
      { element: () => element },
    );
    const words = registered.get("panel words") ?? 0;
    const beside = (title: string) => ({
      theme: "dark",
      note: { id: "n1", title, path: `${title}.md` },
    });
    await app.call("callback", words, "mount", "p1", beside("Roadmap"));
    expect(element.textContent).toBe("Roadmap");
    await app.call("callback", words, "update", "p1", beside("Ideas"));
    await app.call("callback", words, "unmount", "p1");
    expect(seen).toEqual(["Ideas", "unmount"]);
    endpoint.close();
    app.close();
  });

  it("mounts a pane's view of a file, and asks the app to open a view of its own", async () => {
    const { app, pluginSide, registered, told } = fakeApp();
    const element = { textContent: "" } as HTMLElement;
    let openStats: (() => Promise<void>) | undefined;
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          await context.views.register("sheet", {
            mount(into, props) {
              into.textContent = props.file?.path ?? "";
              return undefined;
            },
          });
          openStats = () => context.views.open("stats");
        },
      }),
      pluginSide,
      { element: () => element },
    );
    const sheet = registered.get("view-of sheet") ?? 0;
    await app.call("callback", sheet, "mount", "v1", { theme: "light", file: { path: "a.csv" } });
    expect(element.textContent).toBe("a.csv");
    await app.call("callback", sheet, "unmount", "v1");
    await openStats?.();
    expect(told).toContain("open stats");
    endpoint.close();
    app.close();
  });

  it("has no element for a view when the app gives it no surface", async () => {
    const { app, pluginSide, registered } = fakeApp();
    const endpoint = await startPlugin(
      definePlugin({
        async activate(context) {
          await context.blocks.register("tally", { mount: () => undefined });
        },
      }),
      pluginSide,
    );
    await expect(
      app.call("callback", registered.get("view tally") ?? 0, "mount", "s1", {}),
    ).rejects.toThrow("The app gave the view no element.");
    endpoint.close();
    app.close();
  });

  it("starts with the settings the app gives, and hears when they change", async () => {
    const { app, pluginSide } = fakeApp();
    const heard: unknown[] = [];
    let settings: { values(): unknown } | undefined;
    let stop: (() => Promise<void>) | undefined;
    const endpoint = await startPlugin(
      definePlugin({
        activate(context) {
          settings = context.settings;
          const first = context.settings.onChange((values) => heard.push(values));
          stop = () => first.dispose();
          context.settings.onChange((values) => heard.push(`again ${JSON.stringify(values)}`));
        },
      }),
      pluginSide,
    );
    expect(settings?.values()).toEqual({ goal: 500 });
    await app.call("settings.changed", { goal: 750 });
    expect(settings?.values()).toEqual({ goal: 750 });
    expect(heard).toEqual([{ goal: 750 }, 'again {"goal":750}']);
    await stop?.();
    await app.call("settings.changed", { goal: 1000 });
    expect(heard).toEqual([{ goal: 750 }, 'again {"goal":750}', 'again {"goal":1000}']);
    await expect(app.call("settings.changed", [1])).rejects.toThrow("Settings are a JSON object.");
    endpoint.close();
    app.close();
  });

  it("passes on the app's refusal of a command its manifest does not declare", async () => {
    const { app, pluginSide } = fakeApp();
    await expect(
      startPlugin(
        definePlugin({
          async activate(context) {
            await context.commands.register("undeclared", () => undefined);
          },
        }),
        pluginSide,
      ),
    ).rejects.toThrow("The manifest declares no command undeclared.");
    app.close();
  });

  it("stops when the app speaks another version of the API, or gives no answer it can read", async () => {
    const other = fakeApp({
      id: "a",
      api: "9.0.0",
      language: "en",
      direction: "ltr",
      settings: {},
    });
    await expect(
      startPlugin(definePlugin({ activate: () => undefined }), other.pluginSide),
    ).rejects.toThrow(`The plugin was built for API ${apiVersion}, and the app speaks 9.0.0.`);
    other.app.close();
    const garbled = fakeApp({
      id: "a",
      api: apiVersion,
      language: "en",
      direction: "up",
      settings: {},
    });
    await expect(
      startPlugin(definePlugin({ activate: () => undefined }), garbled.pluginSide),
    ).rejects.toThrow("The app did not say who the plugin is.");
    garbled.app.close();
  });
});
