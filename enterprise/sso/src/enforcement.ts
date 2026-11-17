// What single sign-on requires (ADR 0080): a provider's domains, whose
// accounts sign in through it alone, or everyone, every account through a
// provider, an account at no provider's domain through any it is linked
// to. Instance admins are exempt unless the console covers them too, and
// NETHER_SSO_ENFORCE=off pins it all off. The server asks this guard
// before it looks an account up by its address, when a session starts and
// each time one or a token is used; the rules it reads are kept for five
// seconds, as the switches are, so asking costs no query.
import {
  type Database,
  type Queryable,
  readBoolean,
  readText,
  readTextOrNull,
} from "@nether/server/src/db.ts";
import { sessionMethodOf } from "@nether/server/src/events.ts";
import type {
  Refusal,
  RequiredProvider,
  SignInAttempt,
  SignInGuard,
} from "@nether/server/src/signIns.ts";
import { addressDomain } from "./providers.ts";

/** What the console's page sets beside each provider's own switch. */
export interface EnforcementSettings {
  /** Every account signs in through a provider. */
  readonly everyone: boolean;
  /** Instance admins are covered too, not exempt. */
  readonly admins: boolean;
}

/** The provider a domain belongs to, and whether its accounts sign in through it alone. */
interface DomainOwner extends RequiredProvider {
  readonly required: boolean;
}

/** What is required now, as the guard reads it. */
export interface Rules extends EnforcementSettings {
  readonly domains: ReadonlyMap<string, DomainOwner>;
}

const settingKeys = { everyone: "sso.everyone", admins: "sso.admins" } as const;

/** The page's settings, as kept in `instance_settings`. */
export async function readSettings(db: Queryable): Promise<EnforcementSettings> {
  const { rows } = await db.query("SELECT key, value FROM instance_settings WHERE key = ANY($1)", [
    Object.values(settingKeys),
  ]);
  const kept = new Map(rows.map((row) => [readText(row, "key"), row.value === true]));
  return {
    everyone: kept.get(settingKeys.everyone) ?? false,
    admins: kept.get(settingKeys.admins) ?? false,
  };
}

/** Keeps the settings the page changed. */
export async function saveSettings(
  db: Queryable,
  settings: Partial<EnforcementSettings>,
): Promise<void> {
  for (const name of ["everyone", "admins"] as const) {
    const value = settings[name];
    if (value === undefined) continue;
    await db.query(
      `INSERT INTO instance_settings (key, value) VALUES ($1, to_jsonb($2::boolean))
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [settingKeys[name], value],
    );
  }
}

/** Every rule as kept now. */
export async function readRules(db: Queryable): Promise<Rules> {
  const settings = await readSettings(db);
  const { rows } = await db.query(
    `SELECT d.domain, p.id, p.name, p.required
       FROM sso_domains d JOIN sso_providers p ON p.id = d.provider_id`,
  );
  return {
    ...settings,
    domains: new Map(
      rows.map((row) => [
        readText(row, "domain"),
        {
          id: readText(row, "id"),
          name: readText(row, "name"),
          required: readBoolean(row, "required"),
        },
      ]),
    ),
  };
}

/** The provider an address must sign in through, known by its domain alone. */
export function requiredBy(rules: Rules, email: string): RequiredProvider | undefined {
  const owner = rules.domains.get(addressDomain(email));
  if (owner === undefined || !(owner.required || rules.everyone)) return undefined;
  return { id: owner.id, name: owner.name };
}

/** Whether an address signs in through a provider alone, its admins aside: by its domain, or everyone. */
export function covers(rules: Rules, email: string): boolean {
  return rules.everyone || rules.domains.get(addressDomain(email))?.required === true;
}

/** Why the rules refuse a session begun as `attempt` says, if they do. */
export function refusalOf(rules: Rules, attempt: SignInAttempt): Refusal | undefined {
  if (attempt.instanceAdmin && !rules.admins) return undefined;
  if (!covers(rules, attempt.email)) return undefined;
  const domain = addressDomain(attempt.email);
  const owner = rules.domains.get(domain);
  if (owner !== undefined) {
    return attempt.method === "sso" && attempt.provider === owner.id
      ? undefined
      : { reason: `accounts at ${domain} sign in through the provider ${owner.id} alone` };
  }
  // Everyone: at no provider's domain, any provider it is linked to.
  return attempt.method === "sso" || attempt.method === "oidc"
    ? undefined
    : { reason: "every account signs in through a provider" };
}

/** How long the rules are kept before they are read again. */
const keptFor = 5_000;

/** Sessions and tokens a change of the rules ended. */
export interface Ended {
  readonly sessions: number;
  readonly tokens: number;
}

/** Single sign-on's guard: the rules, while the feature is on and the environment lets them apply. */
export class Enforcement implements SignInGuard {
  readonly #db: Database;
  readonly #isOn: (db?: Queryable) => Promise<boolean>;
  readonly #enforce: boolean;
  #kept: { readonly at: number; readonly rules: Promise<Rules> } | undefined;

  constructor(db: Database, isOn: (db?: Queryable) => Promise<boolean>, enforce: boolean) {
    this.#db = db;
    this.#isOn = isOn;
    this.#enforce = enforce;
  }

  /** Whether NETHER_SSO_ENFORCE=off pins enforcement off. */
  get pinnedOff(): boolean {
    return !this.#enforce;
  }

  /**
   * The rules that apply now; none while the feature is off or pinned off.
   * Asked within a transaction, what it reads again it reads through it.
   */
  async rules(db: Queryable = this.#db): Promise<Rules | undefined> {
    if (!this.#enforce || !(await this.#isOn(db))) return undefined;
    const kept = this.#kept;
    if (kept !== undefined && Date.now() - kept.at < keptFor) return kept.rules;
    const rules = readRules(db);
    this.#kept = { at: Date.now(), rules };
    // A failed read is not kept: the next asks again.
    rules.catch(() => {
      if (this.#kept?.rules === rules) this.#kept = undefined;
    });
    return rules;
  }

  /** Reads the rules again at the next question, as after the page changes them. */
  forget(): void {
    this.#kept = undefined;
  }

  async requiredFor(email: string): Promise<RequiredProvider | undefined> {
    const rules = await this.rules();
    return rules === undefined ? undefined : requiredBy(rules, email);
  }

  async check(attempt: SignInAttempt, db: Queryable): Promise<Refusal | undefined> {
    const rules = await this.rules(db);
    return rules === undefined ? undefined : refusalOf(rules, attempt);
  }

  /**
   * Ends every session and token the rules refuse now, and closes their
   * accounts' sync connections, so their apps connect again and are
   * checked anew; as the page saves a change.
   */
  async sweep(disconnect: (userId: string) => void): Promise<Ended> {
    this.forget();
    const rules = await this.rules();
    if (rules === undefined) return { sessions: 0, tokens: 0 };
    const ended = new Set<string>();
    const count = { sessions: 0, tokens: 0 };
    for (const table of ["sessions", "api_tokens"] as const) {
      const { rows } = await this.#db.query(
        `SELECT t.id, t.method, t.provider, u.id AS user_id, u.email, u.instance_admin
           FROM ${table} t JOIN users u ON u.id = t.user_id`,
      );
      const refused = rows.filter(
        (row) =>
          refusalOf(rules, {
            userId: readText(row, "user_id"),
            email: readText(row, "email"),
            instanceAdmin: readBoolean(row, "instance_admin"),
            method: sessionMethodOf(readTextOrNull(row, "method")),
            provider: readTextOrNull(row, "provider"),
          }) !== undefined,
      );
      if (refused.length === 0) continue;
      await this.#db.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [
        refused.map((row) => readText(row, "id")),
      ]);
      for (const row of refused) ended.add(readText(row, "user_id"));
      count[table === "sessions" ? "sessions" : "tokens"] = refused.length;
    }
    for (const userId of ended) disconnect(userId);
    return count;
  }
}
