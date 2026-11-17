// Which AI provider a vault uses, if any (ADR 0068). The providers are this
// device's, with one the default; a vault uses the default, one chosen for
// it, or none. A vault of an end-to-end encrypted workspace uses none until
// the user chooses one for it, and a workspace whose owners or admins
// turned AI off uses none at all. With no provider, nothing of AI shows.
// The choice and the last word from the workspace's server are kept in the
// vault's index on this device, outside its folder, so neither syncs.
import type { Vault } from "@nether/storage";
import type { AIProvider, AISettings } from "./mygo.ts";

/** What a vault uses: the device's default provider, one chosen for it, or none. */
export type VaultAiChoice =
  | { readonly kind: "default" }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "off" };

/**
 * Why a vault has the provider it has, or none:
 * - `ready`: it has one;
 * - `none`: this device has no provider set up;
 * - `vaultOff`: AI is off for this vault, on this device;
 * - `workspaceOff`: the workspace's owners or admins turned it off;
 * - `encrypted`: the workspace is end-to-end encrypted, and no provider was chosen for it;
 * - `missing`: the provider chosen for it is no longer set up.
 */
export type AiReason = "ready" | "none" | "vaultOff" | "workspaceOff" | "encrypted" | "missing";

export interface AiResolution {
  readonly provider: AIProvider | undefined;
  readonly reason: AiReason;
}

export const noProviders: AISettings = { providers: [], default: "" };

/** The provider a vault uses, if any, and why. */
export function resolveAi(input: {
  readonly settings: AISettings;
  readonly choice: VaultAiChoice;
  /** Whether the vault syncs with an end-to-end encrypted workspace. */
  readonly encrypted: boolean;
  /** Whether the vault's workspace lets its members' apps offer AI; true when it has none. */
  readonly workspaceAllows: boolean;
}): AiResolution {
  const { settings, choice, encrypted, workspaceAllows } = input;
  const none = (reason: AiReason): AiResolution => ({ provider: undefined, reason });
  if (settings.providers.length === 0) return none("none");
  if (!workspaceAllows) return none("workspaceOff");
  if (choice.kind === "off") return none("vaultOff");
  if (choice.kind === "provider") {
    const chosen = settings.providers.find((provider) => provider.id === choice.id);
    return chosen === undefined ? none("missing") : { provider: chosen, reason: "ready" };
  }
  // An encrypted workspace's text goes to no provider it was not given.
  if (encrypted) return none("encrypted");
  const fallback = settings.providers.find((provider) => provider.id === settings.default);
  return { provider: fallback ?? settings.providers[0], reason: "ready" };
}

const choiceKey = "ai.vault";
const workspaceKey = "ai.workspace";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** What this device has the vault use. */
export async function vaultAiChoice(vault: Vault): Promise<VaultAiChoice> {
  const value = readJson(await vault.settings.setting(choiceKey)) as
    { provider?: unknown; off?: unknown } | undefined;
  if (value?.off === true) return { kind: "off" };
  if (typeof value?.provider === "string") return { kind: "provider", id: value.provider };
  return { kind: "default" };
}

export async function setVaultAiChoice(vault: Vault, choice: VaultAiChoice): Promise<void> {
  const value =
    choice.kind === "default"
      ? undefined
      : choice.kind === "off"
        ? { off: true }
        : { provider: choice.id };
  await vault.settings.setSetting(
    choiceKey,
    value === undefined ? undefined : encoder.encode(JSON.stringify(value)),
  );
}

/** What the workspace's server last said of its switch, by workspace; undefined when it has not. */
export async function knownWorkspaceAi(
  vault: Vault,
  workspaceId: string,
): Promise<boolean | undefined> {
  const value = readJson(await vault.settings.setting(workspaceKey)) as
    { workspace?: unknown; ai?: unknown } | undefined;
  return value?.workspace === workspaceId && typeof value.ai === "boolean" ? value.ai : undefined;
}

export async function keepWorkspaceAi(
  vault: Vault,
  workspaceId: string,
  on: boolean,
): Promise<void> {
  await vault.settings.setSetting(
    workspaceKey,
    encoder.encode(JSON.stringify({ workspace: workspaceId, ai: on })),
  );
}
