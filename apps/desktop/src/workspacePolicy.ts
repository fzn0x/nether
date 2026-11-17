// A workspace's data policy, as its apps keep to it (ADR 0088): where the
// server's policy keeps the workspace's text, the app offers no export of a
// vault linked to it, and says why; the vault's trash is kept for the
// policy's days, and nothing in it is deleted for good while the workspace
// is on legal hold. The server's answer comes in /api/me; the vault keeps
// the last one, for when the server cannot be reached. Nothing is asked as
// the vault opens: only when an export is asked for, as the trash panel
// opens, and once the vault has settled, before its trash is purged.
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

/** How long the app waits on the workspace's server before what it last said holds. */
const askLimit = 5000;

/** How long after a vault opens its trash and history are purged, once it has settled. */
const purgeAfter = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a workspace's data policy asks of its members' apps. */
export interface WorkspacePolicy {
  readonly export: boolean;
  /** How many days the vault keeps its trash; null for its own. */
  readonly trashDays: number | null;
  /** Whether nothing of it is deleted for good. */
  readonly legalHold: boolean;
}

/** What a vault does with no word from its workspace's server: nothing narrowed. */
export const noPolicy: WorkspacePolicy = { export: true, trashDays: null, legalHold: false };

/** What the workspace's server last said of its policy, by workspace; undefined when it has not. */
export async function knownPolicy(
  vault: Vault,
  workspaceId: string,
): Promise<WorkspacePolicy | undefined> {
  const bytes = await vault.settings.setting(policyKey);
  if (bytes === undefined) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as {
      workspace?: unknown;
      export?: unknown;
      trashDays?: unknown;
      legalHold?: unknown;
    };
    if (value.workspace !== workspaceId || typeof value.export !== "boolean") return undefined;
    // A device that kept only export, before trash and hold, was told of neither.
    const days = value.trashDays;
    return {
      export: value.export,
      trashDays: typeof days === "number" && Number.isInteger(days) && days >= 1 ? days : null,
      legalHold: value.legalHold === true,
    };
  } catch {
    return undefined;
  }
}

export async function keepPolicy(vault: Vault, workspaceId: string, policy: WorkspacePolicy) {
  await vault.settings.setSetting(
    policyKey,
    encoder.encode(JSON.stringify({ workspace: workspaceId, ...policy })),
  );
}

/** What the workspace's server says of its policy now, kept for when it cannot be reached. */
async function askServer(vault: Vault, link: VaultLink): Promise<WorkspacePolicy | undefined> {
  const token = await backend.serverToken(link.server);
  if (token === undefined) return undefined;
  const { workspaces } = await account(backend.serverFetch, link.server, token);
  const found = workspaces.find((workspace) => workspace.id === link.workspaceId);
  if (found === undefined) return undefined;
  const policy = {
    export: found.exportAllowed,
    trashDays: found.trashDays,
    legalHold: found.legalHold,
  };
  await keepPolicy(vault, link.workspaceId, policy);
  return policy;
}

/**
 * The policy a vault linked to a workspace keeps to now: what its server
 * says, or, past `limit` milliseconds or with no answer, what it last
 * said; with none ever, nothing narrowed.
 */
export async function policyNow(
  vault: Vault,
  link: VaultLink,
  ask: (vault: Vault, link: VaultLink) => Promise<WorkspacePolicy | undefined> = askServer,
  limit = askLimit,
): Promise<WorkspacePolicy> {
  const kept = await knownPolicy(vault, link.workspaceId);
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
  return answer ?? kept ?? noPolicy;
}

/** Whether a vault linked to a workspace may be exported now, as `policyNow` finds it. */
export async function exportAllowedNow(
  vault: Vault,
  link: VaultLink,
  ask?: (vault: Vault, link: VaultLink) => Promise<WorkspacePolicy | undefined>,
  limit?: number,
): Promise<boolean> {
  return (await policyNow(vault, link, ask, limit)).export;
}

/**
 * Deletes for good what has been in the trash longer than it is kept, and
 * the vault's own versions older than it keeps them, unless the
 * workspace is on legal hold; the trash for the policy's days where it
 * sets them. Gives the policy it kept to.
 */
export async function purgeAsPolicySays(
  vault: Vault,
  link: VaultLink | undefined,
  ask?: (vault: Vault, link: VaultLink) => Promise<WorkspacePolicy | undefined>,
  limit?: number,
): Promise<WorkspacePolicy> {
  const policy = link === undefined ? noPolicy : await policyNow(vault, link, ask, limit);
  if (policy.legalHold) return policy;
  await vault.purgeTrash(policy.trashDays ?? undefined);
  await vault.purgeHistory();
  return policy;
}

/** Purges a vault's trash and history once, a while after it opens, as its workspace's policy says. */
export function usePurgeAsPolicySays(vault: Vault | undefined, link: VaultLink | undefined) {
  const purged = useRef<Vault | undefined>(undefined);
  const linkNow = useRef(link);
  linkNow.current = link;
  useEffect(() => {
    if (vault === undefined || purged.current === vault) return;
    const timer = setTimeout(() => {
      purged.current = vault;
      // What cannot go is tried again the next time the vault opens.
      purgeAsPolicySays(vault, linkNow.current).catch(() => undefined);
    }, purgeAfter);
    return () => {
      clearTimeout(timer);
    };
  }, [vault]);
}

/** What the trash panel shows of its workspace's policy: why it keeps more, and from whom. */
export interface TrashPolicy {
  readonly server: string;
  readonly trashDays: number | null;
  readonly legalHold: boolean;
}

/** The trash policy of a vault linked to a workspace, asked as the trash panel opens. */
export function useTrashPolicy(
  vault: Vault | undefined,
  link: VaultLink | undefined,
): TrashPolicy | undefined {
  const [policy, setPolicy] = useState<TrashPolicy | undefined>();
  const linkNow = useRef(link);
  linkNow.current = link;
  const server = link?.server;
  const workspaceId = link?.workspaceId;
  useEffect(() => {
    setPolicy(undefined);
    const link = linkNow.current;
    if (vault === undefined || link === undefined) return;
    let current = true;
    const host = hostOf(link.server);
    // What it last said shows at once, then what it says now.
    void knownPolicy(vault, link.workspaceId).then((kept) => {
      if (current && kept !== undefined) setPolicy({ server: host, ...kept });
    });
    void policyNow(vault, link).then((now) => {
      if (current) setPolicy({ server: host, ...now });
    });
    return () => {
      current = false;
    };
  }, [vault, server, workspaceId]);
  return policy;
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
