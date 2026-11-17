// A SAML identity provider for tests: its metadata, the request the
// browser brings it, and the answer it posts back, signed as a provider
// signs it, and, when asked, encrypted to Nether's certificate. Each part
// of the answer can be bent, so a test can send what an attacker would.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { encrypt } from "xml-encryption";
import { selfSigned } from "../src/certificate.ts";

const protocol = "urn:oasis:names:tc:SAML:2.0:protocol";
const assertionNamespace = "urn:oasis:names:tc:SAML:2.0:assertion";
export const persistent = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const transient = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
export const emailFormat = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** Whom the provider signs in. */
export interface IdpPerson {
  readonly nameId: string;
  readonly format?: string;
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
}

/** What the answer says, each part as a provider would send it unless the test bends it. */
export interface Bend {
  readonly requestId?: string;
  readonly recipient?: string;
  readonly audience?: string;
  readonly issuer?: string;
  /** Minutes from now the assertion stops being accepted; negative for one already expired. */
  readonly minutes?: number;
  readonly signAssertion?: boolean;
  readonly signResponse?: boolean;
  /** Nether's certificate, to encrypt the assertion to. */
  readonly encryptTo?: string;
  /** The answer's XML, changed after signing. */
  readonly after?: (xml: string) => string;
}

/** The request a browser brings, as the Redirect binding sends it. */
export interface Asked {
  readonly id: string;
  readonly issuer: string;
  readonly acsUrl: string;
  readonly relayState: string;
  readonly signed: boolean;
  readonly xml: string;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const instant = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const newId = () => `_${randomBytes(16).toString("hex")}`;

export class TestIdp {
  readonly entityId: string;
  readonly ssoUrl = "https://idp.example.test/sso";
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly certificate: string;

  constructor(entityId = "https://idp.example.test/saml") {
    this.entityId = entityId;
    this.certificate = selfSigned("Test identity provider", this.#keys);
  }

  /** The certificate in base64, as metadata carries it. */
  get certificateBase64(): string {
    return this.certificate.replace(/-----[^-]+-----|\s+/g, "");
  }

  metadata(): string {
    return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escape(this.entityId)}">
  <md:IDPSSODescriptor protocolSupportEnumeration="${protocol}">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${this.certificateBase64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${this.ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
  }

  /** Reads the request a browser was sent to the provider with. */
  asked(url: string): Asked {
    const query = new URL(url).searchParams;
    const xml = inflateRawSync(Buffer.from(query.get("SAMLRequest") ?? "", "base64")).toString(
      "utf8",
    );
    const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1] ?? "";
    return {
      id: attribute(" ID"),
      issuer: /<saml:Issuer[^>]*>([^<]*)</.exec(xml)?.[1] ?? "",
      acsUrl: attribute("AssertionConsumerServiceURL"),
      relayState: query.get("RelayState") ?? "",
      signed: query.has("Signature") && query.get("SigAlg") !== null,
      xml,
    };
  }

  #sign(xml: string, element: "Assertion" | "Response"): string {
    const signer = new SignedXml({
      privateKey: this.#keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      publicCert: this.certificate,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    signer.addReference({
      xpath: `//*[local-name(.)='${element}']`,
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
    });
    signer.computeSignature(xml, {
      prefix: "ds",
      location: {
        reference: `//*[local-name(.)='${element}']/*[local-name(.)='Issuer']`,
        action: "after",
      },
    });
    return signer.getSignedXml();
  }

  /** An assertion for `person`, answering `asked`, as bent. */
  assertion(asked: Asked, person: IdpPerson, bend: Bend = {}): string {
    const now = new Date();
    const until = new Date(now.getTime() + (bend.minutes ?? 5) * 60_000);
    const before = new Date(Math.min(now.getTime(), until.getTime()) - 60_000);
    const attributes = Object.entries(person.attributes ?? {})
      .map(
        ([name, value]) =>
          `<saml:Attribute Name="${escape(name)}">${(typeof value === "string" ? [value] : value)
            .map((each) => `<saml:AttributeValue>${escape(each)}</saml:AttributeValue>`)
            .join("")}</saml:Attribute>`,
      )
      .join("");
    const xml = `<saml:Assertion xmlns:saml="${assertionNamespace}" ID="${newId()}" Version="2.0" IssueInstant="${instant(now)}"><saml:Issuer>${escape(bend.issuer ?? this.entityId)}</saml:Issuer><saml:Subject><saml:NameID Format="${person.format ?? persistent}">${escape(person.nameId)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${escape(bend.requestId ?? asked.id)}" NotOnOrAfter="${instant(until)}" Recipient="${escape(bend.recipient ?? asked.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${instant(before)}" NotOnOrAfter="${instant(until)}"><saml:AudienceRestriction><saml:Audience>${escape(bend.audience ?? asked.issuer)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${instant(now)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${attributes === "" ? "" : `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`}</saml:Assertion>`;
    return bend.signAssertion === false ? xml : this.#sign(xml, "Assertion");
  }

  /** Encrypts an assertion to a certificate, with AES-256-GCM and RSA-OAEP, as Keycloak can. */
  encrypted(assertion: string, certificate: string): Promise<string> {
    return new Promise((resolve, reject) => {
      encrypt(
        assertion,
        {
          rsa_pub: certificate,
          pem: certificate,
          encryptionAlgorithm: "http://www.w3.org/2009/xmlenc11#aes256-gcm",
          keyEncryptionAlgorithm: "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
          disallowEncryptionWithInsecureAlgorithm: true,
          warnInsecureAlgorithm: false,
        },
        (error: Error | null, result: string) => {
          if (error !== null) reject(error);
          else
            resolve(
              `<saml:EncryptedAssertion xmlns:saml="${assertionNamespace}">${result}</saml:EncryptedAssertion>`,
            );
        },
      );
    });
  }

  /** A response holding `assertions`, as posted. */
  response(asked: Asked, assertions: readonly string[], bend: Bend = {}): string {
    const xml = `<samlp:Response xmlns:samlp="${protocol}" xmlns:saml="${assertionNamespace}" ID="${newId()}" Version="2.0" IssueInstant="${instant(new Date())}" Destination="${escape(bend.recipient ?? asked.acsUrl)}" InResponseTo="${escape(bend.requestId ?? asked.id)}"><saml:Issuer>${escape(bend.issuer ?? this.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertions.join("")}</samlp:Response>`;
    const signed = bend.signResponse === true ? this.#sign(xml, "Response") : xml;
    return bend.after === undefined ? signed : bend.after(signed);
  }

  /** The form a browser posts back: the provider's answer for `person` to the request at `url`. */
  async answer(url: string, person: IdpPerson, bend: Bend = {}): Promise<Record<string, string>> {
    const asked = this.asked(url);
    let assertion = this.assertion(asked, person, bend);
    if (bend.encryptTo !== undefined) assertion = await this.encrypted(assertion, bend.encryptTo);
    return {
      SAMLResponse: Buffer.from(this.response(asked, [assertion], bend)).toString("base64"),
      RelayState: asked.relayState,
    };
  }
}
