// Deactivated accounts (ADR 0085): every way in refuses one, as that way
// answers; its sessions, codes and tokens end with it, and one started as
// it is deactivated ends at its next request; it keeps its places, does
// not count as an owner, waits for no key and gets no mail; the server's
// last active instance admin is never deactivated; its open connections
// close, and its apps are refused when they connect again; and
// reactivating brings it back as it was.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AccountChanger,
  deactivateAccount,
  deactivatedMessage,
  lastInstanceAdmin,
  reactivateAccount,
} from "../src/accounts.ts";
import type { EnterpriseModule, EnterpriseServices } from "../src/enterprise.ts";
import { type ServerEvent, fromServer } from "../src/events.ts";
import { pkceChallenge } from "../src/oidc.ts";
import { newToken, tokenHash } from "../src/sessions.ts";
import {
  type SetUp,
  type TestServer,
  TestMailer,
  admin,
  bearer,
  setUp,
  signIn,
  startServer,
} from "./app.ts";
import { freePort } from "./ports.ts";
import { type TestProvider, startProvider } from "./provider.ts";

const publicUrl = "https://nether.example.org";
const app = "http://127.0.0.1:43123/signed-in";

type Test = TestServer &
  SetUp & {
    readonly mailer: TestMailer;
    readonly services: EnterpriseServices;
    /** What the server told of, in order. */
    readonly told: ServerEvent[];
  };

let running: TestServer | undefined;
let provider: TestProvider | undefined;
const syncing: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const each of syncing.splice(0)) each.destroy();
  await running?.close();
  await provider?.close();
  running = undefined;
  provider = undefined;
});

/** As a directory acts: by its ID and name, from no request of an account's. */
const directory: AccountChanger = {
  actor: { kind: "directory", id: "okta", name: "Okta" },
  origin: fromServer,
};

async function start(env: Record<string, string> = {}): Promise<Test> {
  let services: EnterpriseServices | undefined;
  // What a module is given, as the scim module will be.
  const capture: EnterpriseModule = {
    feature: "scim",
    plugin: (_app, context) => {
      services = context;
      return Promise.resolve();
    },
  };
  const mailer = new TestMailer();
  running = await startServer({ mailer, env, enterpriseModules: [capture] });
  if (services === undefined) throw new Error("The module was not registered.");
  const told: ServerEvent[] = [];
  services.events.listen((event) => {
    told.push(event);
    return Promise.resolve();
  });
  return { ...running, ...(await setUp(running)), mailer, services, told };
}

/** Someone invited at a role, with their own new account and password. */
async function join(test: Test, name: string, role: "admin" | "member" = "member") {
  const invited = await test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/invitations`,
    headers: bearer(test.token),
    payload: { role },
  });
  const email = `${name.toLowerCase()}@example.org`;
  const password = `${name}'s long password`;
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: { token: invited.json<{ token: string }>().token, name, email, password },
  });
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { token: body.token, id: body.user.id, email, password };
}

function deactivate(test: Test, user: string) {
  return test.db.transaction((tx) => deactivateAccount(tx, user, directory, test.services.events));
}

function reactivate(test: Test, user: string) {
  return test.db.transaction((tx) => reactivateAccount(tx, user, directory, test.services.events));
}

function me(test: Test, token: string) {
  return test.server.inject({ method: "GET", url: "/api/me", headers: bearer(token) });
}

function members(test: Test, token = test.token) {
  return test.server.inject({
    method: "GET",
    url: `/api/workspaces/${test.workspaceId}/members`,
    headers: bearer(token),
  });
}

function setRole(test: Test, token: string, user: string, role: string) {
  return test.server.inject({
    method: "PATCH",
    url: `/api/workspaces/${test.workspaceId}/members/${user}`,
    headers: bearer(token),
    payload: { role },
  });
}

function failures(test: Test) {
  return test.told
    .filter((event) => event.action === "session.signed_in" && event.outcome === "failure")
    .map((event) => ({ reason: event.reason, actor: event.actor, details: event.details }));
}

describe("a deactivated account", () => {
  it("signs in no way, each answering as it would, and is told of as refused", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(bea.token),
      payload: { name: "Script", access: "read", password: bea.password },
    });
    expect(made.statusCode, made.body).toBe(201);
    const apiToken = made.json<{ token: string }>().token;
    expect(
      (await test.server.inject({ method: "GET", url: "/api/v1/me", headers: bearer(apiToken) }))
        .statusCode,
    ).toBe(200);

    expect(await deactivate(test, bea.id)).toBe("changed");
    expect(await deactivate(test, bea.id)).toBe("same");

    // Its session and its token end at once.
    expect((await me(test, bea.token)).statusCode).toBe(401);
    const api = await test.server.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: bearer(apiToken),
    });
    expect(api.statusCode).toBe(401);

    // Its password answers as a wrong one does.
    const right = await signIn(test.server, bea.email, bea.password);
    const wrong = await signIn(test.server, bea.email, "not Bea's password");
    expect(right.statusCode).toBe(401);
    expect(right.json()).toEqual(wrong.json());
    expect(failures(test)).toEqual([
      {
        reason: "deactivated",
        actor: { kind: "account", id: bea.id },
        details: { method: "password" },
      },
      {
        reason: "wrong password",
        actor: { kind: "account", id: bea.id },
        details: { method: "password" },
      },
    ]);
  });

  it("is sent no code, with the answer every address gets, and a code it had signs nothing in", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    await deactivate(test, bea.id);
    const ask = (email: string) =>
      test.server.inject({ method: "POST", url: "/api/sign-in-codes", payload: { email } });
    const asked = await ask(bea.email);
    const nobody = await ask("nobody@example.org");
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toEqual(nobody.json());
    // Ada's comes, and Bea's, asked first, never does.
    expect((await ask(admin.email)).statusCode).toBe(202);
    expect((await test.mailer.next()).to).toBe(admin.email);
    expect(test.mailer.sent.map((message) => message.to)).toEqual([admin.email]);

    // A code made as it was deactivated starts no session.
    const digits = "12345678";
    await test.db.query(
      `INSERT INTO sign_in_codes (id, user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 minutes')`,
      [randomUUID(), bea.id, createHash("sha256").update(digits).digest("hex")],
    );
    const redeemed = await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes/redeem",
      payload: { email: bea.email, code: digits },
    });
    expect(redeemed.statusCode).toBe(401);
    expect(redeemed.json<{ message: string }>().message).toBe(
      "That code is not this address's, or has been used or has expired.",
    );
    expect(failures(test)).toEqual([
      {
        reason: "deactivated",
        actor: { kind: "account", id: bea.id },
        details: { method: "code" },
      },
    ]);
    const sessions = await test.db.query("SELECT 1 FROM sessions WHERE user_id = $1", [bea.id]);
    expect(sessions.rows).toEqual([]);
  });

  it("is told it is deactivated by a provider's sign-in, and accepts no invitation through it", async () => {
    const idp = await startProvider();
    provider = idp;
    const test = await start({
      NETHER_PUBLIC_URL: publicUrl,
      NETHER_OIDC_ISSUER: idp.issuer,
      NETHER_OIDC_CLIENT_ID: idp.clientId,
      NETHER_OIDC_CLIENT_SECRET: idp.clientSecret,
    });
    const bea = await join(test, "Bea");
    const signInThrough = async (invitation?: string) => {
      const verifier = randomBytes(32).toString("base64url");
      const started = await test.server.inject({
        method: "POST",
        url: "/api/oidc/flows",
        payload: {
          redirect: app,
          challenge: pkceChallenge(verifier),
          ...(invitation === undefined ? {} : { invitation }),
        },
      });
      const callback = new URL(idp.authorize(started.json<{ url: string }>().url));
      const answered = await test.server.inject({
        method: "GET",
        url: callback.pathname + callback.search,
      });
      const code = new URL(String(answered.headers.location)).searchParams.get("code") ?? "";
      return test.server.inject({
        method: "POST",
        url: "/api/oidc/redeem",
        payload: { code, verifier },
      });
    };
    idp.person = { sub: "bea-1", email: bea.email, email_verified: true, name: "Bea" };
    expect((await signInThrough()).statusCode).toBe(201);

    await deactivate(test, bea.id);
    const refused = await signInThrough();
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ message: string }>().message).toBe(deactivatedMessage);

    // An invitation to another workspace stays open, its place not taken.
    const other = await test.server.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(test.token),
      payload: { name: "Other" },
    });
    const workspace = other.json<{ id: string }>().id;
    const invited = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/invitations`,
      headers: bearer(test.token),
      payload: { role: "member" },
    });
    const invitation = invited.json<{ token: string }>().token;
    expect((await signInThrough(invitation)).statusCode).toBe(403);
    const places = await test.db.query("SELECT 1 FROM memberships WHERE workspace_id = $1", [
      workspace,
    ]);
    expect(places.rows).toHaveLength(1);
    const open = await test.db.query("SELECT accepted_at FROM invitations WHERE token_hash = $1", [
      tokenHash(invitation),
    ]);
    expect(open.rows).toEqual([{ accepted_at: null }]);
    expect(failures(test)).toEqual([
      {
        reason: "deactivated",
        actor: { kind: "account", id: bea.id },
        details: { method: "oidc" },
      },
      {
        reason: "deactivated",
        actor: { kind: "account", id: bea.id },
        details: { method: "oidc" },
      },
    ]);
  });

  it("loses its sessions, codes and tokens, keeps its places, and comes back as it was", async () => {
    const test = await start();
    const bea = await join(test, "Bea", "admin");
    const made = await test.server.inject({
      method: "POST",
      url: "/api/tokens",
      headers: bearer(bea.token),
      payload: { name: "Script", access: "read", password: bea.password },
    });
    const tokenId = made.json<{ id: string }>().id;
    await test.server.inject({
      method: "POST",
      url: "/api/sign-in-codes",
      payload: { email: bea.email },
    });
    const teamspace = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/teamspaces`,
      headers: bearer(test.token),
      payload: { name: "Design" },
    });
    const unit = teamspace.json<{ id: string }>().id;
    await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/units/${unit}/grants/${bea.id}`,
      headers: bearer(test.token),
      payload: { level: "edit" },
    });
    await test.db.query(
      "INSERT INTO workspace_keys (workspace_id, user_id, version, sealed_key) VALUES ($1, $2, 1, $3)",
      [test.workspaceId, bea.id, new Uint8Array([1])],
    );
    const held = async () => ({
      sessions: (await test.db.query("SELECT 1 FROM sessions WHERE user_id = $1", [bea.id])).rows
        .length,
      codes: (await test.db.query("SELECT 1 FROM sign_in_codes WHERE user_id = $1", [bea.id])).rows
        .length,
      tokens: (await test.db.query("SELECT 1 FROM api_tokens WHERE user_id = $1", [bea.id])).rows
        .length,
      places: (
        await test.db.query("SELECT role FROM memberships WHERE user_id = $1", [bea.id])
      ).rows.map((row) => row.role as string),
      keys: (await test.db.query("SELECT 1 FROM workspace_keys WHERE user_id = $1", [bea.id])).rows
        .length,
      grants: (
        await test.db.query("SELECT level FROM unit_grants WHERE user_id = $1", [bea.id])
      ).rows.map((row) => row.level as string),
    });
    // The code is made after the answer: wait until it is there.
    await test.mailer.next();
    expect(await held()).toEqual({
      sessions: 1,
      codes: 1,
      tokens: 1,
      places: ["admin"],
      keys: 1,
      grants: ["edit"],
    });

    test.told.length = 0;
    expect(await deactivate(test, bea.id)).toBe("changed");
    expect(await held()).toEqual({
      sessions: 0,
      codes: 0,
      tokens: 0,
      places: ["admin"],
      keys: 1,
      grants: ["edit"],
    });
    expect(test.told).toEqual([
      {
        action: "account.deactivated",
        actor: { kind: "directory", id: "okta", name: "Okta" },
        target: { type: "account", id: bea.id },
        details: { sessions: 1, tokens: [tokenId] },
      },
    ]);
    const listed = members(test);
    expect(
      (await listed)
        .json<{ members: { name: string; deactivated: boolean }[] }>()
        .members.map(({ name, deactivated }) => [name, deactivated]),
    ).toEqual([
      ["Ada", false],
      ["Bea", true],
    ]);

    expect(await reactivate(test, bea.id)).toBe("changed");
    expect(await reactivate(test, bea.id)).toBe("same");
    expect(test.told.at(-1)).toEqual({
      action: "account.reactivated",
      actor: { kind: "directory", id: "okta", name: "Okta" },
      target: { type: "account", id: bea.id },
    });
    const back = await signIn(test.server, bea.email, bea.password);
    expect(back.statusCode).toBe(201);
    const workspaces = await me(test, back.json<{ token: string }>().token);
    expect(workspaces.json()).toMatchObject({
      workspaces: [{ id: test.workspaceId, role: "admin" }],
    });
    expect((await held()).places).toEqual(["admin"]);
    expect(await deactivate(test, randomUUID())).toEqual([404, "There is no such account."]);
  });

  it("ends a session started as it was deactivated at its next request", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    await deactivate(test, bea.id);
    // As a sign-in that read the account a moment before would leave one.
    const token = newToken();
    await test.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), bea.id, tokenHash(token)],
    );
    expect((await me(test, token)).statusCode).toBe(401);
    expect((await members(test, token)).statusCode).toBe(401);
  });

  it("never leaves the server without an active instance admin", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    expect(await deactivate(test, test.userId)).toEqual([403, lastInstanceAdmin]);
    expect((await me(test, test.token)).statusCode).toBe(200);
    // Nothing makes a second instance admin yet: as the console one day may.
    await test.db.query("UPDATE users SET instance_admin = true WHERE id = $1", [bea.id]);
    expect(await deactivate(test, test.userId)).toBe("changed");
    expect(await deactivate(test, bea.id)).toEqual([403, lastInstanceAdmin]);
    expect(await reactivate(test, test.userId)).toBe("changed");
    expect(await deactivate(test, bea.id)).toBe("changed");
  });

  it("does not count as an owner, waits for no key, and gets no mail", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    const cal = await join(test, "Cal");
    expect((await setRole(test, test.token, bea.id, "owner")).statusCode).toBe(200);
    await deactivate(test, bea.id);

    // Ada is the last active owner: she stays one, with only Bea beside her.
    const stepDown = await setRole(test, test.token, test.userId, "admin");
    expect(stepDown.statusCode).toBe(409);
    expect(stepDown.json<{ message: string }>().message).toBe(
      "A workspace keeps at least one active owner: make another member an owner first.",
    );
    const leave = await test.server.inject({
      method: "DELETE",
      url: `/api/workspaces/${test.workspaceId}/members/${test.userId}`,
      headers: bearer(test.token),
    });
    expect(leave.statusCode).toBe(409);
    // Bea, deactivated, may be made a member; Cal, made an owner, lets Ada step down.
    expect((await setRole(test, test.token, bea.id, "member")).statusCode).toBe(200);
    expect((await setRole(test, test.token, cal.id, "owner")).statusCode).toBe(200);
    expect((await setRole(test, test.token, test.userId, "admin")).statusCode).toBe(200);

    // An encrypted workspace: Bea and Cal have public keys and no copy.
    const sealed = randomUUID();
    await test.db.query(
      "INSERT INTO workspaces (id, name, encryption) VALUES ($1, 'Sealed', 'end-to-end')",
      [sealed],
    );
    for (const [user, role] of [
      [test.userId, "owner"],
      [bea.id, "member"],
      [cal.id, "member"],
    ] as const) {
      await test.db.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [sealed, user, role],
      );
    }
    for (const user of [bea.id, cal.id]) {
      await test.db.query(
        "INSERT INTO user_keys (user_id, public_key, recovery_box) VALUES ($1, $2, $3)",
        [user, new Uint8Array(32).fill(1), new Uint8Array([1])],
      );
    }
    await test.db.query(
      "INSERT INTO workspace_keys (workspace_id, user_id, version, sealed_key) VALUES ($1, $2, 1, $3)",
      [sealed, test.userId, new Uint8Array([1])],
    );
    const keyless = await test.server.inject({
      method: "GET",
      url: `/api/workspaces/${sealed}/keyless`,
      headers: bearer(test.token),
    });
    expect(keyless.json<{ members: { name: string }[] }>().members.map(({ name }) => name)).toEqual(
      ["Cal"],
    );

    // Mentioned, Bea is told in the app, and only Cal by email.
    const mentioned = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/notifications`,
      headers: bearer(test.token),
      payload: { kind: "mention", note: randomUUID(), people: [bea.id, cal.id] },
    });
    expect(mentioned.json<{ notified: string[] }>().notified.sort()).toEqual(
      [bea.id, cal.id].sort(),
    );
    expect(test.mailer.sent.map((message) => message.to)).toEqual(["cal@example.org"]);
  });

  it("has its sync and relay connections closed, and its apps refused when they connect again", async () => {
    const test = await start();
    const bea = await join(test, "Bea");
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const port = String((test.server.server.address() as AddressInfo).port);

    let refused: string | undefined;
    let closes = 0;
    await new Promise<void>((resolve, reject) => {
      const sync = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/api/sync`,
        name: `${test.workspaceId}/vault`,
        token: bea.token,
        document: new Y.Doc(),
        onSynced: () => {
          resolve();
        },
        onClose: () => {
          closes += 1;
        },
        onAuthenticationFailed: ({ reason }) => {
          refused = reason;
          reject(new Error(reason));
        },
      });
      syncing.push(sync);
    });
    const relay = new WebSocket(`ws://127.0.0.1:${port}/api/relay`);
    await new Promise<void>((resolve) => {
      relay.addEventListener("open", () => {
        relay.send(JSON.stringify({ type: "auth", token: bea.token }));
      });
      relay.addEventListener("message", () => {
        resolve();
      });
    });
    const relayClosed = new Promise<number>((resolve) => {
      relay.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });

    // As the scim module will: its sessions and tokens end with the change, then its connections.
    expect(await deactivate(test, bea.id)).toBe("changed");
    test.services.disconnect(bea.id);
    expect(await relayClosed).toBeGreaterThanOrEqual(4000);
    // The provider connects again, and is refused.
    const deadline = Date.now() + 10_000;
    while (refused === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(closes).toBeGreaterThan(0);
    expect(refused).toBeDefined();
  });
});
