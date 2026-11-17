// Single sign-on (ADR 0080), through the server as the apps reach it: the
// console's providers, signing in through SAML and OpenID Connect, the
// account each finds or makes by the domains it is trusted for, and every
// answer a provider, or someone in its place, should not get through with.
import { randomBytes } from "node:crypto";
import { type TestServer, bearer, setUp, startServer } from "@nether/server/test/app.ts";
import { type TestProvider, startProvider } from "@nether/server/test/provider.ts";
import { pkceChallenge } from "@nether/server/src/oidc.ts";
import { afterEach, describe, expect, it } from "vitest";
import { ssoModule } from "../src/index.ts";
import { type Bend, type IdpPerson, TestIdp, emailFormat, transient } from "./idp.ts";

const publicUrl = "https://nether.example.org";
const app = "http://127.0.0.1:43123/signed-in";
const secretKey = Buffer.alloc(32, 7).toString("base64");

type Test = TestServer & { token: string; userId: string; workspaceId: string };
let running: Test | undefined;
let oidcProvider: TestProvider | undefined;

afterEach(async () => {
  await running?.close();
  await oidcProvider?.close();
  running = undefined;
  oidcProvider = undefined;
});

async function start(env: Record<string, string> = {}): Promise<Test> {
  const server = await startServer({
    env: {
      NETHER_PUBLIC_URL: publicUrl,
      NETHER_SECRET_KEY: secretKey,
      NETHER_SSO_PRIVATE: "loopback",
      NETHER_ENTERPRISE_SSO: "on",
      ...env,
    },
    enterpriseModules: [ssoModule],
  });
  running = { ...server, ...(await setUp(server)) };
  return running;
}

function admin(
  test: Test,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) {
  return test.server.inject({
    method,
    url,
    headers: bearer(test.token),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function addSaml(test: Test, idp: TestIdp, extra: object = {}) {
  const added = await admin(test, "POST", "/api/admin/sso/providers", {
    id: "corp",
    name: "Corp SSO",
    domains: ["corp.example"],
    saml: { metadataXml: idp.metadata() },
    ...extra,
  });
  expect(added.statusCode, added.body).toBe(201);
  return added.json<{
    saml: { nether: { entityId: string; acsUrl: string; certificate: string } };
  }>();
}

/** Starts a flow as the app does, and gives the provider's address and the verifier. */
async function startFlow(test: Test, id = "corp", invitation?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const started = await test.server.inject({
    method: "POST",
    url: `/api/sso/${id}/flows`,
    payload: {
      redirect: app,
      challenge: pkceChallenge(verifier),
      ...(invitation === undefined ? {} : { invitation }),
    },
  });
  expect(started.statusCode, started.body).toBe(201);
  return { url: started.json<{ url: string }>().url, verifier };
}

function post(test: Test, form: Record<string, string>, id = "corp") {
  return test.server.inject({
    method: "POST",
    url: `/api/sso/${id}/saml/acs`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
  });
}

function landed(answer: { statusCode: number; headers: Record<string, unknown>; body: string }) {
  expect(answer.statusCode, answer.body).toBe(302);
  return new URL(String(answer.headers.location));
}

function redeem(test: Test, code: string, verifier: string, cookie = false) {
  return test.server.inject({
    method: "POST",
    url: "/api/sso/redeem",
    headers: cookie ? { "x-nether-session": "cookie" } : {},
    payload: { code, verifier },
  });
}

const grace: IdpPerson = {
  nameId: "grace-1",
  attributes: { email: "grace@corp.example", displayName: "Grace Hopper" },
};

/** Signs in through SAML as `person`, bent as asked, and gives where the browser lands. */
async function samlSignIn(test: Test, idp: TestIdp, person: IdpPerson, bend: Bend = {}) {
  const { url, verifier } = await startFlow(test);
  const form = await idp.answer(url, person, bend);
  return { at: landed(await post(test, form)), verifier, form, url };
}

describe("single sign-on, off", () => {
  it("answers nothing while the feature is off", async () => {
    const test = await start({ NETHER_ENTERPRISE_SSO: "off" });
    expect((await test.server.inject({ method: "GET", url: "/api/sso" })).statusCode).toBe(404);
    expect((await admin(test, "GET", "/api/admin/sso")).statusCode).toBe(404);
  });
});

describe("the console's providers", () => {
  it("adds a SAML provider from its metadata, with Nether's addresses and certificate to give it", async () => {
    const test = await start();
    const idp = new TestIdp();
    const added = await addSaml(test, idp);
    expect(added).toMatchObject({
      id: "corp",
      kind: "saml",
      name: "Corp SSO",
      makeAccounts: true,
      domains: ["corp.example"],
      saml: {
        metadataUrl: null,
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        requireEncryption: false,
        nether: {
          entityId: `${publicUrl}/api/sso/corp/saml/metadata`,
          acsUrl: `${publicUrl}/api/sso/corp/saml/acs`,
          metadataUrl: `${publicUrl}/api/sso/corp/saml/metadata`,
        },
      },
    });
    expect(added.saml.nether.certificate).toContain("BEGIN CERTIFICATE");
    // Nether's metadata, for the provider: its addresses and its certificate, twice.
    const metadata = await test.server.inject({
      method: "GET",
      url: "/api/sso/corp/saml/metadata",
    });
    expect(metadata.headers["content-type"]).toContain("application/samlmetadata+xml");
    expect(metadata.body).toContain(`entityID="${publicUrl}/api/sso/corp/saml/metadata"`);
    expect(metadata.body).toContain(`Location="${publicUrl}/api/sso/corp/saml/acs"`);
    expect(metadata.body).toContain('use="signing"');
    expect(metadata.body).toContain('use="encryption"');
    // The apps' list.
    const listed = await test.server.inject({ method: "GET", url: "/api/sso" });
    expect(listed.json()).toEqual({ providers: [{ id: "corp", name: "Corp SSO" }] });
  });

  it("refuses what it cannot keep, saying why", async () => {
    const test = await start();
    const idp = new TestIdp();
    await addSaml(test, idp);
    const add = (payload: object) => admin(test, "POST", "/api/admin/sso/providers", payload);
    const saml = { saml: { metadataXml: new TestIdp("https://other.test").metadata() } };
    expect((await add({ id: "corp", name: "Again", ...saml })).json()).toMatchObject({
      message: "There is a provider named corp already.",
    });
    expect(
      (await add({ id: "other", name: "Other", domains: ["CORP.example"], ...saml })).json(),
    ).toMatchObject({ message: "corp.example is corp's already." });
    expect(
      (await add({ id: "other", name: "Other", domains: ["not a domain"], ...saml })).json(),
    ).toMatchObject({
      message: "not a domain is not an email domain.",
    });
    expect((await add({ id: "Other!", name: "Other", ...saml })).statusCode).toBe(400);
    expect((await add({ id: "other", name: "Other" })).json()).toMatchObject({
      message: "A provider is SAML or OpenID Connect: give one of the two.",
    });
    expect(
      (await add({ id: "other", name: "Other", saml: { metadataXml: "<nope/>" } })).json(),
    ).toMatchObject({ message: "The metadata describes no identity provider (IDPSSODescriptor)." });
    expect(
      (
        await add({
          id: "other",
          name: "Other",
          oidc: { issuer: "https://login.microsoftonline.com/common/v2.0", clientId: "x" },
        })
      ).json(),
    ).toMatchObject({ message: expect.stringContaining("signs in every tenant") as unknown });
    // A provider's metadata by an address on this machine needs NETHER_SSO_PRIVATE; here it is set.
    expect(
      (
        await add({ id: "other", name: "Other", saml: { metadataUrl: "http://127.0.0.1:1/" } })
      ).json(),
    ).toMatchObject({
      message: expect.stringContaining("could not be read from http://127.0.0.1:1/") as unknown,
    });
  });

  it("is the instance admins' alone", async () => {
    const test = await start();
    const invitation = await admin(
      test,
      "POST",
      `/api/workspaces/${test.workspaceId}/invitations`,
      {
        role: "admin",
      },
    );
    const accepted = await test.server.inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: {
        token: invitation.json<{ token: string }>().token,
        name: "Bea",
        email: "bea@example.org",
        password: "a long password",
      },
    });
    const token = accepted.json<{ token: string }>().token;
    const seen = await test.server.inject({
      method: "GET",
      url: "/api/admin/sso",
      headers: bearer(token),
    });
    expect(seen.statusCode).toBe(403);
  });

  it("needs the server's secret key and public address", async () => {
    const test = await start({ NETHER_SECRET_KEY: "" });
    const added = await admin(test, "POST", "/api/admin/sso/providers", {
      id: "corp",
      name: "Corp",
      saml: { metadataXml: new TestIdp().metadata() },
    });
    expect(added.statusCode).toBe(409);
    expect(added.json()).toMatchObject({
      message: expect.stringContaining("NETHER_SECRET_KEY") as unknown,
    });
    expect((await admin(test, "GET", "/api/admin/sso")).json()).toMatchObject({ secretKey: false });
  });

  it("changes a provider's name, domains and settings, keeps its key, and removes it", async () => {
    const test = await start();
    const idp = new TestIdp();
    const added = await addSaml(test, idp);
    const changed = await admin(test, "PUT", "/api/admin/sso/providers/corp", {
      name: "Corp",
      domains: ["corp.example", "corp.test"],
      makeAccounts: false,
      saml: { requireEncryption: true, subjectAttribute: "objectid" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      name: "Corp",
      domains: ["corp.example", "corp.test"],
      makeAccounts: false,
      saml: {
        requireEncryption: true,
        subjectAttribute: "objectid",
        nether: { certificate: added.saml.nether.certificate },
      },
    });
    expect(
      (
        await admin(test, "PUT", "/api/admin/sso/providers/corp", {
          oidc: { issuer: "https://x.test" },
        })
      ).json(),
    ).toMatchObject({ message: "A provider's kind does not change: add another." });
    expect((await admin(test, "DELETE", "/api/admin/sso/providers/corp")).statusCode).toBe(204);
    expect((await admin(test, "DELETE", "/api/admin/sso/providers/corp")).statusCode).toBe(404);
    expect((await test.server.inject({ method: "GET", url: "/api/sso" })).json()).toEqual({
      providers: [],
    });
  });
});

describe("signing in through SAML", () => {
  it("makes an account at the provider's domain, signs it in, and finds it again by its identity", async () => {
    const test = await start();
    const idp = new TestIdp();
    await addSaml(test, idp);
    const { url, verifier } = await startFlow(test);
    // A signed request, for Nether's address, carrying the flow's state.
    const asked = idp.asked(url);
    expect(url.startsWith(`${idp.ssoUrl}?`)).toBe(true);
    expect(asked).toMatchObject({
      issuer: `${publicUrl}/api/sso/corp/saml/metadata`,
      acsUrl: `${publicUrl}/api/sso/corp/saml/acs`,
      signed: true,
    });
    expect(asked.xml).not.toContain("RequestedAuthnContext");
    expect(asked.xml).not.toContain("NameIDPolicy Format");
    const form = await idp.answer(url, grace);
    const at = landed(await post(test, form));
    expect(at.origin + at.pathname).toBe(app);
    const code = at.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const session = await redeem(test, code, verifier);
    expect(session.statusCode, session.body).toBe(201);
    expect(session.json()).toMatchObject({
      token: expect.any(String) as unknown,
      user: { name: "Grace Hopper", email: "grace@corp.example", instanceAdmin: false },
    });
    // The code is spent.
    expect((await redeem(test, code, verifier)).statusCode).toBe(401);
    // The same answer again finds its sign-in gone.
    const again = await post(test, form);
    expect(again.statusCode).toBe(400);
    // Signing in again, with another address, finds the same account by its identity.
    const second = await samlSignIn(test, idp, {
      ...grace,
      attributes: { email: "grace.hopper@corp.example" },
    });
    const next = await redeem(test, second.at.searchParams.get("code") ?? "", second.verifier);
    expect(next.json()).toMatchObject({
      user: { id: session.json<{ user: { id: string } }>().user.id, email: "grace@corp.example" },
    });
  });

  it("puts the web app's session in its cookie", async () => {
    const test = await start();
    const idp = new TestIdp();
    await addSaml(test, idp);
    const { at, verifier } = await samlSignIn(test, idp, grace);
    const session = await redeem(test, at.searchParams.get("code") ?? "", verifier, true);
    expect(session.statusCode).toBe(201);
    expect(session.json()).not.toHaveProperty("token");
    expect(String(session.headers["set-cookie"])).toContain("nether_session=");
  });

  it("takes an assertion encrypted to Nether's certificate, and requires one when told", async () => {
    const test = await start();
    const idp = new TestIdp();
    const added = await addSaml(test, idp, {
      saml: { metadataXml: idp.metadata(), requireEncryption: true },
    });
    const plain = await samlSignIn(test, idp, grace);
    expect(plain.at.searchParams.get("error")).toBe("provider_error");
    const sealed = await samlSignIn(test, idp, grace, { encryptTo: added.saml.nether.certificate });
    expect(sealed.at.searchParams.get("code")).not.toBeNull();
  });

  it("refuses every answer it should not take", async () => {
    const test = await start();
    const idp = new TestIdp();
    await addSaml(test, idp);
    const refused = async (bend: Bend, person = grace) =>
      (await samlSignIn(test, idp, person, bend)).at.searchParams.get("error");
    // Unsigned, or signed by someone else.
    expect(await refused({ signAssertion: false })).toBe("provider_error");
    expect(await refused({ signAssertion: false, signResponse: true })).toBe("provider_error");
    const stranger = new TestIdp();
    const { url } = await startFlow(test);
    const forged = await stranger.answer(url, grace);
    expect(landed(await post(test, forged)).searchParams.get("error")).toBe("provider_error");
    // Not this request's answer, not for this address, not for Nether, not from the provider.
    expect(await refused({ requestId: "_another" })).toBe("provider_error");
    expect(await refused({ recipient: `${publicUrl}/api/sso/other/saml/acs` })).toBe(
      "provider_error",
    );
    expect(await refused({ audience: "https://elsewhere.example" })).toBe("provider_error");
    expect(await refused({ issuer: "https://idp.elsewhere.test" })).toBe("provider_error");
    // Expired beyond the clock's skew.
    expect(await refused({ minutes: -5 })).toBe("provider_error");
    // A second assertion wrapped in beside the signed one.
    const wrapped = await refused({
      after: (xml) =>
        xml.replace(
          "<samlp:Status>",
          `<saml:Assertion ID="_evil" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"><saml:Issuer>${idp.entityId}</saml:Issuer><saml:Subject><saml:NameID>evil</saml:NameID></saml:Subject></saml:Assertion><samlp:Status>`,
        ),
    });
    expect(wrapped).toBe("provider_error");
    // The signed assertion's person swapped after signing.
    expect(
      await refused({ after: (xml) => xml.replace("grace@corp.example", "admin@corp.example") }),
    ).toBe("provider_error");
    // A transient NameID names no one for long.
    expect(await refused({}, { ...grace, format: transient })).toBe("provider_error");
    // None of them made an account.
    const { rows } = await test.db.query("SELECT email FROM users ORDER BY email");
    expect(rows.map((row) => row.email)).toEqual(["Ada@Example.org"]);
  });

  it("links and makes accounts only at the provider's domains", async () => {
    const test = await start();
    const idp = new TestIdp();
    await addSaml(test, idp);
    // Outside its domains, SAML cannot say an address is verified.
    const outside = await samlSignIn(test, idp, {
      nameId: "ada-at-corp",
      attributes: { email: "ada@example.org" },
    });
    expect(outside.at.searchParams.get("error")).toBe("email_not_verified");
    // No address at all.
    expect((await samlSignIn(test, idp, { nameId: "nobody" })).at.searchParams.get("error")).toBe(
      "no_address",
    );
    // An address as the NameID, when that is all there is.
    const byNameId = await samlSignIn(test, idp, {
      nameId: "hal@corp.example",
      format: emailFormat,
    });
    expect(
      (await redeem(test, byNameId.at.searchParams.get("code") ?? "", byNameId.verifier)).json(),
    ).toMatchObject({ user: { email: "hal@corp.example", name: "hal" } });
    // Not making accounts: only those that exist, or come with an invitation.
    await admin(test, "PUT", "/api/admin/sso/providers/corp", { makeAccounts: false });
    expect((await samlSignIn(test, idp, grace)).at.searchParams.get("error")).toBe("no_account");
    const invitation = (
      await admin(test, "POST", `/api/workspaces/${test.workspaceId}/invitations`, {
        role: "member",
      })
    ).json<{ token: string }>().token;
    const invited = await startFlow(test, "corp", invitation);
    const form = await idp.answer(invited.url, grace);
    const at = landed(await post(test, form));
    expect(
      (await redeem(test, at.searchParams.get("code") ?? "", invited.verifier)).json(),
    ).toMatchObject({
      user: { email: "grace@corp.example" },
      workspace: { id: test.workspaceId, role: "member" },
    });
  });

  it("reads names from the attributes Entra ID sends", async () => {
    const test = await start();
    const idp = new TestIdp("https://sts.windows.net/00000000-0000-0000-0000-000000000001/");
    await addSaml(test, idp, {
      saml: {
        metadataXml: idp.metadata(),
        subjectAttribute: "http://schemas.microsoft.com/identity/claims/objectidentifier",
      },
    });
    const entra: IdpPerson = {
      nameId: "grace@corp.example",
      format: emailFormat,
      attributes: {
        "http://schemas.microsoft.com/identity/claims/objectidentifier": "8f0c-object",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "grace@corp.example",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname": "Grace",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname": "Hopper",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name": "grace@corp.example",
      },
    };
    const { at, verifier } = await samlSignIn(test, idp, entra);
    expect((await redeem(test, at.searchParams.get("code") ?? "", verifier)).json()).toMatchObject({
      user: { name: "Grace Hopper", email: "grace@corp.example" },
    });
    const { rows } = await test.db.query("SELECT issuer, subject FROM identities");
    expect(rows).toEqual([{ issuer: idp.entityId, subject: "8f0c-object" }]);
  });
});

describe("signing in through OpenID Connect", () => {
  async function addOidc(test: Test) {
    oidcProvider = await startProvider();
    const added = await admin(test, "POST", "/api/admin/sso/providers", {
      id: "okta",
      name: "Okta",
      domains: ["corp.example"],
      oidc: {
        issuer: oidcProvider.issuer,
        clientId: oidcProvider.clientId,
        clientSecret: oidcProvider.clientSecret,
      },
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({
      kind: "oidc",
      oidc: { secret: true, callbackUrl: `${publicUrl}/api/sso/okta/oidc/callback` },
    });
    return oidcProvider;
  }

  async function oidcSignIn(test: Test, provider: TestProvider) {
    const { url, verifier } = await startFlow(test, "okta");
    const callback = new URL(provider.authorize(url));
    expect(callback.origin + callback.pathname).toBe(`${publicUrl}/api/sso/okta/oidc/callback`);
    const answered = await test.server.inject({
      method: "GET",
      url: callback.pathname + callback.search,
    });
    return { at: landed(answered), verifier };
  }

  it("takes an address at its domains as verified, as Entra ID sends none", async () => {
    const test = await start();
    const provider = await addOidc(test);
    provider.person = { sub: "grace-oid", email: "grace@corp.example", name: "Grace" };
    const { at, verifier } = await oidcSignIn(test, provider);
    expect((await redeem(test, at.searchParams.get("code") ?? "", verifier)).json()).toMatchObject({
      user: { name: "Grace", email: "grace@corp.example" },
    });
    // Outside its domains, only an address it verified links, and none is made.
    provider.person = { sub: "ada-oid", email: "ada@example.org", name: "Ada" };
    expect((await oidcSignIn(test, provider)).at.searchParams.get("error")).toBe(
      "email_not_verified",
    );
    provider.person = {
      sub: "ada-oid",
      email: "ada@example.org",
      email_verified: true,
      name: "Ada",
    };
    const linked = await oidcSignIn(test, provider);
    expect(
      (await redeem(test, linked.at.searchParams.get("code") ?? "", linked.verifier)).json(),
    ).toMatchObject({ user: { id: test.userId } });
    // Cancelled at the provider.
    provider.person = undefined;
    expect((await oidcSignIn(test, provider)).at.searchParams.get("error")).toBe("access_denied");
  });

  it("keeps the client's secret unless the console gives another", async () => {
    const test = await start();
    const provider = await addOidc(test);
    const renamed = await admin(test, "PUT", "/api/admin/sso/providers/okta", { name: "Okta SSO" });
    expect(renamed.json()).toMatchObject({ name: "Okta SSO", oidc: { secret: true } });
    provider.person = { sub: "grace-oid", email: "grace@corp.example" };
    expect((await oidcSignIn(test, provider)).at.searchParams.get("code")).not.toBeNull();
  });
});
