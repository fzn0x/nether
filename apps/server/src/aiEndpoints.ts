// The approved AI endpoints (ADR 0086). While the `policies` feature is on
// and the list holds one, AI for every workspace on the server goes only to
// addresses at or under one of them, in every Nether app: the relay
// refuses others, and the apps read the list in /api/me. It is the
// console's, kept in instance_settings and read again at most every five
// seconds, unless NETHER_AI_ENDPOINTS pins it.
import { endpointOf } from "@nether/ai";
import type { Database, Queryable } from "./db.ts";
import { SettingRefused } from "./settings.ts";

/** The most endpoints the list holds. */
export const maxEndpoints = 20;

/** The variable that pins the list. */
export const endpointsVariable = "NETHER_AI_ENDPOINTS";

const settingKey = "policies.aiEndpoints";

/** How long the server keeps the list before it reads it again. */
const keptFor = 5_000;

/** Why a refused provider cannot be used: the endpoints this server allows. */
export function lockedMessage(endpoints: readonly string[]): string {
  return `This server's admin allows AI only through ${endpoints.join(", ")}.`;
}

/** The list as the console shows it. */
export interface EndpointsState {
  readonly endpoints: readonly string[];
  /** The variable that pins it, when the environment does; null when the console decides. */
  readonly pinnedBy: string | null;
}

/**
 * Reads a list of endpoints from text, one per line or comma: each one's
 * form for comparing, in order, without repeats. Throws a SettingRefused
 * naming the first that is not an address, or when there are too many.
 */
export function readEndpoints(entries: readonly string[]): string[] {
  const list: string[] = [];
  for (const entry of entries) {
    if (entry.trim() === "") continue;
    const endpoint = endpointOf(entry);
    if (endpoint === undefined) {
      throw new SettingRefused(400, `${entry.trim()} is not an http or https address.`);
    }
    if (!list.includes(endpoint)) list.push(endpoint);
  }
  if (list.length > maxEndpoints) {
    throw new SettingRefused(400, `The list holds ${String(maxEndpoints)} endpoints at most.`);
  }
  return list;
}

export class AiEndpoints {
  readonly #db: Database;
  readonly #pin: readonly string[] | undefined;
  readonly #policiesOn: () => Promise<boolean>;
  #kept: { readonly at: number; readonly list: Promise<readonly string[]> } | undefined;

  /**
   * `pin` is the list NETHER_AI_ENDPOINTS gives, if it is set;
   * `policiesOn` says whether the `policies` feature is on now.
   */
  constructor(
    db: Database,
    pin: readonly string[] | undefined,
    policiesOn: () => Promise<boolean>,
  ) {
    this.#db = db;
    this.#pin = pin;
    this.#policiesOn = policiesOn;
  }

  #list(): Promise<readonly string[]> {
    if (this.#pin !== undefined) return Promise.resolve(this.#pin);
    const kept = this.#kept;
    if (kept !== undefined && Date.now() - kept.at < keptFor) return kept.list;
    const list = this.#db
      .query("SELECT value FROM instance_settings WHERE key = $1", [settingKey])
      .then(({ rows }) => {
        const value: unknown = rows[0]?.value;
        if (!Array.isArray(value)) return [];
        // Kept as the console wrote it; an entry that is no address is let go.
        return value.flatMap((entry: unknown) => {
          const endpoint = typeof entry === "string" ? endpointOf(entry) : undefined;
          return endpoint === undefined ? [] : [endpoint];
        });
      });
    this.#kept = { at: Date.now(), list };
    // A failed read is not kept: the next asks again.
    list.catch(() => {
      if (this.#kept?.list === list) this.#kept = undefined;
    });
    return list;
  }

  /** The endpoints AI is locked to now, or null when nothing is: the feature off, or no list. */
  async locked(): Promise<readonly string[] | null> {
    if (!(await this.#policiesOn())) return null;
    const list = await this.#list();
    return list.length === 0 ? null : list;
  }

  /** The list, and what pins it, as the console shows them. */
  async state(): Promise<EndpointsState> {
    return {
      endpoints: await this.#list(),
      pinnedBy: this.#pin === undefined ? null : endpointsVariable,
    };
  }

  /**
   * Keeps the console's list, refused where the environment pins it; this
   * server sees it at once. `tell` runs in its transaction with the list
   * before and after, as an event of the change is told (ADR 0081).
   */
  async set(
    entries: readonly string[],
    tell?: (tx: Queryable, before: readonly string[], after: readonly string[]) => Promise<void>,
  ): Promise<readonly string[]> {
    if (this.#pin !== undefined) {
      throw new SettingRefused(409, `${endpointsVariable} sets it: change it there.`);
    }
    const list = readEndpoints(entries);
    await this.#db.transaction(async (tx) => {
      const { rows } = await tx.query(
        "SELECT value FROM instance_settings WHERE key = $1 FOR UPDATE",
        [settingKey],
      );
      const value: unknown = rows[0]?.value;
      const before = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
      await tx.query(
        `INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [settingKey, JSON.stringify(list)],
      );
      await tell?.(tx, before, list);
    });
    this.#kept = undefined;
    return list;
  }
}
