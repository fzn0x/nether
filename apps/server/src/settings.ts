// The server's security settings (ADR 0084): how long sessions last, how
// many sign-in tries an account and an address get, and whether a code by
// email signs in. Each is the console's, kept in instance_settings, unless
// the environment pins it. A pinned value is written there when the server
// starts, so the queries that check sessions read one place; the console
// cannot change it. The server reads the rest again at most every five
// seconds, so a change reaches every node within that.
import type { Database } from "./db.ts";

interface NumberSetting {
  readonly kind: "number";
  readonly variable: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

interface SwitchSetting {
  readonly kind: "switch";
  readonly variable: string;
  readonly fallback: boolean;
}

export const securitySettings = {
  sessionIdleDays: {
    kind: "number",
    variable: "NETHER_SESSION_IDLE_DAYS",
    fallback: 30,
    min: 1,
    max: 365,
  },
  sessionLifetimeDays: {
    kind: "number",
    variable: "NETHER_SESSION_LIFETIME_DAYS",
    fallback: 90,
    min: 1,
    max: 3650,
  },
  signInTriesAccount: {
    kind: "number",
    variable: "NETHER_SIGN_IN_TRIES_ACCOUNT",
    fallback: 10,
    min: 3,
    max: 100,
  },
  signInTriesAddress: {
    kind: "number",
    variable: "NETHER_SIGN_IN_TRIES_ADDRESS",
    fallback: 30,
    min: 5,
    max: 1000,
  },
  emailCodes: { kind: "switch", variable: "NETHER_SIGN_IN_EMAIL_CODES", fallback: true },
} as const satisfies Record<string, NumberSetting | SwitchSetting>;

export type SecuritySetting = keyof typeof securitySettings;

/** Every security setting's value now. */
export interface SecurityValues {
  readonly sessionIdleDays: number;
  readonly sessionLifetimeDays: number;
  readonly signInTriesAccount: number;
  readonly signInTriesAddress: number;
  readonly emailCodes: boolean;
}

/** The values the environment pins; the others are the console's. */
export type SecurityPins = Partial<SecurityValues>;

export const securityNames = Object.keys(securitySettings) as SecuritySetting[];

/** A setting as the console shows it. */
export interface SecurityState {
  readonly name: SecuritySetting;
  readonly value: number | boolean;
  /** The variable that pins it, when the environment does; null when the console decides. */
  readonly pinnedBy: string | null;
  /** A number's range; none for a switch. */
  readonly min?: number;
  readonly max?: number;
}

/** A change the settings refuse: why, for the console to show. */
export class SettingRefused extends Error {
  override readonly name = "SettingRefused";
  /** 400 for a setting unknown or out of range, 409 for one the environment pins. */
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** The key a setting is kept under in `instance_settings`. */
export function settingKey(name: SecuritySetting): string {
  return `security.${name}`;
}

/** Whether a name is a security setting's. */
export function isSecuritySetting(name: string): name is SecuritySetting {
  return Object.hasOwn(securitySettings, name);
}

/** Whether a value fits a setting: a whole number in its range, or on or off. */
export function fits(name: SecuritySetting, value: unknown): boolean {
  const setting: NumberSetting | SwitchSetting = securitySettings[name];
  if (setting.kind === "switch") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= setting.min &&
    value <= setting.max
  );
}

/**
 * SQL for a number setting's value now, as kept, or its default: for the
 * queries that check sessions, so they need no value passed in. It names
 * constants alone, never anything a request sent.
 */
export function settingSql(name: "sessionIdleDays" | "sessionLifetimeDays"): string {
  const setting = securitySettings[name];
  return `coalesce((SELECT (value #>> '{}')::int FROM instance_settings WHERE key = '${settingKey(name)}'), ${String(setting.fallback)})`;
}

/** How long the server keeps the settings before it reads them again. */
const keptFor = 5_000;

export class SecuritySettings {
  readonly #db: Database;
  readonly #pins: SecurityPins;
  #kept: { readonly at: number; readonly values: Promise<SecurityValues> } | undefined;

  constructor(db: Database, pins: SecurityPins = {}) {
    this.#db = db;
    this.#pins = pins;
  }

  /** Writes the pinned values where every node and query reads them; at startup. */
  async applyPins(): Promise<void> {
    for (const name of securityNames) {
      const pin = this.#pins[name];
      if (pin !== undefined) await this.#write(name, pin);
    }
    this.#kept = undefined;
  }

  async #write(name: SecuritySetting, value: number | boolean): Promise<void> {
    await this.#db.query(
      `INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [settingKey(name), JSON.stringify(value)],
    );
  }

  #read(): Promise<SecurityValues> {
    const kept = this.#kept;
    if (kept !== undefined && Date.now() - kept.at < keptFor) return kept.values;
    const values = this.#db
      .query("SELECT key, value FROM instance_settings WHERE key LIKE 'security.%'")
      .then(({ rows }) => {
        const chosen = new Map<string, unknown>(rows.map((row) => [String(row.key), row.value]));
        const number = (name: Exclude<SecuritySetting, "emailCodes">): number => {
          const value = this.#pins[name] ?? chosen.get(settingKey(name));
          return fits(name, value) ? (value as number) : securitySettings[name].fallback;
        };
        const emailCodes = this.#pins.emailCodes ?? chosen.get(settingKey("emailCodes"));
        return {
          sessionIdleDays: number("sessionIdleDays"),
          sessionLifetimeDays: number("sessionLifetimeDays"),
          signInTriesAccount: number("signInTriesAccount"),
          signInTriesAddress: number("signInTriesAddress"),
          emailCodes:
            typeof emailCodes === "boolean" ? emailCodes : securitySettings.emailCodes.fallback,
        };
      });
    this.#kept = { at: Date.now(), values };
    // A failed read is not kept: the next asks again.
    values.catch(() => {
      if (this.#kept?.values === values) this.#kept = undefined;
    });
    return values;
  }

  /** The settings now. */
  values(): Promise<SecurityValues> {
    return this.#read();
  }

  /** Each setting, with its value, what pins it and its range, as the console shows them. */
  async states(): Promise<SecurityState[]> {
    const values = await this.#read();
    return securityNames.map((name) => {
      const setting: NumberSetting | SwitchSetting = securitySettings[name];
      const pinnedBy = this.#pins[name] === undefined ? null : setting.variable;
      return setting.kind === "number"
        ? { name, value: values[name], pinnedBy, min: setting.min, max: setting.max }
        : { name, value: values[name], pinnedBy };
    });
  }

  /**
   * Keeps the console's values, all or none: a setting unknown, pinned or
   * out of range refuses the change. This server sees it at once.
   */
  async set(changes: Readonly<Record<string, unknown>>): Promise<void> {
    const names = Object.keys(changes);
    for (const name of names) {
      if (!isSecuritySetting(name)) throw new SettingRefused(400, `There is no setting ${name}.`);
      const setting: NumberSetting | SwitchSetting = securitySettings[name];
      if (this.#pins[name] !== undefined) {
        throw new SettingRefused(409, `${setting.variable} sets it: change it there.`);
      }
      if (!fits(name, changes[name])) {
        throw new SettingRefused(
          400,
          setting.kind === "number"
            ? `${name} is a whole number from ${String(setting.min)} to ${String(setting.max)}.`
            : `${name} is true or false.`,
        );
      }
    }
    await this.#db.transaction(async (tx) => {
      for (const name of names) {
        await tx.query(
          `INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
          [settingKey(name as SecuritySetting), JSON.stringify(changes[name])],
        );
      }
    });
    this.#kept = undefined;
  }
}
