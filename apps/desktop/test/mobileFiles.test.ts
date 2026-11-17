// A vault's folder on the phone (ADR 0087): the plugin's calls as the folder
// DeviceFiles builds on, bytes as base64 across the bridge.
import { describe, expect, it } from "vitest";
import type { NetherVaultsPlugin } from "../src/mobile.ts";
import { fromBase64, phoneFolder, toBase64 } from "../src/mobileFiles.ts";

/** The plugin, answering each call as given, and recording what it was asked. */
function fakePlugin(answers: Partial<Record<keyof NetherVaultsPlugin, unknown>>) {
  const asked: [string, unknown][] = [];
  const plugin = new Proxy(
    {},
    {
      get: (_target, name: string) => (options: unknown) => {
        asked.push([name, options]);
        return Promise.resolve(answers[name as keyof NetherVaultsPlugin]);
      },
    },
  ) as NetherVaultsPlugin;
  return { plugin, asked };
}

const info = { path: "Ideas.md", size: 3, modified: 9 };

describe("phoneFolder", () => {
  it("carries bytes as base64 both ways, large ones in pieces", () => {
    const large = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(fromBase64(toBase64(large))).toEqual(large);
    expect(toBase64(new Uint8Array([0, 255, 128]))).toBe("AP+A");
  });

  it("asks the plugin for the vault's files by the vault's ID", async () => {
    const { plugin, asked } = fakePlugin({
      walk: { files: [info] },
      folders: { folders: ["Projects"] },
      stat: { files: [info] },
      readText: { files: [{ ...info, text: "abc", hash: "h" }] },
      delete: { deleted: true },
      makeFolder: { result: "exists" },
      removeFolder: { result: "full" },
    });
    const folder = phoneFolder(plugin, "vault");
    expect(await folder.walk("")).toEqual([info]);
    expect(await folder.folders("")).toEqual(["Projects"]);
    expect(await folder.stat(["Ideas.md"])).toEqual([info]);
    expect(await folder.readText(["Ideas.md"])).toEqual([{ ...info, text: "abc", hash: "h" }]);
    expect(await folder.delete(".trash/Ideas.md")).toBe(true);
    expect(await folder.makeFolder("Projects")).toBe("exists");
    expect(await folder.removeFolder("Projects")).toBe("full");
    expect(asked).toEqual([
      ["walk", { id: "vault", folder: "" }],
      ["folders", { id: "vault", folder: "" }],
      ["stat", { id: "vault", paths: ["Ideas.md"] }],
      ["readText", { id: "vault", paths: ["Ideas.md"] }],
      ["delete", { id: "vault", path: ".trash/Ideas.md" }],
      ["makeFolder", { id: "vault", path: "Projects" }],
      ["removeFolder", { id: "vault", path: "Projects" }],
    ]);
  });

  it("writes text as text and bytes as base64, and passes on why a write did not happen", async () => {
    const written = { ...info, hash: "h" };
    const { plugin, asked } = fakePlugin({ write: { result: "written", file: written } });
    const folder = phoneFolder(plugin, "vault");
    expect(await folder.write("Ideas.md", "abc", "")).toEqual(written);
    expect(await folder.write("cat.png", new Uint8Array([1, 2]), "base")).toEqual(written);
    expect(asked).toEqual([
      ["write", { id: "vault", path: "Ideas.md", base: "", text: "abc" }],
      ["write", { id: "vault", path: "cat.png", base: "base", data: "AQI=" }],
    ]);

    const refused = fakePlugin({ write: { result: "changed" } });
    expect(await phoneFolder(refused.plugin, "vault").write("Ideas.md", "x", "old")).toBe(
      "changed",
    );
    const silent = fakePlugin({ write: { result: "written" } });
    await expect(phoneFolder(silent.plugin, "vault").write("Ideas.md", "x", "")).rejects.toThrow(
      "gave nothing back",
    );
  });

  it("reads bytes from base64, and none for a missing file", async () => {
    const found = fakePlugin({ readBytes: { file: { ...info, hash: "h", data: "AQI=" } } });
    expect(await phoneFolder(found.plugin, "vault").readBytes("Ideas.md")).toEqual({
      ...info,
      hash: "h",
      bytes: new Uint8Array([1, 2]),
    });
    const missing = fakePlugin({ readBytes: {} });
    expect(await phoneFolder(missing.plugin, "vault").readBytes("Nowhere.md")).toBeUndefined();
  });

  it("moves, and passes on why a move did not happen", async () => {
    const moved = fakePlugin({ move: { result: "moved", file: info } });
    expect(await phoneFolder(moved.plugin, "vault").move("a.md", "Ideas.md")).toEqual(info);
    const taken = fakePlugin({ move: { result: "exists" } });
    expect(await phoneFolder(taken.plugin, "vault").move("a.md", "Ideas.md")).toBe("exists");
    const silent = fakePlugin({ move: { result: "moved" } });
    await expect(phoneFolder(silent.plugin, "vault").move("a.md", "b.md")).rejects.toThrow(
      "gave nothing back",
    );
  });
});
