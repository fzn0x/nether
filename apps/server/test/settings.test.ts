// The security settings (ADR 0084): the sessions' lengths, the sign-in
// limits and email codes, each the console's unless the environment pins
// it; and the server keeping to them, at once for sessions.
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config.ts";
import { tokenHash } from "../src/sessions.ts";
import { SecuritySettings, SettingRefused } from "../src/settings.ts";
import { type TestServer, TestMailer, admin, bearer, setUp, signIn, startServer } from "./app.ts";

let running: TestServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(options: Parameters<typeof startServer>[0] = {}) {
  running = await startServer(options);
  await setUp(running);
  return running;
}

/**
 * The settings as the console sets them: kept in the database. Set before
 * the server first reads them, it reads them at once; after, within five
 * seconds.
 */
function consoleSettings(test: TestServer) {
  return new SecuritySettings(test.db);
}

const env = { NETHER_DATABASE_URL: "postgres://localhost/nether" };

describe("the security settings' variables", () => {
  it("pin the settings they set, each in its range", () => {
    const config = readConfig({
      ...env,
      NETHER_SESSION_IDLE_DAYS: "7",
      NETHER_SESSION_LIFETIME_DAYS: " 30 ",
      NETHER_SIGN_IN_EMAIL_CODES: "off",
    });
    expect(config.security).toEqual({
      sessionIdleDays: 7,
      sessionLifetimeDays: 30,
      emailCodes: false,
    });
  });

  it("stop the server at a value out of range, naming the variable", () => {
    expect(() => readConfig({ ...env, NETHER_SIGN_IN_TRIES_ACCOUNT: "2" })).toThrow(ConfigError);
    expect(() => readConfig({ ...env, NETHER_SESSION_IDLE_DAYS: "seven" })).toThrow(
      /NETHER_SESSION_IDLE_DAYS must be a whole number from 1 to 365/,
    );
    expect(() => readConfig({ ...env, NETHER_SIGN_IN_EMAIL_CODES: "maybe" })).toThrow(
      /NETHER_SIGN_IN_EMAIL_CODES must be on or off/,
    );
  });
});

describe("the security settings", () => {
  it("start at their defaults, and keep the console's values", async () => {
    const test = await start();
    const settings = consoleSettings(test);
    expect(await settings.values()).toEqual({
      sessionIdleDays: 30,
      sessionLifetimeDays: 90,
      signInTriesAccount: 10,
      signInTriesAddress: 30,
      emailCodes: true,
    });
    await settings.set({ sessionIdleDays: 7, emailCodes: false });
    expect(await consoleSettings(test).values()).toMatchObject({
      sessionIdleDays: 7,
      emailCodes: false,
    });
    const states = await settings.states();
    expect(states.find((state) => state.name === "sessionIdleDays")).toEqual({
      name: "sessionIdleDays",
      value: 7,
      pinnedBy: null,
      min: 1,
      max: 365,
    });
  });

  it("refuse a change unknown, out of range or pinned, and keep none of it", async () => {
    const test = await start();
    const settings = new SecuritySettings(test.db, { signInTriesAccount: 5 });
    const refused = async (changes: Record<string, unknown>) => {
      try {
        await settings.set(changes);
      } catch (error) {
        return error instanceof SettingRefused ? [error.status, error.message] : error;
      }
      return undefined;
    };
    expect(await refused({ sessionIdleDays: 7, colour: "red" })).toEqual([
      400,
      "There is no setting colour.",
    ]);
    expect(await refused({ sessionIdleDays: 0 })).toEqual([
      400,
      "sessionIdleDays is a whole number from 1 to 365.",
    ]);
    expect(await refused({ emailCodes: "no" })).toEqual([400, "emailCodes is true or false."]);
    expect(await refused({ signInTriesAccount: 20 })).toEqual([
      409,
      "NETHER_SIGN_IN_TRIES_ACCOUNT sets it: change it there.",
    ]);
    expect((await consoleSettings(test).values()).sessionIdleDays).toBe(30);
  });

  it("are written where every node reads them when the environment pins them", async () => {
    const test = await start({ env: { NETHER_SESSION_IDLE_DAYS: "7" } });
    expect((await consoleSettings(test).values()).sessionIdleDays).toBe(7);
  });
});

describe("sessions under the settings", () => {
  const me = (test: TestServer, token: string) =>
    test.server.inject({ method: "GET", url: "/api/me", headers: bearer(token) });

  /** Makes a session look last used, and begun, so long ago. */
  async function age(test: TestServer, token: string, used: string, began: string) {
    await test.db.query(
      `UPDATE sessions SET used_at = now() - $2::interval, created_at = now() - $3::interval
        WHERE token_hash = $1`,
      [tokenHash(token), used, began],
    );
  }

  async function session(test: TestServer) {
    return (await signIn(test.server, admin.email, admin.password)).json<{ token: string }>().token;
  }

  it("end by the lengths set now, sooner or later than when they began", async () => {
    const test = await start();
    const unused = await session(test);
    const old = await session(test);
    await age(test, unused, "8 days", "8 days");
    await age(test, old, "1 minute", "100 days");
    expect((await me(test, unused)).statusCode).toBe(200);
    expect((await me(test, old)).statusCode).toBe(401);

    await consoleSettings(test).set({ sessionIdleDays: 7, sessionLifetimeDays: 120 });
    // Using it marked it used: unused for eight days again.
    await age(test, unused, "8 days", "8 days");
    // Shorter ends one at once; longer keeps one going that had ended.
    expect((await me(test, unused)).statusCode).toBe(401);
    expect((await me(test, old)).statusCode).toBe(200);
  });

  it("are given the lifetime set now as their end when they begin", async () => {
    const test = await start();
    await consoleSettings(test).set({ sessionLifetimeDays: 2 });
    const signedIn = await signIn(test.server, admin.email, admin.password);
    const ends = Date.parse(signedIn.json<{ expiresAt: string }>().expiresAt);
    expect(Math.abs(ends - (Date.now() + 2 * 86_400_000))).toBeLessThan(60_000);
  });
});

describe("signing in under the settings", () => {
  it("allows the tries per account set", async () => {
    const test = await start();
    await consoleSettings(test).set({ signInTriesAccount: 3 });
    const tries = [];
    for (let at = 0; at < 4; at++) {
      tries.push((await signIn(test.server, admin.email, "a wrong password")).statusCode);
    }
    expect(tries).toEqual([401, 401, 401, 429]);
  });

  it("offers no email code while codes are off", async () => {
    const test = await start({ mailer: new TestMailer() });
    await consoleSettings(test).set({ emailCodes: false });
    const methods = await test.server.inject({ method: "GET", url: "/api/sign-in-methods" });
    expect(methods.json()).toMatchObject({ password: true, emailCode: false });
    const asked = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes",
      payload: { email: admin.email },
    });
    expect(asked.statusCode).toBe(404);
    const redeemed = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes/redeem",
      payload: { email: admin.email, code: "1234 5678" },
    });
    expect(redeemed.statusCode).toBe(404);
  });
});
