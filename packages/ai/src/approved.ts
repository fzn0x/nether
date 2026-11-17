// Approved endpoints (ADR 0086): the addresses a server's admin locks AI
// to, and whether a provider's address is one of them. The server's relay
// and the apps compare by these same rules.

/**
 * An address as approved endpoints are compared, or undefined when it is
 * not one: an http or https address with a host, no user, query or
 * fragment, its scheme and host in lower case, no default port and no
 * trailing slash. The URL parser does the lower case and the port, and
 * resolves `..` in the path, so a path cannot climb out from under an
 * approved one.
 */
export function endpointOf(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Whether a provider's address is an approved endpoint, or under one at a `/`. */
export function isApproved(address: string, endpoints: readonly string[]): boolean {
  const own = endpointOf(address);
  if (own === undefined) return false;
  return endpoints.some((endpoint) => own === endpoint || own.startsWith(`${endpoint}/`));
}
