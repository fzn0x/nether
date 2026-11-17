// Exports and Send a copy on a phone (ADR 0087): a ZIP the plugin writes
// from the vault's files, a CSV and a note's copy as files in the app's
// cache, each handed to the share sheet; a share sheet closed unchosen is
// no failure, and a PDF waits.
import { describe, expect, it, vi } from "vitest";
import type { NetherVaultsPlugin } from "../src/mobile.ts";
import { fileUrl, phoneExporter, sendNoteCopy } from "../src/mobileExports.ts";

function plugin() {
  const asked: [string, unknown][] = [];
  const answer =
    (name: string, value: unknown) =>
    (options: unknown): Promise<unknown> => {
      asked.push([name, options]);
      return Promise.resolve(value);
    };
  const vaults = {
    exportStart: answer("exportStart", { token: "z1" }),
    exportAdd: answer("exportAdd", undefined),
    exportFinish: answer("exportFinish", { path: "/cache/exports/My vault.zip" }),
    exportCancel: answer("exportCancel", undefined),
    exportText: answer("exportText", { path: "/cache/exports/Tasks.csv" }),
  } as unknown as NetherVaultsPlugin;
  return { vaults, asked };
}

describe("phoneExporter", () => {
  it("writes a ZIP natively from the vault's files and hands it to the share sheet", async () => {
    const { vaults, asked } = plugin();
    const send = vi.fn(() => Promise.resolve());
    const exporter = phoneExporter(vaults, "v1", send);
    expect(exporter.shares).toBe(true);
    const token = await exporter.choose("My: vault", "zip");
    await exporter.add(token ?? "", [
      { path: "a.md", text: "A" },
      { path: "b.png", source: "b.png" },
    ]);
    expect(await exporter.finish(token ?? "")).toBe("My- vault.zip");
    expect(asked).toEqual([
      ["exportStart", { name: "My- vault" }],
      [
        "exportAdd",
        {
          token: "z1",
          id: "v1",
          entries: [
            { path: "a.md", text: "A" },
            { path: "b.png", source: "b.png" },
          ],
        },
      ],
      ["exportFinish", { token: "z1" }],
    ]);
    expect(send).toHaveBeenCalledWith({
      title: "My- vault",
      files: ["file:///cache/exports/My%20vault.zip"],
    });
  });

  it("saves a CSV as a file for the share sheet, and a closed sheet is no failure", async () => {
    const { vaults, asked } = plugin();
    const send = vi.fn(() => Promise.reject(new Error("Share canceled")));
    const exporter = phoneExporter(vaults, "v1", send);
    const token = await exporter.choose("Tasks", "csv");
    expect(await exporter.saveText(token ?? "", "a,b\n")).toBe("Tasks.csv");
    expect(asked).toEqual([["exportText", { name: "Tasks.csv", text: "a,b\n" }]]);
    const failing = phoneExporter(vaults, "v1", () => Promise.reject(new Error("No app")));
    const again = await failing.choose("Tasks", "csv");
    await expect(failing.saveText(again ?? "", "")).rejects.toThrow("No app");
  });

  it("drops a ZIP cancelled, and offers no PDF", async () => {
    const { vaults, asked } = plugin();
    const exporter = phoneExporter(vaults, "v1", () => Promise.resolve());
    await exporter.cancel((await exporter.choose("V", "zip")) ?? "");
    await exporter.cancel((await exporter.choose("V", "csv")) ?? "");
    expect(asked.map(([name]) => name)).toEqual(["exportStart", "exportCancel"]);
    await expect(exporter.choose("V", "pdf")).rejects.toThrow("PDF");
    await expect(exporter.printPdf("t", { paper: "a4" } as never)).rejects.toThrow("PDF");
    await expect(exporter.finish("unknown")).rejects.toThrow("No export");
  });
});

describe("sendNoteCopy", () => {
  it("sends a note's Markdown as its text and as its file", async () => {
    const { vaults, asked } = plugin();
    const send = vi.fn(() => Promise.resolve());
    await sendNoteCopy(vaults, send, { name: "Plan.md", text: "# Plan\n" });
    expect(asked).toEqual([["exportText", { name: "Plan.md", text: "# Plan\n" }]]);
    expect(send).toHaveBeenCalledWith({
      title: "Plan",
      text: "# Plan\n",
      files: [fileUrl("/cache/exports/Tasks.csv")],
    });
    expect(fileUrl("/a b/c#d.md")).toBe("file:///a%20b/c%23d.md");
  });
});
