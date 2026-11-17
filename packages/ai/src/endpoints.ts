// Where each API's calls go, and what a request to it carries, in one place:
// the adapters send by it, and the server's relay (ADR 0070) sends only the
// calls it names, with the key in the API's own header.
import type { ProviderKind } from "./types.ts";

/** The calls the app makes of a provider. */
export type ProviderCall = "chat" | "embed";

/** The version of Anthropic's API these requests are written for. */
export const anthropicVersion = "2026-10-21";

/**
 * An API's address as the calls' paths follow it: without its last slash,
 * and for Anthropic without `/v1`, as its SDKs take it, typed with it or not.
 */
export function apiBase(kind: ProviderKind, url: string): string {
  const base = url.replace(/\/+$/, "");
  return kind === "anthropic" ? base.replace(/\/v1$/, "") : base;
}

/** The path a call takes after the API's address; undefined when the API has no such call. */
export function callPath(kind: ProviderKind, call: ProviderCall): string | undefined {
  if (kind === "anthropic") return call === "chat" ? "/v1/messages" : undefined;
  return call === "chat" ? "/chat/completions" : "/embeddings";
}

/** The call a path is, on an API of a kind; undefined for any other path. */
export function callOf(kind: ProviderKind, path: string): ProviderCall | undefined {
  return (["chat", "embed"] as const).find((call) => callPath(kind, call) === path);
}

/**
 * What a request to an API carries: JSON, the key in the API's own header
 * when there is one, and for Anthropic the API's version.
 */
export function requestHeaders(
  kind: ProviderKind,
  key: string | undefined,
): Record<string, string> {
  const keyed = key !== undefined && key !== "";
  if (kind === "anthropic") {
    return {
      "content-type": "application/json",
      "anthropic-version": anthropicVersion,
      ...(keyed ? { "x-api-key": key } : {}),
    };
  }
  return {
    "content-type": "application/json",
    ...(keyed ? { authorization: `Bearer ${key}` } : {}),
  };
}
