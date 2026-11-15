import { describe, expect, it } from "vitest";
import { Endpoint, isMessage, pagePair, portTransport, type Transport } from "../src/protocol.ts";
import { channel } from "./ports.ts";

const transports: Record<string, () => readonly [Transport, Transport]> = {
  "within the page": pagePair,
  "through a port": () => {
    const { port1, port2 } = channel();
    return [portTransport(port1), portTransport(port2)];
  },
};

for (const [name, connect] of Object.entries(transports)) {
  describe(`Endpoint ${name}`, () => {
    it("calls the other side and hears its answer", async () => {
      const [a, b] = connect();
      const app = new Endpoint(a);
      const plugin = new Endpoint(b);
      app.handle("add", (x, y) => (x as number) + (y as number));
      plugin.handle("echo", async (value) => {
        await Promise.resolve();
        return value ?? null;
      });
      plugin.handle("nothing", () => undefined);
      expect(await plugin.call("add", 2, 3)).toBe(5);
      expect(await app.call("echo", { list: [1, "two", null] })).toEqual({
        list: [1, "two", null],
      });
      expect(await app.call("nothing")).toBeNull();
      app.close();
      plugin.close();
    });

    it("passes errors back, and names a method nothing answers", async () => {
      const [a, b] = connect();
      const app = new Endpoint(a);
      const plugin = new Endpoint(b);
      app.handle("fail", () => {
        throw new Error("No such note.");
      });
      app.handle("throws text", () => {
        // A plugin may throw what is not an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain";
      });
      await expect(plugin.call("fail")).rejects.toThrow("No such note.");
      await expect(plugin.call("throws text")).rejects.toThrow("plain");
      await expect(plugin.call("missing")).rejects.toThrow("Nothing answers missing.");
      app.close();
      plugin.close();
    });

    it("stops answering once a handler is removed, and fails calls once closed", async () => {
      const [a, b] = connect();
      const app = new Endpoint(a);
      const plugin = new Endpoint(b);
      const stop = app.handle("ping", () => "pong");
      expect(await plugin.call("ping")).toBe("pong");
      stop();
      await expect(plugin.call("ping")).rejects.toThrow("Nothing answers ping.");
      const waiting = plugin.call("never");
      plugin.close();
      await expect(waiting).rejects.toThrow("The connection is closed.");
      await expect(plugin.call("ping")).rejects.toThrow("The connection is closed.");
      expect(plugin.closed).toBe(true);
      plugin.close();
      app.close();
    });
  });
}

describe("isMessage", () => {
  it("tells messages from anything else a port carries", () => {
    expect(isMessage({ kind: "call", id: 1, method: "a", args: [] })).toBe(true);
    expect(isMessage({ kind: "result", id: 1, value: null })).toBe(true);
    expect(isMessage({ kind: "error", id: 1, message: "x" })).toBe(true);
    expect(isMessage({ kind: "call", id: 1, method: "a" })).toBe(false);
    expect(isMessage({ kind: "result", id: 1 })).toBe(false);
    expect(isMessage({ kind: "error", id: "1", message: "x" })).toBe(false);
    expect(isMessage({ kind: "other", id: 1 })).toBe(false);
    expect(isMessage("call")).toBe(false);
    expect(isMessage(null)).toBe(false);
  });

  it("leaves what is not a message unanswered on a port", async () => {
    const { port1, port2 } = channel();
    const plugin = new Endpoint(portTransport(port2));
    port1.postMessage({ hello: true });
    const app = new Endpoint(portTransport(port1));
    app.handle("ping", () => "pong");
    expect(await plugin.call("ping")).toBe("pong");
    app.close();
    plugin.close();
  });
});
