// Which AI provider a vault uses (ADR 0068): the default, one chosen for it,
// or none; none for an encrypted workspace's vault until one is chosen, and
// none where the workspace's owners turned AI off. What this device chose,
// and what the workspace's server last said, stay in the vault's index.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  keepWorkspaceAi,
  knownWorkspaceAi,
  noProviders,
  resolveAi,
  setVaultAiChoice,
  vaultAiChoice,
} from "../src/ai.ts";
import type { AIProvider, AISettings } from "../src/mygo.ts";

const ollama: AIProvider = {
  id: "o",
  name: "Ollama",
  kind: "openai",
  url: "http://localhost:11434/v1",
  model: "llama3.2",
  hasKey: false,
};
const claude: AIProvider = {
  id: "c",
  name: "Claude",
  kind: "anthropic",
  url: "https://api.anthropic.com",
  model: "claude-sonnet-5-5",
  hasKey: true,
};
const two: AISettings = { providers: [ollama, claude], default: "c" };

const plain = { encrypted: false, workspaceAllows: true };

describe("the provider a vault uses", () => {
  it("is none when this device has none, whatever was chosen", () => {
    for (const choice of [
      { kind: "default" },
      { kind: "off" },
      { kind: "provider", id: "o" },
    ] as const) {
      expect(resolveAi({ settings: noProviders, choice, ...plain })).toEqual({
        provider: undefined,
        reason: "none",
      });
    }
  });

  it("is the default, one chosen for the vault, or none when it is off", () => {
    expect(resolveAi({ settings: two, choice: { kind: "default" }, ...plain }).provider).toBe(
      claude,
    );
    expect(
      resolveAi({ settings: two, choice: { kind: "provider", id: "o" }, ...plain }).provider,
    ).toBe(ollama);
    expect(resolveAi({ settings: two, choice: { kind: "off" }, ...plain })).toEqual({
      provider: undefined,
      reason: "vaultOff",
    });
    expect(
      resolveAi({ settings: two, choice: { kind: "provider", id: "gone" }, ...plain }),
    ).toEqual({
      provider: undefined,
      reason: "missing",
    });
    // A default that went: the first left stands in.
    expect(
      resolveAi({ settings: { ...two, default: "gone" }, choice: { kind: "default" }, ...plain })
        .provider,
    ).toBe(ollama);
  });

  it("is none for an encrypted workspace until one is chosen for it", () => {
    const encrypted = { encrypted: true, workspaceAllows: true };
    expect(resolveAi({ settings: two, choice: { kind: "default" }, ...encrypted })).toEqual({
      provider: undefined,
      reason: "encrypted",
    });
    expect(
      resolveAi({ settings: two, choice: { kind: "provider", id: "o" }, ...encrypted }).provider,
    ).toBe(ollama);
  });

  it("is none for an encrypted workspace whose requests would go through its server", () => {
    const relayed = {
      ...two,
      server: { mode: "on", keepsKeys: true, manage: { own: true, instance: false } },
    } as const;
    for (const choice of [{ kind: "default" }, { kind: "provider", id: "o" }] as const) {
      expect(
        resolveAi({ settings: relayed, choice, encrypted: true, workspaceAllows: true }),
      ).toEqual({ provider: undefined, reason: "encryptedRelay" });
    }
    expect(resolveAi({ settings: relayed, choice: { kind: "default" }, ...plain }).provider).toBe(
      claude,
    );
  });

  it("is none where the workspace's owners turned AI off, even one chosen", () => {
    const off = { encrypted: false, workspaceAllows: false };
    expect(resolveAi({ settings: two, choice: { kind: "provider", id: "o" }, ...off })).toEqual({
      provider: undefined,
      reason: "workspaceOff",
    });
  });
});

describe("what a vault keeps of AI on this device", () => {
  it("keeps its choice, and what its workspace's server last said", async () => {
    const files = new MemoryFiles({ "Ideas.md": "# Ideas\n" });
    const vault = new Vault(files, new MemoryStore());
    await vault.open();
    expect(await vaultAiChoice(vault)).toEqual({ kind: "default" });
    await setVaultAiChoice(vault, { kind: "provider", id: "o" });
    expect(await vaultAiChoice(vault)).toEqual({ kind: "provider", id: "o" });
    await setVaultAiChoice(vault, { kind: "off" });
    expect(await vaultAiChoice(vault)).toEqual({ kind: "off" });
    await setVaultAiChoice(vault, { kind: "default" });
    expect(await vaultAiChoice(vault)).toEqual({ kind: "default" });

    expect(await knownWorkspaceAi(vault, "w1")).toBeUndefined();
    await keepWorkspaceAi(vault, "w1", false);
    expect(await knownWorkspaceAi(vault, "w1")).toBe(false);
    // Linked to another workspace since, what the first said does not hold.
    expect(await knownWorkspaceAi(vault, "w2")).toBeUndefined();
    await keepWorkspaceAi(vault, "w1", true);
    expect(await knownWorkspaceAi(vault, "w1")).toBe(true);

    // Nothing of it is in the vault's folder.
    const listed: string[] = [];
    await files.list("", (found) => listed.push(...found.map((file) => file.path)));
    expect(listed).toEqual(["Ideas.md"]);
    await vault.settings.setSetting("ai.vault", new TextEncoder().encode("not json"));
    expect(await vaultAiChoice(vault)).toEqual({ kind: "default" });
  });
});
