// A SAML identity provider's metadata (ADR 0080): only what signing in
// takes from it, its entity ID, its address for the Redirect binding, and
// the certificates it signs with. node-saml reads no metadata, so this
// does, with the XML parser node-saml itself uses.
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";

/** What a provider's metadata says, as signing in uses it. */
export interface IdpMetadata {
  readonly entityId: string;
  /** Where the browser goes with a request, over the HTTP-Redirect binding. */
  readonly ssoUrl: string;
  /** The certificates it signs with, in base64 as the metadata has them. */
  readonly certificates: readonly string[];
}

/** Metadata that does not read, saying why. */
export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

const redirectBinding = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const metadataNamespace = "urn:oasis:names:tc:SAML:2.0:metadata";
const signatureNamespace = "http://www.w3.org/2000/09/xmldsig#";

/** The largest metadata taken, as Entra ID's, with its several certificates, is far smaller. */
export const metadataLimit = 1_000_000;

const select = xpath.useNamespaces({ md: metadataNamespace, ds: signatureNamespace });

function elements(expression: string, node: Node): Element[] {
  const found = select(expression, node);
  return Array.isArray(found) ? found.filter((item): item is Element => xpath.isElement(item)) : [];
}

/** Reads a provider's metadata, refusing what does not say how to sign in, and why. */
export function readIdpMetadata(xml: string): IdpMetadata {
  if (xml.length > metadataLimit) throw new MetadataError("The metadata is too large.");
  // No document type: a provider's metadata needs none, and entities are a door.
  if (/<!DOCTYPE/i.test(xml)) throw new MetadataError("The metadata has a document type.");
  const problems: string[] = [];
  const document = new DOMParser({
    errorHandler: (level: string, message: unknown) => {
      if (level !== "warning") problems.push(String(message));
    },
  }).parseFromString(xml, "text/xml");
  if (problems.length > 0 || document.getElementsByTagName("*").length === 0) {
    throw new MetadataError(`The metadata is not XML that reads: ${problems[0] ?? "it is empty"}.`);
  }
  // One provider's EntityDescriptor, alone or as the one with an IDPSSODescriptor in a list.
  const entities = elements("//md:EntityDescriptor[md:IDPSSODescriptor]", document);
  const [entity] = entities;
  if (entity === undefined) {
    throw new MetadataError("The metadata describes no identity provider (IDPSSODescriptor).");
  }
  if (entities.length > 1) {
    throw new MetadataError(
      "The metadata describes several identity providers: give the one for Nether alone.",
    );
  }
  const entityId = entity.getAttribute("entityID")?.trim() ?? "";
  if (entityId === "") throw new MetadataError("The metadata's EntityDescriptor has no entityID.");
  const descriptor = elements("md:IDPSSODescriptor", entity)[0] ?? entity;
  const sso = elements("md:SingleSignOnService", descriptor).find(
    (service) => service.getAttribute("Binding") === redirectBinding,
  );
  const ssoUrl = sso?.getAttribute("Location")?.trim() ?? "";
  if (ssoUrl === "") {
    throw new MetadataError(
      "The metadata has no SingleSignOnService for the HTTP-Redirect binding, which Nether sends its requests by.",
    );
  }
  try {
    const url = new URL(ssoUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
  } catch {
    throw new MetadataError(`The metadata's SingleSignOnService is not an address: ${ssoUrl}.`);
  }
  // Keys for signing, or for any use when the descriptor says none.
  const keys = elements("md:KeyDescriptor", descriptor).filter((key) => {
    const use = key.getAttribute("use");
    return use === null || use === "" || use === "signing";
  });
  const certificates = [
    ...new Set(
      keys.flatMap((key) =>
        elements(".//ds:X509Certificate", key)
          .map((certificate) => certificate.textContent.replace(/\s+/g, ""))
          .filter((text) => text !== ""),
      ),
    ),
  ];
  if (certificates.length === 0) {
    throw new MetadataError("The metadata names no certificate the provider signs with.");
  }
  return { entityId, ssoUrl, certificates };
}
