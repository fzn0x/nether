// Custom domains for published sites (ADR 0077): a site claims a domain,
// and holds it once a TXT record at _nether-site.<domain> has the value the
// server gave for that claim, which only whoever controls the domain's DNS
// can write. Requests whose host is a domain a site holds are that site's.
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/** What looks up a name's TXT records: each record's strings. The system's resolver unless a test gives another. */
export type TxtResolver = (name: string) => Promise<string[][]>;

export const systemTxt: TxtResolver = (name) => resolveTxt(name);

/** Where a domain's claim is written: the TXT record's name. */
export function recordName(domain: string): string {
  return `_nether-site.${domain}`;
}

/** The value a claim's TXT record has. */
export function recordValue(token: string): string {
  return `nether-site=${token}`;
}

/** A new claim's token: 144 random bits, which no one guesses. */
export function claimToken(): string {
  return randomBytes(18).toString("base64url");
}

/** A domain name's label: letters, digits and hyphens, not at either end. */
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host a server's configured address names, lowercased; undefined without one. */
export function ownHost(publicUrl: string | null): string | undefined {
  return publicUrl === null ? undefined : new URL(publicUrl).hostname.toLowerCase();
}

/**
 * A domain as a site claims it, or as a request names its host: lower case,
 * in ASCII, without a final dot. Undefined for one no site can have: an
 * address, a single label as `localhost`, a `.localhost` name, or the
 * server's own host, whose requests are the web app's and the API's.
 */
export function domainName(text: string, own?: string): string | undefined {
  const lowered = text.trim().toLowerCase().replace(/\.$/, "");
  if (lowered === "" || lowered.length > 253 || isIP(lowered) !== 0) return undefined;
  // A name alone: what a URL has around a host, as a path or a port, is no part of one.
  if (/[\s/\\:?#@%[\]]/.test(lowered)) return undefined;
  const ascii = domainToASCII(lowered);
  if (ascii === "" || ascii.length > 253) return undefined;
  const labels = ascii.split(".");
  const top = labels.at(-1) ?? "";
  if (labels.length < 2 || !labels.every((part) => label.test(part)) || /^[0-9]+$/.test(top)) {
    return undefined;
  }
  if (top === "localhost" || ascii === own) return undefined;
  return ascii;
}

/** What looking up a claim's record found: it, not it, or a failure of the lookup itself. */
export type Lookup =
  { readonly found: true } | { readonly found: false; readonly failure?: string };

/** Whether a domain's TXT record at `_nether-site.` has a claim's value. */
export async function lookUpClaim(
  resolve: TxtResolver,
  domain: string,
  token: string,
): Promise<Lookup> {
  const wanted = recordValue(token);
  try {
    const records = await resolve(recordName(domain));
    return records.some((strings) => strings.join("").trim() === wanted)
      ? { found: true }
      : { found: false };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : "";
    // No such name, or no TXT record at it: the record is not there yet.
    if (code === "ENODATA" || code === "ENOTFOUND") return { found: false };
    return { found: false, failure: typeof code === "string" && code !== "" ? code : "error" };
  }
}
