import { describe, expect, it } from "vitest";
import type { Json } from "../src/json.ts";
import { definePlugin, startPlugin } from "../src/plugin.ts";
import { Endpoint, pagePair } from "../src/protocol.ts";
import { apiVersion } from "../src/version.ts";

/** The app's end, answering as the app would, and recording what it was told. */
function fakeApp(
  hello: Json = { id: "word-count", api: apiVersion, language: "fr", direction: "ltr" },
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
    const other = fakeApp({ id: "a", api: "9.0.0", language: "en", direction: "ltr" });
    await expect(
      startPlugin(definePlugin({ activate: () => undefined }), other.pluginSide),
    ).rejects.toThrow(`The plugin was built for API ${apiVersion}, and the app speaks 9.0.0.`);
    other.app.close();
    const garbled = fakeApp({ id: "a", api: apiVersion, language: "en", direction: "up" });
    await expect(
      startPlugin(definePlugin({ activate: () => undefined }), garbled.pluginSide),
    ).rejects.toThrow("The app did not say who the plugin is.");
    garbled.app.close();
  });
});
