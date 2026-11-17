// SAML's checks one by one (ADR 0080), each refusal with its reason: what
// the server tells the app is only that the provider's answer was refused,
// so these say why it was.
import { testDatabase } from "@nether/server/test/database.ts";
import { migrate } from "@nether/server/src/migrations.ts";
import type { Database } from "@nether/server/src/db.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newServiceKey } from "../src/certificate.ts";
import { readIdpMetadata } from "../src/metadata.ts";
import type { SamlSettings } from "../src/providers.ts";
import { type SamlContext, finishSaml, samlAddresses, startSaml } from "../src/saml.ts";
import { type Bend, type IdpPerson, TestIdp, transient } from "./idp.ts";

const publicUrl = "https://nether.example.org";
const person: IdpPerson = { nameId: "grace-1", attributes: { mail: "grace@corp.example" } };
// One key for every test: making a 3072-bit key takes a while.
const key = newServiceKey("Nether sign-on corp");
const idp = new TestIdp();

let db: Database;
let context: SamlContext;

beforeEach(async () => {
  db = await testDatabase();
  await migrate(db);
  const read = readIdpMetadata(idp.metadata());
  const settings: SamlSettings = {
    kind: "saml",
    metadataUrl: null,
    metadata: idp.metadata(),
    readAt: new Date().toISOString(),
    entityId: read.entityId,
    ssoUrl: read.ssoUrl,
    idpCertificates: read.certificates,
    requireEncryption: false,
    subjectAttribute: null,
    emailAttribute: null,
    nameAttribute: null,
    certificate: key.certificate,
  };
  context = { db, publicUrl, id: "corp", settings, privateKey: key.privateKey };
});

afterEach(async () => {
  await db.close();
});

/** Starts a sign-in, and checks the provider's answer for `who`, bent as asked. */
async function answer(bend: Bend = {}, who = person, on = context) {
  const { url, requestId } = await startSaml(on, "state");
  return finishSaml(on, await idp.answer(url, who, bend), requestId);
}

describe("finishSaml", () => {
  it("gives whom a good answer names", async () => {
    await expect(answer()).resolves.toEqual({
      subject: "grace-1",
      email: "grace@corp.example",
      emailVerified: false,
      name: "grace",
    });
  });

  it("refuses each answer it should not take, saying why", async () => {
    await expect(answer({ signAssertion: false })).rejects.toThrow(/signature/i);
    await expect(answer({ requestId: "_another" })).rejects.toThrow(/InResponseTo/);
    await expect(answer({ recipient: `${publicUrl}/api/sso/other/saml/acs` })).rejects.toThrow(
      "The assertion is not for this sign-in",
    );
    await expect(answer({ audience: "https://elsewhere.example" })).rejects.toThrow(/audience/i);
    await expect(answer({ issuer: "https://idp.elsewhere.test" })).rejects.toThrow(/issuer/i);
    await expect(answer({ minutes: -5 })).rejects.toThrow(/expired|subject confirmation/i);
    await expect(
      answer({ after: (xml) => xml.replace("grace@corp.example", "admin@corp.example") }),
    ).rejects.toThrow(/signature/i);
    await expect(answer({}, { ...person, format: transient })).rejects.toThrow(
      "The assertion's NameID is transient",
    );
  });

  it("refuses an answer from a provider with another key", async () => {
    const { url, requestId } = await startSaml(context, "state");
    const form = await new TestIdp().answer(url, person);
    await expect(finishSaml(context, form, requestId)).rejects.toThrow(/signature/i);
  });

  it("refuses a second assertion wrapped beside the signed one", async () => {
    await expect(
      answer({
        after: (xml) =>
          xml.replace(
            "<samlp:Status>",
            `<saml:Assertion ID="_evil" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"><saml:Issuer>${idp.entityId}</saml:Issuer></saml:Assertion><samlp:Status>`,
          ),
      }),
    ).rejects.toThrow(/assertion/i);
  });

  it("takes an answer once", async () => {
    const { url, requestId } = await startSaml(context, "state");
    const form = await idp.answer(url, person);
    await expect(finishSaml(context, form, requestId)).resolves.toMatchObject({
      subject: "grace-1",
    });
    await expect(finishSaml(context, form, requestId)).rejects.toThrow(
      /InResponseTo|already been received/,
    );
  });

  it("decrypts an encrypted assertion, and refuses a plain one when encryption is required", async () => {
    const strict = { ...context, settings: { ...context.settings, requireEncryption: true } };
    await expect(answer({}, person, strict)).rejects.toThrow(
      "The answer's assertion is not encrypted, which this provider requires.",
    );
    await expect(
      answer({ encryptTo: context.settings.certificate }, person, strict),
    ).resolves.toMatchObject({ subject: "grace-1" });
  });

  it("asks for the provider's address with a request signed by Nether's key", async () => {
    const { url } = await startSaml(context, "state");
    const asked = idp.asked(url);
    expect(asked).toMatchObject({
      issuer: samlAddresses(publicUrl, "corp").entityId,
      acsUrl: samlAddresses(publicUrl, "corp").acsUrl,
      relayState: "state",
      signed: true,
    });
    expect(new URL(url).searchParams.get("SigAlg")).toBe(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
  });
});
