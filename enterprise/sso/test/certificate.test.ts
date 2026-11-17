// The certificate the DER writer makes (ADR 0080), read back by Node's own
// X509Certificate: its key, its name, its dates, its signature and its uses.
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { certificateYears, newServiceKey, selfSigned } from "../src/certificate.ts";

describe("selfSigned", () => {
  it("writes a certificate X509Certificate reads, signed by its own key", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const from = new Date("2026-11-17T10:20:30.400Z");
    const read = new X509Certificate(selfSigned("Nether sign-on keycloak", keys, from));
    expect(read.subject).toBe("CN=Nether sign-on keycloak");
    expect(read.issuer).toBe(read.subject);
    expect(read.verify(keys.publicKey)).toBe(true);
    expect(read.checkPrivateKey(keys.privateKey)).toBe(true);
    expect(read.publicKey.export({ type: "spki", format: "der" })).toEqual(
      keys.publicKey.export({ type: "spki", format: "der" }),
    );
    expect(new Date(read.validFrom).toISOString()).toBe("2026-11-17T10:19:30.000Z");
    expect(new Date(read.validTo).toISOString()).toBe(
      `${String(2026 + certificateYears)}-11-17T10:19:30.000Z`,
    );
    expect(read.ca).toBe(false);
    expect(read.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
  });

  it("writes GeneralizedTime from 2050, and a name of any length", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const name = `Nether ${"x".repeat(200)}`;
    const read = new X509Certificate(selfSigned(name, keys, new Date("2045-06-01T00:00:00Z")));
    expect(read.subject).toBe(`CN=${name}`);
    expect(new Date(read.validTo).getUTCFullYear()).toBe(2055);
    expect(read.verify(keys.publicKey)).toBe(true);
  });
});

describe("newServiceKey", () => {
  it("makes a key and a certificate that match, in PEM", () => {
    const made = newServiceKey("Nether sign-on okta");
    const read = new X509Certificate(made.certificate);
    expect(read.checkPrivateKey(createPrivateKey(made.privateKey))).toBe(true);
    expect(createPublicKey(made.privateKey).asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(made.certificate.split("\n").every((line) => line.length <= 64)).toBe(true);
  });
});
