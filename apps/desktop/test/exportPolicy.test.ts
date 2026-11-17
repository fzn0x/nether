// What the apps keep of a workspace's data policy (ADR 0088): the server's
// last word on export, kept by the vault, and asked again before an export,
// with that word holding while the server cannot answer.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import { exportAllowedNow, keepExport, knownExport } from "../src/exportPolicy.ts";
import type { VaultLink } from "../src/sync.ts";

const link: VaultLink = {
  server: "https://nether.example.org",
  workspaceId: "w1",
  workspaceName: "Team",
};

async function openVault(): Promise<Vault> {
  const vault = new Vault(new MemoryFiles({ "Ideas.md": "# Ideas\n" }), new MemoryStore());
  await vault.open();
  return vault;
}

describe("what a vault keeps of its workspace's export policy", () => {
  it("keeps the server's last word, for its workspace alone", async () => {
    const vault = await openVault();
    expect(await knownExport(vault, "w1")).toBeUndefined();
    await keepExport(vault, "w1", false);
    expect(await knownExport(vault, "w1")).toBe(false);
    // Linked to another workspace since, what it kept is not that one's.
    expect(await knownExport(vault, "w2")).toBeUndefined();
    await keepExport(vault, "w1", true);
    expect(await knownExport(vault, "w1")).toBe(true);
  });
});

describe("asking before an export", () => {
  it("takes the server's answer", async () => {
    const vault = await openVault();
    await keepExport(vault, "w1", true);
    expect(await exportAllowedNow(vault, link, () => Promise.resolve(false))).toBe(false);
  });

  it("holds to the last word while the server cannot answer, or answers late", async () => {
    const vault = await openVault();
    await keepExport(vault, "w1", false);
    const unreachable = () => Promise.reject(new Error("offline"));
    expect(await exportAllowedNow(vault, link, unreachable)).toBe(false);
    const late = () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(true);
        }, 200);
      });
    expect(await exportAllowedNow(vault, link, late, 20)).toBe(false);
  });

  it("lets a vault export when its server has never said", async () => {
    const vault = await openVault();
    expect(await exportAllowedNow(vault, link, () => Promise.resolve(undefined))).toBe(true);
  });
});
