// A provider from its settings, and what the app says of where it is.
import { anthropic } from "./anthropic.ts";
import { openAiCompatible } from "./openai.ts";
import type { Provider, ProviderAccess, ProviderConfig } from "./types.ts";

/** The provider its settings describe, reached through `access`. */
export function createProvider(config: ProviderConfig, access: ProviderAccess): Provider {
  return config.kind === "anthropic" ? anthropic(config, access) : openAiCompatible(config, access);
}

/**
 * An API's address as someone typed it: `https://` when no scheme is
 * given, with no trailing slash; undefined when it is not an http or https
 * address, or carries a user name, a query or a fragment.
 */
export function providerUrl(typed: string): string | undefined {
  const text = typed.trim();
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Whether an address is this computer's own, as a local model's is. */
export function isLocal(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** The host an address names, with its port, as the app tells where text goes. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
