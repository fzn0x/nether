// Talking to a Nether server: addresses as people type them, answers and
// failures, first-run setup, and signing in with a provider through a
// loopback address.
import { describe, expect, it } from "vitest";
import {
  type LoopbackWait,
  ServerError,
  account,
  findProvider,
  invitationLink,
  pkce,
  readInvitationLink,
  request,
  serverAddress,
  setUpServer,
  setWorkspaceAi,
  setupNeeded,
  signInMethods,
  signInWithProvider,
  ssoProviders,
} from "../src/server.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A fetch that answers from a table of routes, and keeps what it was sent. */
function fakeFetch(routes: Readonly<Record<string, (sent: Sent) => Response>>) {
  const sent: Sent[] = [];
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request: Sent = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    sent.push(request);
    const route = routes[`${request.method} ${new URL(url).pathname}`];
    return route === undefined
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve(route(request));
  };
  return { fetcher, sent };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = "https://nether.example.org";
const user = { id: "u1", name: "Ada", email: "ada@example.org", instanceAdmin: true };

describe("serverAddress", () => {
  it.each([
    ["nether.example.org", "https://nether.example.org"],
    ["  Nether.Example.org/ ", "https://nether.example.org"],
    ["http://10.0.0.2:3000", "http://10.0.0.2:3000"],
    ["https://nether.example.org:8443/", "https://nether.example.org:8443"],
  ])("reads %j as %j", (typed, address) => {
    expect(serverAddress(typed)).toBe(address);
  });

  it.each([
    "",
    "   ",
    "ftp://nether.example.org",
    "https://nether.example.org/app",
    "https://a:b@x.org",
    "https://x.org/?a=1",
    "not an address at all",
  ])("refuses %j", (typed) => {
    expect(serverAddress(typed)).toBeUndefined();
  });
});

describe("invitation links", () => {
  it("carry the server's address and the token after a #, and are read back", () => {
    const link = invitationLink("https://nether.example.org", "a-token");
    expect(link).toBe("https://nether.example.org/invite#a-token");
    expect(readInvitationLink(` ${link} `)).toEqual({
      server: "https://nether.example.org",
      token: "a-token",
    });
    expect(readInvitationLink("http://localhost:3000/invite/#t")).toEqual({
      server: "http://localhost:3000",
      token: "t",
    });
    for (const text of [
      "a-token",
      "https://nether.example.org/invite",
      "https://nether.example.org/invite#",
      "https://nether.example.org/join#a-token",
      "https://user:pass@nether.example.org/invite#a-token",
      "ftp://nether.example.org/invite#a-token",
    ]) {
      expect(readInvitationLink(text), text).toBeUndefined();
    }
  });
});

describe("request", () => {
  it("sends JSON with the session's token, and gives the server's message on failure", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/things": () => json(403, { statusCode: 403, message: "Not yours." }),
      "DELETE /api/things": () => new Response(null, { status: 204 }),
    });
    const failure = request(fetcher, base, "/api/things", { body: { a: 1 }, token: "t0k" });
    await expect(failure).rejects.toThrow(new ServerError(403, "Not yours."));
    expect(sent[0]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer t0k", "content-type": "application/json" },
      body: { a: 1 },
    });
    await expect(
      request(fetcher, base, "/api/things", { method: "DELETE", token: "t0k" }),
    ).resolves.toBeUndefined();
  });

  it("says when a server cannot be reached, or does not answer as Nether", async () => {
    const { fetcher } = fakeFetch({
      "GET /api/sign-in-methods": () => json(200, { hello: "world" }),
    });
    await expect(request(fetcher, base, "/api/elsewhere")).rejects.toThrow(
      "https://nether.example.org cannot be reached: fetch failed",
    );
    await expect(signInMethods(fetcher, base)).rejects.toThrow(
      "https://nether.example.org does not answer as a Nether server.",
    );
  });

  it("reads the account and its workspaces, and refuses an answer it cannot read", async () => {
    const { fetcher } = fakeFetch({
      "GET /api/me": () =>
        json(200, {
          user,
          workspaces: [
            { id: "w1", name: "Team", role: "owner", encryption: "none" },
            { id: "w2", name: "Secret", role: "member", encryption: "end-to-end", ai: false },
          ],
        }),
    });
    // A server from before AI's switch says nothing of it: AI is on there,
    // and one from before the lock locks nothing (ADR 0086).
    await expect(account(fetcher, base, "t0k")).resolves.toEqual({
      user,
      workspaces: [
        { id: "w1", name: "Team", role: "owner", encrypted: false, ai: true },
        { id: "w2", name: "Secret", role: "member", encrypted: true, ai: false },
      ],
      aiEndpoints: null,
    });
    const locked = fakeFetch({
      "GET /api/me": () =>
        json(200, { user, workspaces: [], aiEndpoints: ["https://llm.corp.example/v1"] }),
    });
    await expect(account(locked.fetcher, base, "t0k")).resolves.toMatchObject({
      aiEndpoints: ["https://llm.corp.example/v1"],
    });
    const odd = fakeFetch({ "GET /api/me": () => json(200, { user: { id: 7 } }) });
    await expect(account(odd.fetcher, base, "t0k")).rejects.toThrow(
      "https://nether.example.org gave an answer Nether cannot read.",
    );
  });
});

describe("a workspace's AI switch", () => {
  it("is turned off and on by a request its owners and admins may make", async () => {
    const { fetcher, sent } = fakeFetch({
      "PATCH /api/workspaces/w1": (request) => json(200, { id: "w1", ...(request.body as object) }),
    });
    await setWorkspaceAi(fetcher, base, "t0k", "w1", false);
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      url: `${base}/api/workspaces/w1`,
      headers: { authorization: "Bearer t0k" },
      body: { ai: false },
    });
    const refused = fakeFetch({
      "PATCH /api/workspaces/w1": () =>
        json(403, { message: "Only the workspace's owners and admins change its settings." }),
    });
    await expect(setWorkspaceAi(refused.fetcher, base, "t0k", "w1", true)).rejects.toThrow(
      "Only the workspace's owners and admins change its settings.",
    );
  });
});

describe("first-run setup", () => {
  const base = "https://nether.example.org";
  const user = { id: "u1", name: "Ada", email: "ada@example.org", instanceAdmin: true };
  const setup = {
    code: "ABCDE-FGHJK-LMNPQ-RSTUV",
    name: "Ada",
    email: "ada@example.org",
    password: "a long password",
    workspace: "Team",
  };

  it("asks whether the server waits to be set up", async () => {
    const waiting = fakeFetch({ "GET /api/setup": () => json(200, { needed: true }) });
    expect(await setupNeeded(waiting.fetcher, base)).toBe(true);
    const done = fakeFetch({ "GET /api/setup": () => json(200, { needed: false }) });
    expect(await setupNeeded(done.fetcher, base)).toBe(false);
  });

  it("sends the code and the admin's account, trimmed but the password, and signs in", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/setup": () =>
        json(201, { token: "t0k", expiresAt: "2027-02-13T00:00:00.000Z", user, workspace: {} }),
    });
    const signedIn = await setUpServer(fetcher, base, {
      code: " ABCDE-FGHJK-LMNPQ-RSTUV ",
      name: " Ada ",
      email: " ada@example.org ",
      password: " a long password ",
      workspace: " Team ",
    });
    expect(signedIn).toEqual({ token: "t0k", user });
    expect(sent[0]?.body).toEqual({ ...setup, password: " a long password " });
  });

  it("signs the web app in with its cookie, the answer holding no token", async () => {
    const { fetcher } = fakeFetch({
      "POST /api/setup": () =>
        json(201, { expiresAt: "2027-02-13T00:00:00.000Z", user, workspace: {} }),
    });
    expect(await setUpServer(fetcher, base, setup)).toEqual({ token: "", user });
  });

  it("says why a wrong code is refused, in the server's words", async () => {
    const refusal = "That is not the setup code the server wrote to its log.";
    const { fetcher } = fakeFetch({
      "POST /api/setup": () => json(403, { message: refusal }),
    });
    await expect(setUpServer(fetcher, base, { ...setup, code: "WRONG" })).rejects.toThrow(refusal);
  });
});

describe("signing in with a provider", () => {
  function loopback(query: Record<string, string>): LoopbackWait & { closed: boolean } {
    const wait = {
      redirect: "http://127.0.0.1:43123/secret",
      closed: false,
      wait: () => Promise.resolve(query),
      close() {
        wait.closed = true;
        return Promise.resolve();
      },
    };
    return wait;
  }

  it("opens the provider, and redeems the code with the verifier of its challenge", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/oidc/flows": () => json(201, { url: "https://login.example.org/authorize?x=1" }),
      "POST /api/oidc/redeem": () => json(201, { token: "session", expiresAt: "", user }),
    });
    const opened: string[] = [];
    const wait = loopback({ code: "handoff" });
    const signedIn = await signInWithProvider(fetcher, base, wait, (url) => {
      opened.push(url);
      return Promise.resolve();
    });
    expect(signedIn).toEqual({ token: "session", user });
    expect(opened).toEqual(["https://login.example.org/authorize?x=1"]);
    const flow = sent[0]?.body as { redirect: string; challenge: string };
    const redeem = sent[1]?.body as { code: string; verifier: string };
    expect(flow.redirect).toBe("http://127.0.0.1:43123/secret");
    expect(redeem.code).toBe("handoff");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(redeem.verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(flow.challenge).toBe(challenge);
    expect(wait.closed).toBe(true);
  });

  it("says why the provider's sign-in failed, and stops waiting", async () => {
    const { fetcher } = fakeFetch({
      "POST /api/oidc/flows": () => json(201, { url: "https://login.example.org/authorize" }),
    });
    const wait = loopback({ error: "no_account" });
    await expect(signInWithProvider(fetcher, base, wait, () => Promise.resolve())).rejects.toThrow(
      "this server has no account for you",
    );
    expect(wait.closed).toBe(true);
    const odd = loopback({ error: "teapot" });
    await expect(signInWithProvider(fetcher, base, odd, () => Promise.resolve())).rejects.toThrow(
      "Signing in failed: teapot.",
    );
  });

  it("signs in through a console's provider by its short name", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/sso/corp/flows": () =>
        json(201, { url: "https://idp.example.org/sso?SAMLRequest=x" }),
      "POST /api/sso/redeem": () => json(201, { token: "session", expiresAt: "", user }),
    });
    const signedIn = await signInWithProvider(
      fetcher,
      base,
      loopback({ code: "handoff" }),
      () => Promise.resolve(),
      "corp",
    );
    expect(signedIn).toEqual({ token: "session", user });
    expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/sso/corp/flows",
      "/api/sso/redeem",
    ]);
    const odd = loopback({ error: "no_address" });
    await expect(
      signInWithProvider(fetcher, base, odd, () => Promise.resolve(), "corp"),
    ).rejects.toThrow("The provider gave no email address");
  });

  it("lists a server's single sign-on providers, and none when it has none to give", async () => {
    const methods = { password: true, emailCode: false, oidc: null };
    const on = fakeFetch({
      "GET /api/sign-in-methods": () => json(200, methods),
      "GET /api/sso": () =>
        json(200, { providers: [{ id: "corp", name: "Corp SSO" }, { id: 7 }], everyone: true }),
    });
    expect(await signInMethods(on.fetcher, base)).toEqual({
      ...methods,
      sso: [{ id: "corp", name: "Corp SSO" }],
      ssoEveryone: true,
    });
    const off = fakeFetch({
      "GET /api/sign-in-methods": () => json(200, methods),
      "GET /api/sso": () => json(404, { message: "Route GET:/api/sso not found" }),
    });
    expect(await signInMethods(off.fetcher, base)).toMatchObject({ sso: [], ssoEveryone: false });
    expect(await ssoProviders(fakeFetch({}).fetcher, base)).toEqual([]);
  });

  it("finds an address's provider, and none on a server without single sign-on", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/sso/find": () =>
        json(200, { provider: { id: "corp", name: "Corp SSO" }, required: true }),
    });
    expect(await findProvider(fetcher, base, " grace@corp.example ")).toEqual({
      provider: { id: "corp", name: "Corp SSO" },
      required: true,
    });
    expect(sent[0]?.body).toEqual({ email: "grace@corp.example" });
    const off = fakeFetch({
      "POST /api/sso/find": () => json(404, { message: "Route POST:/api/sso/find not found" }),
    });
    expect(await findProvider(off.fetcher, base, "ada@example.org")).toEqual({
      provider: undefined,
      required: false,
    });
  });

  it("keeps the provider a refusal names, and carries an invitation through a provider", async () => {
    const { fetcher, sent } = fakeFetch({
      "POST /api/sessions": () =>
        json(403, {
          statusCode: 403,
          message: "Addresses at corp.example sign in with Corp SSO.",
          sso: { id: "corp", name: "Corp SSO" },
        }),
      "POST /api/sso/corp/flows": () => json(201, { url: "https://idp.example.org/sso" }),
      "POST /api/sso/redeem": () => json(201, { token: "session", expiresAt: "", user }),
    });
    const refused = await request(fetcher, base, "/api/sessions", { body: {} }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ServerError);
    expect((refused as ServerError).sso).toEqual({ id: "corp", name: "Corp SSO" });
    await signInWithProvider(
      fetcher,
      base,
      loopback({ code: "handoff" }),
      () => Promise.resolve(),
      "corp",
      "invitation-token",
    );
    expect(sent[1]?.body).toMatchObject({ invitation: "invitation-token" });
    const sso = loopback({ error: "sso_required" });
    await expect(
      signInWithProvider(fetcher, base, sso, () => Promise.resolve(), "corp"),
    ).rejects.toThrow("This account signs in through another provider.");
  });

  it("makes a verifier of 43 characters, and a challenge from it", async () => {
    const first = await pkce();
    const second = await pkce();
    expect(first.verifier).toMatch(/^[\w-]{43}$/);
    expect(first.challenge).toMatch(/^[\w-]{43}$/);
    expect(second.verifier).not.toBe(first.verifier);
  });
});
