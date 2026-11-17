// Which AI provider a vault uses, if any (ADRs 0068 and 0070). In the
// desktop app the providers are this device's; in the web app, its
// server's: the account's own and those its admin set for everyone. One is
// the default; a vault uses the default, one chosen for it, or none. A vault
// of an end-to-end encrypted workspace uses none until the user chooses one
// for it, and in the web app none at all, since its requests go through the
// server; a workspace whose owners or admins turned AI off uses none, and
// a server that locks AI to approved endpoints lets it use only a provider
// at one (ADR 0086). With no provider, nothing of AI shows. The choice and
// the last word from the workspace's server are kept in the vault's index
// on this device, outside its folder, so neither syncs.
import { isApproved } from "@nether/ai";
import type { Vault } from "@nether/storage";
import type { AIProvider } from "./mygo.ts";

/** A provider, with whose it is when a server keeps it: the account's own, or everyone's. */
export interface AiProviderEntry extends AIProvider {
  readonly scope?: "own" | "instance";
}

/** What a server says of AI through it, for the web app (ADR 0070). */
export interface ServerAi {
  /** `on`, with accounts' own providers and the admin's; `admin`, the admin's alone; `off`. */
  readonly mode: "on" | "admin" | "off";
  /** Whether it keeps keys, sealed with its admin's secret key. */
  readonly keepsKeys: boolean;
  /** Whether this account may add providers of its own, and the instance's. */
  readonly manage: { readonly own: boolean; readonly instance: boolean };
  /** The only addresses its admin lets AI go to, or null when nothing is locked (ADR 0086). */
  readonly endpoints?: readonly string[] | null;
}

/** The providers a vault can use, and the default; with `server` when a server keeps them. */
export interface AiSettingsView {
  readonly providers: readonly AiProviderEntry[];
  readonly default: string;
  readonly server?: ServerAi;
}

/** What a vault uses: the default provider, one chosen for it, or none. */
export type VaultAiChoice =
  | { readonly kind: "default" }
  | { readonly kind: "provider"; readonly id: string }
  | { readonly kind: "off" };

/**
 * Why a vault has the provider it has, or none:
 * - `ready`: it has one;
 * - `none`: there is no provider to use;
 * - `vaultOff`: AI is off for this vault, on this device;
 * - `workspaceOff`: the workspace's owners or admins turned it off;
 * - `encrypted`: the workspace is end-to-end encrypted, and no provider was chosen for it;
 * - `encryptedRelay`: the workspace is end-to-end encrypted, and requests would go through its server;
 * - `missing`: the provider chosen for it is no longer there;
 * - `notApproved`: the workspace's server locks AI to endpoints, and the provider is at none of them.
 */
export type AiReason =
  | "ready"
  | "none"
  | "vaultOff"
  | "workspaceOff"
  | "encrypted"
  | "encryptedRelay"
  | "missing"
  | "notApproved";

export interface AiResolution {
  readonly provider: AiProviderEntry | undefined;
  readonly reason: AiReason;
}

export const noProviders: AiSettingsView = { providers: [], default: "" };

/** The provider a vault uses, if any, and why. */
export function resolveAi(input: {
  readonly settings: AiSettingsView;
  readonly choice: VaultAiChoice;
  /** Whether the vault syncs with an end-to-end encrypted workspace. */
  readonly encrypted: boolean;
  /** Whether the vault's workspace lets its members' apps offer AI; true when it has none. */
  readonly workspaceAllows: boolean;
  /** The endpoints the workspace's server locks AI to, or null when it locks nothing. */
  readonly endpoints: readonly string[] | null;
}): AiResolution {
  const { settings, choice, encrypted, workspaceAllows, endpoints } = input;
  const none = (reason: AiReason): AiResolution => ({ provider: undefined, reason });
  const allowed = (provider: AiProviderEntry) => allowedBy(endpoints, provider);
  if (settings.providers.length === 0) return none("none");
  if (!workspaceAllows) return none("workspaceOff");
  // Requests through a server would show it an encrypted workspace's text.
  if (encrypted && settings.server !== undefined) return none("encryptedRelay");
  if (choice.kind === "off") return none("vaultOff");
  if (choice.kind === "provider") {
    const chosen = settings.providers.find((provider) => provider.id === choice.id);
    if (chosen === undefined) return none("missing");
    return allowed(chosen) ? { provider: chosen, reason: "ready" } : none("notApproved");
  }
  // An encrypted workspace's text goes to no provider it was not given.
  if (encrypted) return none("encrypted");
  // The default when its endpoint is approved; else the first that is.
  const usable = settings.providers.filter(allowed);
  const fallback = usable.find((provider) => provider.id === settings.default);
  const provider = fallback ?? usable[0];
  return provider === undefined ? none("notApproved") : { provider, reason: "ready" };
}

/** Whether a provider may be used where AI is locked to `endpoints`; any may when nothing is. */
export function allowedBy(endpoints: readonly string[] | null, provider: AIProvider): boolean {
  return endpoints === null || isApproved(provider.url, endpoints);
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

/** What a workspace's server last said of AI: its switch, and the endpoints it locks AI to. */
export interface KnownWorkspaceAi {
  readonly on: boolean;
  readonly endpoints: readonly string[] | null;
}

/** What the workspace's server last said of AI, by workspace; undefined when it has not. */
export async function knownWorkspaceAi(
  vault: Vault,
  workspaceId: string,
): Promise<KnownWorkspaceAi | undefined> {
  const value = readJson(await vault.settings.setting(workspaceKey)) as
    { workspace?: unknown; ai?: unknown; endpoints?: unknown } | undefined;
  if (value?.workspace !== workspaceId || typeof value.ai !== "boolean") return undefined;
  // A device that kept no endpoints, before servers locked any, was told of none.
  const endpoints = Array.isArray(value.endpoints)
    ? (value.endpoints as unknown[]).filter(
        (endpoint): endpoint is string => typeof endpoint === "string",
      )
    : null;
  return { on: value.ai, endpoints };
}

export async function keepWorkspaceAi(
  vault: Vault,
  workspaceId: string,
  known: KnownWorkspaceAi,
): Promise<void> {
  await vault.settings.setSetting(
    workspaceKey,
    encoder.encode(
      JSON.stringify({ workspace: workspaceId, ai: known.on, endpoints: known.endpoints }),
    ),
  );
}
