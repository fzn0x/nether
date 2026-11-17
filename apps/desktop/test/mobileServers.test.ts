// The servers a phone is signed in to (ADR 0087): their accounts on the
// plugin's list, their tokens and private keys only in the secrets.
import { describe, expect, it } from "vitest";
import type { NetherVaultsPlugin } from "../src/mobile.ts";
import { type Secrets, phoneServers } from "../src/mobileServers.ts";
import type { ServerAccount } from "../src/mygo.ts";

function account(url: string): ServerAccount {
  return { url, user: { id: "u", name: "Ada", email: "ada@example.org", instanceAdmin: false } };
}

/** The plugin's list, kept as the native side keeps it: the latest first, once each. */
function phone() {
  let list: ServerAccount[] = [];
  const plugin: Pick<NetherVaultsPlugin, "servers" | "saveServer" | "forgetServer"> = {
    servers: () => Promise.resolve({ servers: list }),
    saveServer({ account: saved }) {
      list = [saved, ...list.filter((each) => each.url !== saved.url)];
      return Promise.resolve();
    },
    forgetServer({ url }) {
      list = list.filter((each) => each.url !== url);
      return Promise.resolve();
    },
  };
  const kept = new Map<string, string>();
  const secrets: Secrets = {
    get: (name) => Promise.resolve(kept.get(name)),
    set(name, value) {
      kept.set(name, value);
      return Promise.resolve();
    },
    remove(name) {
      kept.delete(name);
      return Promise.resolve();
    },
  };
  return { servers: phoneServers(plugin, secrets), kept, list: () => list };
}

describe("phoneServers", () => {
  it("lists accounts without tokens, and keeps each token in the secrets", async () => {
    const { servers, kept, list } = phone();
    await servers.saveServer(account("https://a.example.org"), "token-a");
    await servers.saveServer(account("https://b.example.org"), "token-b");
    await servers.saveServer(account("https://a.example.org"), "token-a2");
    expect((await servers.servers()).map((each) => each.url)).toEqual([
      "https://a.example.org",
      "https://b.example.org",
    ]);
    expect(JSON.stringify(list())).not.toContain("token");
    expect(await servers.serverToken("https://a.example.org")).toBe("token-a2");
    expect(await servers.serverToken("https://c.example.org")).toBeUndefined();
    expect([...kept.keys()]).toEqual([
      "token https://a.example.org",
      "token https://b.example.org",
    ]);
  });

  it("keeps the private key as base64, and forgets it with the token on signing out", async () => {
    const { servers, kept } = phone();
    await servers.saveServer(account("https://a.example.org"), "token-a");
    const key = new Uint8Array([0, 1, 2, 250, 255]);
    await servers.saveServerKey("https://a.example.org", key);
    expect(kept.get("key https://a.example.org")).toBe("AAEC+v8=");
    expect(await servers.serverKey("https://a.example.org")).toEqual(key);
    await servers.forgetServer("https://a.example.org");
    expect(await servers.servers()).toEqual([]);
    expect(await servers.serverToken("https://a.example.org")).toBeUndefined();
    expect(await servers.serverKey("https://a.example.org")).toBeUndefined();
    expect(kept.size).toBe(0);
  });
});
