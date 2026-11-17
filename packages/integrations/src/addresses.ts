// Addresses as the person types them for a connection (ADR 0090): a feed's
// `webcal:` is read as `https:`, an address is `https:` or, on a device
// whose person typed it, `http:`, it has a host, and it carries no user
// or password, which the connection keeps apart.

/** Why a typed address is not one a connection can use. */
export type AddressProblem = "empty" | "scheme" | "host" | "credentials";

/** What a typed address is read as: the address, or why it is not one. */
export type ReadAddress =
  | { readonly url: URL; readonly problem?: undefined }
  | { readonly url?: undefined; readonly problem: AddressProblem };

/**
 * Reads an address the person typed. `http` says whether `http:` is
 * allowed: on the desktop it is, as a server on their own network; on a
 * server, only where its admin allows the address.
 */
export function readAddress(text: string, http: boolean): ReadAddress {
  const trimmed = text.trim();
  if (trimmed === "") return { problem: "empty" };
  // A calendar's subscription link names its feed with webcal:, which is https.
  const typed = /^webcals?:\/\//i.test(trimmed)
    ? `https://${trimmed.replace(/^webcals?:\/\//i, "")}`
    : trimmed;
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return { problem: /^[a-z][a-z0-9+.-]*:/i.test(typed) ? "scheme" : "host" };
  }
  if (url.protocol !== "https:" && !(http && url.protocol === "http:")) {
    return { problem: "scheme" };
  }
  if (url.hostname === "") return { problem: "host" };
  if (url.username !== "" || url.password !== "") return { problem: "credentials" };
  url.hash = "";
  return { url };
}

/** Whether an origin, as `https://example.org`, reads as one. */
export function isOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text;
  } catch {
    return false;
  }
}
