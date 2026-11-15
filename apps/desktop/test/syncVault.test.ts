// The vault as the sync engine sees it: which notes changed since a time,
// by their files' times, so an edit made in another editor while the app
// was closed is sent when sync starts again.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { afterEach, describe, expect, it } from "vitest";
import { noteComments } from "../src/noteComments.ts";
import { noteDocuments } from "../src/noteDocuments.ts";
import { DesktopSyncVault } from "../src/syncVault.ts";

const watching: AbortController[] = [];

afterEach(() => {
  for (const controller of watching.splice(0)) controller.abort();
});

/** Waits until `check` holds, two seconds at most. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DesktopSyncVault", () => {
  it("names the notes whose files changed at or after a time, as in another editor", async () => {
    // The files' clock starts at 1000 and moves on by one with each change.
    const memory = new MemoryFiles({ "Ideas.md": "# Ideas\n", "Plan.md": "# Plan\n" }, 1000);
    const vault = new Vault(memory, new MemoryStore());
    await vault.open();
    const controller = new AbortController();
    watching.push(controller);
    void vault.watch(controller.signal);
    const synced = new DesktopSyncVault(vault, noteDocuments(vault), noteComments(vault));
    const id = (path: string) => vault.noteAt(path)?.id;

    expect([...synced.changedSince(1000)].sort()).toEqual([id("Ideas.md"), id("Plan.md")].sort());
    expect([...synced.changedSince(1001)]).toEqual([]);

    memory.edit("Plan.md", "# Plan\n\nWritten elsewhere.\n");
    await until(() => (vault.noteAt("Plan.md")?.modified ?? 0) > 1000);
    expect([...synced.changedSince(1001)]).toEqual([id("Plan.md")]);
  });
});
