// What the apps keep of a workspace's data policy (ADR 0088): the server's
// last word on export, trash days and legal hold, kept by the vault and
// asked again before an export or a purge, with that word holding while
// the server cannot answer; and the trash purged as the policy says.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type WorkspacePolicy,
  exportAllowedNow,
  keepPolicy,
  knownPolicy,
  noPolicy,
  purgeAsPolicySays,
} from "../src/workspacePolicy.ts";
import type { VaultLink } from "../src/sync.ts";

const link: VaultLink = {
  server: "https://nether.example.org",
  workspaceId: "w1",
  workspaceName: "Team",
};

const day = 86_400_000;

async function openVault(files: Record<string, string> = { "Ideas.md": "# Ideas\n" }) {
  const clock = { now: 1_000 * day };
  const vault = new Vault(new MemoryFiles(files), new MemoryStore(), {
    now: () => clock.now,
  });
  await vault.open();
  return { vault, clock };
}

const policy = (narrowed: Partial<WorkspacePolicy>): WorkspacePolicy => ({
  ...noPolicy,
  ...narrowed,
});

const answers = (answer: WorkspacePolicy | undefined) => () => Promise.resolve(answer);

describe("what a vault keeps of its workspace's policy", () => {
  it("keeps the server's last word, for its workspace alone", async () => {
    const { vault } = await openVault();
    expect(await knownPolicy(vault, "w1")).toBeUndefined();
    await keepPolicy(vault, "w1", policy({ export: false, trashDays: 7, legalHold: true }));
    expect(await knownPolicy(vault, "w1")).toEqual({
      export: false,
      trashDays: 7,
      legalHold: true,
    });
    // Linked to another workspace since, what it kept is not that one's.
    expect(await knownPolicy(vault, "w2")).toBeUndefined();
  });

  it("reads what a device kept before trash and hold as narrowing neither", async () => {
    const { vault } = await openVault();
    await vault.settings.setSetting(
      "policy.workspace",
      new TextEncoder().encode(JSON.stringify({ workspace: "w1", export: false })),
    );
    expect(await knownPolicy(vault, "w1")).toEqual(policy({ export: false }));
  });
});

describe("asking before an export", () => {
  it("takes the server's answer", async () => {
    const { vault } = await openVault();
    await keepPolicy(vault, "w1", noPolicy);
    expect(await exportAllowedNow(vault, link, answers(policy({ export: false })))).toBe(false);
  });

  it("holds to the last word while the server cannot answer, or answers late", async () => {
    const { vault } = await openVault();
    await keepPolicy(vault, "w1", policy({ export: false }));
    const unreachable = () => Promise.reject(new Error("offline"));
    expect(await exportAllowedNow(vault, link, unreachable)).toBe(false);
    const late = () =>
      new Promise<WorkspacePolicy>((resolve) => {
        setTimeout(() => {
          resolve(noPolicy);
        }, 200);
      });
    expect(await exportAllowedNow(vault, link, late, 20)).toBe(false);
  });

  it("lets a vault export when its server has never said", async () => {
    const { vault } = await openVault();
    expect(await exportAllowedNow(vault, link, answers(undefined))).toBe(true);
  });
});

describe("purging as the policy says", () => {
  async function trashed() {
    const opened = await openVault({ "a.md": "A" });
    const first = opened.vault.notes()[0];
    if (first === undefined) throw new Error("The vault has no note.");
    await opened.vault.remove(first.id);
    opened.clock.now += 10 * day;
    return opened;
  }

  it("keeps the trash for the policy's days in place of the vault's own", async () => {
    const { vault } = await trashed();
    await purgeAsPolicySays(vault, link, answers(policy({ trashDays: 30 })));
    expect(await vault.trash()).toHaveLength(1);
    await purgeAsPolicySays(vault, link, answers(policy({ trashDays: 7 })));
    expect(await vault.trash()).toEqual([]);
  });

  it("deletes nothing for good while the workspace is on hold", async () => {
    const { vault, clock } = await trashed();
    clock.now += 100 * day;
    await purgeAsPolicySays(vault, link, answers(policy({ trashDays: 1, legalHold: true })));
    expect(await vault.trash()).toHaveLength(1);
    // Taken off hold, it goes as the vault keeps it.
    await purgeAsPolicySays(vault, link, answers(noPolicy));
    expect(await vault.trash()).toEqual([]);
  });

  it("keeps the vault's own days when it syncs with no workspace", async () => {
    const { vault } = await trashed();
    await purgeAsPolicySays(vault, undefined);
    expect(await vault.trash()).toHaveLength(1);
  });
});
