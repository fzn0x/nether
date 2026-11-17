// A workspace's data policy, as its apps keep to it (ADR 0088): where the
// server's policy keeps the workspace's text, the app offers no export of a
// vault linked to it, and says why. The server's answer comes in /api/me;
// the vault keeps the last one, for when the server cannot be reached.
// Nothing is asked as the vault opens: only when an export is asked for.
import type { Vault } from "@nether/storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import { account } from "./server.ts";
import { type VaultLink, hostOf } from "./sync.ts";

const policyKey = "policy.workspace";

/** How long an export waits on the workspace's server before what it last said holds. */
const askLimit = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the workspace's server last said of export, by workspace; undefined when it has not. */
export async function knownExport(vault: Vault, workspaceId: string): Promise<boolean | undefined> {
  const bytes = await vault.settings.setting(policyKey);
  if (bytes === undefined) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as { workspace?: unknown; export?: unknown };
    return value.workspace === workspaceId && typeof value.export === "boolean"
      ? value.export
      : undefined;
  } catch {
    return undefined;
  }
}

export async function keepExport(vault: Vault, workspaceId: string, allowed: boolean) {
  await vault.settings.setSetting(
    policyKey,
    encoder.encode(JSON.stringify({ workspace: workspaceId, export: allowed })),
  );
}

/** What the workspace's server says of export now, kept for when it cannot be reached. */
async function askServer(vault: Vault, link: VaultLink): Promise<boolean | undefined> {
  const token = await backend.serverToken(link.server);
  if (token === undefined) return undefined;
  const { workspaces } = await account(backend.serverFetch, link.server, token);
  const found = workspaces.find((workspace) => workspace.id === link.workspaceId);
  if (found === undefined) return undefined;
  await keepExport(vault, link.workspaceId, found.exportAllowed);
  return found.exportAllowed;
}

/**
 * Whether a vault linked to a workspace may be exported now: what its server
 * says, or, past `limit` milliseconds or with no answer, what it last said;
 * with none ever, it may.
 */
export async function exportAllowedNow(
  vault: Vault,
  link: VaultLink,
  ask: (vault: Vault, link: VaultLink) => Promise<boolean | undefined> = askServer,
  limit = askLimit,
): Promise<boolean> {
  const kept = await knownExport(vault, link.workspaceId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    ask(vault, link).catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, limit);
    }),
  ]);
  clearTimeout(timer);
  return answer ?? kept ?? true;
}

/** Whether a vault may be exported, and why not. */
export interface ExportPolicy {
  /** Why export is off, as the server last said; undefined while it is allowed or not known. */
  readonly blocked: string | undefined;
  /**
   * Asks the workspace's server again, before an export: why it is off, or
   * undefined when it is allowed. Past a few seconds, or with no answer,
   * what the server last said holds; with none ever, export is allowed.
   */
  readonly check: () => Promise<string | undefined>;
}

const allowed: ExportPolicy = { blocked: undefined, check: () => Promise.resolve(undefined) };

/** The export policy of the vault open now, for what exports deep in its views, as a database's CSV. */
export const ExportPolicyContext = createContext<ExportPolicy>(allowed);

export function useExportPolicyContext(): ExportPolicy {
  return useContext(ExportPolicyContext);
}

export function useExportPolicy(
  vault: Vault | undefined,
  link: VaultLink | undefined,
): ExportPolicy {
  const [blocked, setBlocked] = useState<string | undefined>();
  // The vault and link a check is for, so one for another vault is let go.
  const current = useRef({ vault, link });
  current.current = { vault, link };

  useEffect(() => {
    setBlocked(undefined);
  }, [vault, link?.server, link?.workspaceId]);

  const check = useCallback(async (): Promise<string | undefined> => {
    const asked = current.current;
    const { vault: open, link: linked } = asked;
    if (open === undefined || linked === undefined) return undefined;
    const exportable = await exportAllowedNow(open, linked);
    const why = exportable ? undefined : t("exportPolicyOff", { server: hostOf(linked.server) });
    if (current.current.vault === open && current.current.link === linked) setBlocked(why);
    return why;
  }, []);

  const linked = link !== undefined;
  return useMemo(() => (linked ? { blocked, check } : allowed), [linked, blocked, check]);
}
