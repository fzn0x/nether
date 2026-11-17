// AI for the open vault (ADRs 0068 and 0070): the providers, this device's
// or in the web app its server's, the one the vault uses, and its
// workspace's switch. Reading them costs a call to the Go service, or the
// server, as the vault opens; the workspace's server is asked only once
// a provider is set up, and again before any text is sent, so an owner or
// admin who turns AI off, or locks it to approved endpoints (ADR 0086), is
// heard before the next request. When the server cannot be reached, what it
// last said holds.
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AiResolution,
  type AiSettingsView,
  type VaultAiChoice,
  allowedBy,
  keepWorkspaceAi,
  knownWorkspaceAi,
  noProviders,
  resolveAi,
  setVaultAiChoice,
  vaultAiChoice,
} from "./ai.ts";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import type { AIProvider } from "./mygo.ts";
import { account, setWorkspaceAi } from "./server.ts";
import { type VaultLink, hostOf } from "./sync.ts";

/** The vault's workspace, as its server last told of it. */
export interface WorkspaceAi {
  readonly name: string;
  /** Whether its members' apps may offer AI in it. */
  readonly on: boolean;
  /** The endpoints its server locks AI to, or null when it locks nothing. */
  readonly endpoints: readonly string[] | null;
  /** This account's role in it, once the server has said. */
  readonly role: string | undefined;
  /** Why the server could not be asked, the last time it was. */
  readonly error: string | undefined;
}

export interface VaultAi {
  readonly settings: AiSettingsView;
  readonly choice: VaultAiChoice;
  /** The workspace the vault syncs with; undefined when it syncs with none. */
  readonly workspace: WorkspaceAi | undefined;
  /** The provider the vault uses, if any, and why. */
  readonly resolution: AiResolution;
  /** Reads the providers, the vault's choice and its workspace's switch again. */
  readonly reload: () => void;
  readonly setChoice: (choice: VaultAiChoice) => Promise<void>;
  /** Turns AI on or off for the workspace's members, as its owners and admins may. */
  readonly setWorkspace: (on: boolean) => Promise<void>;
  /**
   * Asks the workspace's server again, before text is sent; whether AI may
   * run, through `provider` or else the vault's own, by its switch and the
   * endpoints it locks AI to.
   */
  readonly allowedNow: (provider?: AIProvider) => Promise<boolean>;
  /** Asks the workspace's server of its switch even with no provider set up, as the AI tab does for its owners and admins. */
  readonly lookUpWorkspace: () => void;
}

/** How long a request waits on the workspace's server before what it last said holds. */
const askLimit = 5000;

/** What the workspace's server says of its switch now, kept for when it cannot be reached. */
async function askServer(vault: Vault, link: VaultLink): Promise<WorkspaceAi> {
  const token = await backend.serverToken(link.server);
  if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(link.server) }));
  const { workspaces, aiEndpoints } = await account(backend.serverFetch, link.server, token);
  const found = workspaces.find((workspace) => workspace.id === link.workspaceId);
  if (found === undefined) throw new Error(t("aiNoWorkspace", { workspace: link.workspaceName }));
  await keepWorkspaceAi(vault, link.workspaceId, { on: found.ai, endpoints: aiEndpoints });
  return {
    name: found.name,
    on: found.ai,
    endpoints: aiEndpoints,
    role: found.role,
    error: undefined,
  };
}

export function useAi(vault: Vault | undefined, link: VaultLink | undefined): VaultAi {
  const [settings, setSettings] = useState<AiSettingsView>(noProviders);
  const [choice, setChoiceState] = useState<VaultAiChoice>({ kind: "default" });
  const [workspace, setWorkspaceState] = useState<WorkspaceAi | undefined>();
  const [round, setRound] = useState(0);
  const reload = useCallback(() => {
    setRound((value) => value + 1);
  }, []);

  useEffect(() => {
    let current = true;
    backend.aiSettings().then(
      (found) => {
        if (current) setSettings(found);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [round]);

  useEffect(() => {
    setChoiceState({ kind: "default" });
    if (vault === undefined) return;
    let current = true;
    void vaultAiChoice(vault).then((found) => {
      if (current) setChoiceState(found);
    });
    return () => {
      current = false;
    };
  }, [vault, round]);

  // The workspace's server is asked only once AI is set up on this device,
  // or the AI tab asks.
  const [wanted, setWanted] = useState(false);
  const lookUpWorkspace = useCallback(() => {
    setWanted(true);
  }, []);
  const configured = settings.providers.length > 0 || wanted;
  useEffect(() => {
    setWorkspaceState(undefined);
    if (vault === undefined || link === undefined || !configured) return;
    let current = true;
    const shown = (next: WorkspaceAi) => {
      if (current) setWorkspaceState(next);
    };
    void (async () => {
      const known = await knownWorkspaceAi(vault, link.workspaceId);
      const kept: WorkspaceAi = {
        name: link.workspaceName,
        on: known?.on ?? true,
        endpoints: known?.endpoints ?? null,
        role: undefined,
        error: undefined,
      };
      shown(kept);
      try {
        shown(await askServer(vault, link));
      } catch (error) {
        shown({ ...kept, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      current = false;
    };
  }, [vault, link, configured, round]);

  const resolution = useMemo(
    () =>
      resolveAi({
        settings,
        choice,
        encrypted: link?.encrypted === true,
        workspaceAllows: link === undefined || (workspace?.on ?? true),
        // The vault's server's lock, or in the web app its own server's.
        endpoints:
          link === undefined
            ? (settings.server?.endpoints ?? null)
            : (workspace?.endpoints ?? settings.server?.endpoints ?? null),
      }),
    [settings, choice, link, workspace],
  );

  const latest = useRef({ vault, link, workspace, resolution });
  latest.current = { vault, link, workspace, resolution };

  const allowedNow = useCallback(async (provider?: AIProvider) => {
    const { vault: open, link: linked, workspace: known, resolution: now } = latest.current;
    if (open === undefined || linked === undefined) return true;
    // Whether the provider about to be used may be, by what the server said.
    const using = provider ?? now.provider;
    const allows = (said: { readonly on: boolean; readonly endpoints: readonly string[] | null }) =>
      said.on && (using === undefined || allowedBy(said.endpoints, using));
    try {
      // A server that does not answer soon holds no request back for long.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("late"));
        }, askLimit);
      });
      const fresh = await Promise.race([askServer(open, linked), late]).finally(() => {
        clearTimeout(timer);
      });
      setWorkspaceState(fresh);
      return allows(fresh);
    } catch {
      const said = known ?? (await knownWorkspaceAi(open, linked.workspaceId));
      return said === undefined ? true : allows(said);
    }
  }, []);

  const setChoice = useCallback(async (next: VaultAiChoice) => {
    const open = latest.current.vault;
    if (open === undefined) return;
    await setVaultAiChoice(open, next);
    setChoiceState(next);
  }, []);

  const setWorkspace = useCallback(async (on: boolean) => {
    const { vault: open, link: linked, workspace: known } = latest.current;
    if (open === undefined || linked === undefined) return;
    const shown = (value: boolean) => {
      setWorkspaceState((previous) =>
        previous === undefined ? previous : { ...previous, on: value, error: undefined },
      );
    };
    // The switch moves at once, and back if the server refuses.
    shown(on);
    try {
      const token = await backend.serverToken(linked.server);
      if (token === undefined) {
        throw new Error(t("syncSignedOut", { server: hostOf(linked.server) }));
      }
      await setWorkspaceAi(backend.serverFetch, linked.server, token, linked.workspaceId, on);
    } catch (error) {
      shown(!on);
      throw error;
    }
    await keepWorkspaceAi(open, linked.workspaceId, {
      on,
      endpoints: known?.endpoints ?? null,
    });
  }, []);

  return {
    settings,
    choice,
    workspace,
    resolution,
    reload,
    setChoice,
    setWorkspace,
    allowedNow,
    lookUpWorkspace,
  };
}
