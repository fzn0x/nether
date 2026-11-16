// AI for the open vault (ADR 0068): this device's providers, the one the
// vault uses, and its workspace's switch. Reading them costs a call to the
// Go service as the vault opens; the workspace's server is asked only once
// a provider is set up, and again before any text is sent, so an owner or
// admin who turns AI off is heard before the next request. When the server
// cannot be reached, what it last said holds.
import type { Vault } from "@nether/storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AiResolution,
  type VaultAiChoice,
  keepWorkspaceAi,
  knownWorkspaceAi,
  noProviders,
  resolveAi,
  setVaultAiChoice,
  vaultAiChoice,
} from "./ai.ts";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import type { AISettings } from "./mygo.ts";
import { account, setWorkspaceAi } from "./server.ts";
import { type VaultLink, hostOf } from "./sync.ts";

/** The vault's workspace, as its server last told of it. */
export interface WorkspaceAi {
  readonly name: string;
  /** Whether its members' apps may offer AI in it. */
  readonly on: boolean;
  /** This account's role in it, once the server has said. */
  readonly role: string | undefined;
  /** Why the server could not be asked, the last time it was. */
  readonly error: string | undefined;
}

export interface VaultAi {
  readonly settings: AISettings;
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
  /** Asks the workspace's server again, before text is sent; whether AI may run. */
  readonly allowedNow: () => Promise<boolean>;
  /** Asks the workspace's server of its switch even with no provider set up, as the AI tab does for its owners and admins. */
  readonly lookUpWorkspace: () => void;
}

/** How long a request waits on the workspace's server before what it last said holds. */
const askLimit = 5000;

/** What the workspace's server says of its switch now, kept for when it cannot be reached. */
async function askServer(vault: Vault, link: VaultLink): Promise<WorkspaceAi> {
  const token = await backend.serverToken(link.server);
  if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(link.server) }));
  const { workspaces } = await account(backend.serverFetch, link.server, token);
  const found = workspaces.find((workspace) => workspace.id === link.workspaceId);
  if (found === undefined) throw new Error(t("aiNoWorkspace", { workspace: link.workspaceName }));
  await keepWorkspaceAi(vault, link.workspaceId, found.ai);
  return { name: found.name, on: found.ai, role: found.role, error: undefined };
}

export function useAi(vault: Vault | undefined, link: VaultLink | undefined): VaultAi {
  const [settings, setSettings] = useState<AISettings>(noProviders);
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
        on: known ?? true,
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
      }),
    [settings, choice, link, workspace],
  );

  const latest = useRef({ vault, link, workspace });
  latest.current = { vault, link, workspace };

  const allowedNow = useCallback(async () => {
    const { vault: open, link: linked, workspace: known } = latest.current;
    if (open === undefined || linked === undefined) return true;
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
      return fresh.on;
    } catch {
      return known?.on ?? (await knownWorkspaceAi(open, linked.workspaceId)) ?? true;
    }
  }, []);

  const setChoice = useCallback(async (next: VaultAiChoice) => {
    const open = latest.current.vault;
    if (open === undefined) return;
    await setVaultAiChoice(open, next);
    setChoiceState(next);
  }, []);

  const setWorkspace = useCallback(async (on: boolean) => {
    const { vault: open, link: linked } = latest.current;
    if (open === undefined || linked === undefined) return;
    const token = await backend.serverToken(linked.server);
    if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(linked.server) }));
    await setWorkspaceAi(backend.serverFetch, linked.server, token, linked.workspaceId, on);
    await keepWorkspaceAi(open, linked.workspaceId, on);
    setWorkspaceState((previous) =>
      previous === undefined ? previous : { ...previous, on, error: undefined },
    );
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
