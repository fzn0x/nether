// Reading an identity provider's metadata (ADR 0080), as Keycloak, Okta and
// Entra ID publish it: the entity ID, the Redirect binding's address and
// the signing certificates, and a refusal, saying why, for what does not
// say how to sign in.
import { describe, expect, it } from "vitest";
import { MetadataError, readIdpMetadata } from "../src/metadata.ts";

const first = "MIIBfirst";
const second = "MIIBsecond";

/** As Keycloak's realm descriptor has it: one key for signing, three bindings. */
const keycloak = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="http://127.0.0.1:8080/realms/nether">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo><ds:KeyName>key</ds:KeyName><ds:X509Data><ds:X509Certificate>${first}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://127.0.0.1:8080/realms/nether/protocol/saml"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://127.0.0.1:8080/realms/nether/protocol/saml"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:SOAP" Location="http://127.0.0.1:8080/realms/nether/protocol/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

/** As Okta's app metadata has it: a key with no use, the name formats, two bindings. */
const okta = `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor entityID="http://www.okta.com/exk1example" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
${first}
</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://example.okta.com/app/example/exk1example/sso/saml"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://example.okta.com/app/example/exk1example/sso/saml"/></md:IDPSSODescriptor></md:EntityDescriptor>`;

/**
 * As Entra ID's federation metadata has it: signed itself, WS-Federation's
 * role descriptors before the SAML one, and two signing certificates while
 * one rolls over.
 */
const entra = `<?xml version="1.0" encoding="utf-8"?><EntityDescriptor ID="_e8b2" entityID="https://sts.windows.net/00000000-0000-0000-0000-000000000001/" xmlns="urn:oasis:names:tc:SAML:2.0:metadata"><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>c2ln</SignatureValue><KeyInfo><X509Data><X509Certificate>${first}</X509Certificate></X509Data></KeyInfo></Signature><RoleDescriptor xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>MIIBwsfed</X509Certificate></X509Data></KeyInfo></KeyDescriptor></RoleDescriptor><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${first}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${second}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/saml2"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/saml2"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/saml2"/></IDPSSODescriptor></EntityDescriptor>`;

describe("readIdpMetadata", () => {
  it("reads Keycloak's descriptor", () => {
    expect(readIdpMetadata(keycloak)).toEqual({
      entityId: "http://127.0.0.1:8080/realms/nether",
      ssoUrl: "http://127.0.0.1:8080/realms/nether/protocol/saml",
      certificates: [first],
    });
  });

  it("reads Okta's, its certificate on lines of its own", () => {
    expect(readIdpMetadata(okta)).toEqual({
      entityId: "http://www.okta.com/exk1example",
      ssoUrl: "https://example.okta.com/app/example/exk1example/sso/saml",
      certificates: [first],
    });
  });

  it("reads Entra ID's, both certificates of its SAML descriptor and none of WS-Federation's", () => {
    expect(readIdpMetadata(entra)).toEqual({
      entityId: "https://sts.windows.net/00000000-0000-0000-0000-000000000001/",
      ssoUrl: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/saml2",
      certificates: [first, second],
    });
  });

  it("refuses what does not say how to sign in, saying why", () => {
    const refusal = (xml: string) => {
      try {
        readIdpMetadata(xml);
      } catch (error) {
        expect(error).toBeInstanceOf(MetadataError);
        return (error as Error).message;
      }
      return "read";
    };
    expect(refusal("not xml at all")).toContain("not XML that reads");
    expect(refusal("<!DOCTYPE x [<!ENTITY a 'b'>]><x/>")).toBe("The metadata has a document type.");
    expect(
      refusal(
        keycloak
          .replace("IDPSSODescriptor", "SPSSODescriptor")
          .replace("/md:IDPSSODescriptor", "/md:SPSSODescriptor"),
      ),
    ).toBe("The metadata describes no identity provider (IDPSSODescriptor).");
    expect(
      refusal(
        `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${keycloak.replace(/^<\?xml[^>]*>/, "")}${okta.replace(/^<\?xml[^>]*>/, "")}</md:EntitiesDescriptor>`,
      ),
    ).toContain("several identity providers");
    expect(refusal(keycloak.replace(' entityID="http://127.0.0.1:8080/realms/nether"', ""))).toBe(
      "The metadata's EntityDescriptor has no entityID.",
    );
    expect(refusal(keycloak.replaceAll("HTTP-Redirect", "HTTP-Artifact"))).toContain(
      "no SingleSignOnService for the HTTP-Redirect binding",
    );
    expect(refusal(keycloak.replace(`>${first}<`, "><"))).toBe(
      "The metadata names no certificate the provider signs with.",
    );
    expect(refusal(keycloak.replace('use="signing"', 'use="encryption"'))).toBe(
      "The metadata names no certificate the provider signs with.",
    );
  });
});
