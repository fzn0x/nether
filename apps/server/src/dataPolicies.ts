// Data policies (ADR 0088). While the `policies` feature is on, an instance
// admin sets for every workspace, or for one set apart, how far its pages
// are shared in public and whether its text leaves the server through the
// public API. The policy for every workspace is kept in instance_settings,
// each workspace set apart in workspace_policies. Every node reads them
// again at most every five seconds; the node that changes one hears of it
// at once, and tells its listeners, which close what the change stops.
import { type Database, readText } from "./db.ts";

/** What a workspace's share links may do: open at any level, only view, or open nothing. */
export const shareLinkPolicies = ["on", "view", "off"] as const;
export type ShareLinkPolicy = (typeof shareLinkPolicies)[number];

/** The settings a policy holds. */
export interface DataPolicy {
  readonly shareLinks: ShareLinkPolicy;
  /** Whether the workspace's published sites are served, over its owners' switch. */
  readonly sites: boolean;
  /** Whether the public API gives the workspace's text and rows, and the apps export it. */
  readonly export: boolean;
}

/** The policy when none holds: nothing narrowed. */
export const openPolicy: DataPolicy = { shareLinks: "on", sites: true, export: true };

/** What a workspace's members' apps keep to of its policy, as /api/me gives it. */
export interface AppsPolicy {
  /** Whether the apps offer to export the workspace's notes. */
  readonly export: boolean;
}

export function appsPolicy(policy: DataPolicy): AppsPolicy {
  return { export: policy.export };
}

/** Why a share link cannot be made or opened, when the policy stops it. */
export const linksOff = "This server's policy allows no share links in this workspace.";
/** Why a link may not comment or edit, when the policy lets links only view. */
export const linksViewOnly = "This server's policy lets this workspace's share links only view.";
/** Why nothing of a workspace is published. */
export const sitesOff = "This server's policy publishes nothing of this workspace.";
/** Why the public API keeps a workspace's text. */
export const exportOff = "This server's policy keeps this workspace's text from being exported.";

const everyKey = "policies.data";

/** How long a node keeps the policies before it reads them again. */
const keptFor = 5_000;

function isShareLinkPolicy(value: unknown): value is ShareLinkPolicy {
  return (shareLinkPolicies as readonly unknown[]).includes(value);
}

/** A policy as it was stored: each setting it lacks, or holds in a form not known, left open. */
export function readPolicy(value: unknown): DataPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return openPolicy;
  const stored = value as Readonly<Record<string, unknown>>;
  return {
    shareLinks: isShareLinkPolicy(stored.shareLinks) ? stored.shareLinks : "on",
    sites: stored.sites !== false,
    export: stored.export !== false,
  };
}

/** A workspace set apart, as the console lists it. */
export interface ApartPolicy {
  readonly workspace: string;
  readonly name: string;
  readonly policy: DataPolicy;
}

/** The policies as the console shows them. */
export interface PoliciesState {
  readonly every: DataPolicy;
  readonly apart: readonly ApartPolicy[];
  /** The workspaces not set apart, which the console may set apart. */
  readonly others: readonly { readonly workspace: string; readonly name: string }[];
}

interface Kept {
  readonly every: DataPolicy;
  readonly apart: ReadonlyMap<string, DataPolicy>;
}

/**
 * Hears which workspaces' policies changed, or null when every
 * workspace's may have: the policy for every workspace, or the feature's
 * switch.
 */
export type PoliciesListener = (workspaces: readonly string[] | null) => void;

export class DataPolicies {
  readonly #db: Database;
  readonly #policiesOn: () => Promise<boolean>;
  readonly #listeners: PoliciesListener[] = [];
  #kept: { readonly at: number; readonly policies: Promise<Kept> } | undefined;

  /** `policiesOn` says whether the `policies` feature is on now. */
  constructor(db: Database, policiesOn: () => Promise<boolean>) {
    this.#db = db;
    this.#policiesOn = policiesOn;
  }

  #read(): Promise<Kept> {
    const kept = this.#kept;
    if (kept !== undefined && Date.now() - kept.at < keptFor) return kept.policies;
    const policies = Promise.all([
      this.#db.query("SELECT value FROM instance_settings WHERE key = $1", [everyKey]),
      this.#db.query("SELECT workspace_id, policy FROM workspace_policies"),
    ]).then(([every, apart]) => ({
      every: readPolicy(every.rows[0]?.value),
      apart: new Map(
        apart.rows.map((row) => [readText(row, "workspace_id"), readPolicy(row.policy)]),
      ),
    }));
    this.#kept = { at: Date.now(), policies };
    // A failed read is not kept: the next asks again.
    policies.catch(() => {
      if (this.#kept?.policies === policies) this.#kept = undefined;
    });
    return policies;
  }

  /** The policy that holds for a workspace now: open while the feature is off. */
  async of(workspace: string): Promise<DataPolicy> {
    if (!(await this.#policiesOn())) return openPolicy;
    const kept = await this.#read();
    return kept.apart.get(workspace) ?? kept.every;
  }

  /** Whether any policy holds: the feature is on. */
  on(): Promise<boolean> {
    return this.#policiesOn();
  }

  /** Every workspace's policy, each workspace set apart, and the others, by name. */
  async state(): Promise<PoliciesState> {
    const [every, apart, others] = await Promise.all([
      this.#db.query("SELECT value FROM instance_settings WHERE key = $1", [everyKey]),
      this.#db.query(
        `SELECT p.workspace_id, w.name, p.policy FROM workspace_policies p
           JOIN workspaces w ON w.id = p.workspace_id
          ORDER BY lower(w.name), w.id`,
      ),
      this.#db.query(
        `SELECT w.id, w.name FROM workspaces w
          WHERE NOT EXISTS (SELECT 1 FROM workspace_policies p WHERE p.workspace_id = w.id)
          ORDER BY lower(w.name), w.id`,
      ),
    ]);
    return {
      every: readPolicy(every.rows[0]?.value),
      apart: apart.rows.map((row) => ({
        workspace: readText(row, "workspace_id"),
        name: readText(row, "name"),
        policy: readPolicy(row.policy),
      })),
      others: others.rows.map((row) => ({
        workspace: readText(row, "id"),
        name: readText(row, "name"),
      })),
    };
  }

  /** Keeps the policy for every workspace not set apart. */
  async setEvery(policy: DataPolicy): Promise<void> {
    await this.#db.query(
      `INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [everyKey, JSON.stringify(policy)],
    );
    this.#changed(null);
  }

  /** Sets a workspace apart with its own policy; false when there is no such workspace. */
  async setApart(workspace: string, policy: DataPolicy): Promise<boolean> {
    const { rows } = await this.#db.query(
      `INSERT INTO workspace_policies (workspace_id, policy)
         SELECT id, $2::jsonb FROM workspaces WHERE id = $1
         ON CONFLICT (workspace_id) DO UPDATE SET policy = excluded.policy, updated_at = now()
       RETURNING workspace_id`,
      [workspace, JSON.stringify(policy)],
    );
    if (rows.length === 0) return false;
    this.#changed([workspace]);
    return true;
  }

  /** Puts a workspace back under every workspace's policy; false when it was not set apart. */
  async removeApart(workspace: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      "DELETE FROM workspace_policies WHERE workspace_id = $1 RETURNING workspace_id",
      [workspace],
    );
    if (rows.length === 0) return false;
    this.#changed([workspace]);
    return true;
  }

  /** Says the feature's switch moved, which may change every workspace's policy. */
  switched(): void {
    this.#changed(null);
  }

  /** Hears of each change this node makes. */
  listen(listener: PoliciesListener): void {
    this.#listeners.push(listener);
  }

  #changed(workspaces: readonly string[] | null): void {
    this.#kept = undefined;
    for (const listener of this.#listeners) listener(workspaces);
  }
}
