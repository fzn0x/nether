// The rules every request through the app keeps for a plugin (ADR 0090),
// on the desktop through Go's fetch and, later, on the server's relay:
// where it may go, what it may carry, which credential the app adds and
// to whom, which redirects it follows, and how much of the answer comes
// back. A plugin never sees a credential, and an error never names a
// feed's secret address.
import { type HttpMethod, type Json, httpMethods, isJsonObject } from "@nether/plugin-api";
import type { ConnectionSecret, KeptConnection } from "./connections.ts";

/** The most a request's body carries. */
export const requestBodyLimit = 1024 * 1024;
/** The most of an answer's body a plugin is given. */
export const answerLimit = 20 * 1024 * 1024;
/** How long a request may take, redirects and the answer's body included. */
export const requestTime = 60_000;
/** How many redirects a request follows. */
export const redirectLimit = 5;

/** A request as a plugin sends it, checked. */
export interface PluginRequest {
  readonly connection: string;
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly as: "text" | "bytes";
}

/** An answer as it crosses to a plugin. */
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly base64?: string;
}

/** Thrown when the app will not send a request, or cannot read its answer; its message says why. */
export class RequestRefused extends Error {
  override readonly name = "RequestRefused";
}

/** Headers only the app sets: its credential, and what is the connection's to say. */
function refusedHeader(name: string): boolean {
  return ["authorization", "cookie", "host"].includes(name) || name.startsWith("proxy-");
}

/** The headers of an answer a plugin is given. */
function keptHeader(name: string): boolean {
  return (
    ["content-type", "etag", "last-modified", "location", "link", "retry-after", "dav"].includes(
      name,
    ) || name.startsWith("x-ratelimit-")
  );
}

function isMethod(value: unknown): value is HttpMethod {
  return (httpMethods as readonly unknown[]).includes(value);
}

/** Reads a request as a plugin sent it, or refuses it, saying why. */
export function readPluginRequest(value: Json | undefined): PluginRequest {
  if (value === undefined || !isJsonObject(value))
    throw new RequestRefused("A request is an object.");
  const { connection, url, method, headers, body, as } = value;
  if (typeof connection !== "string" || connection === "") {
    throw new RequestRefused("A request names its connection.");
  }
  if (typeof url !== "string") throw new RequestRefused("A request's url is text.");
  if (!isMethod(method)) {
    throw new RequestRefused(`A request's method is one of ${httpMethods.join(", ")}.`);
  }
  if (!isJsonObject(headers)) throw new RequestRefused("A request's headers are an object.");
  const checked: Record<string, string> = {};
  for (const [name, text] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (typeof text !== "string") throw new RequestRefused(`The header ${name} is not text.`);
    if (refusedHeader(lower)) throw new RequestRefused(`Only the app sets the header ${name}.`);
    checked[lower] = text;
  }
  if (body !== undefined && typeof body !== "string") {
    throw new RequestRefused("A request's body is text.");
  }
  if (body !== undefined && new TextEncoder().encode(body).length > requestBodyLimit) {
    throw new RequestRefused("A request's body is 1 MB at most.");
  }
  if (as !== "text" && as !== "bytes") throw new RequestRefused("An answer is text or bytes.");
  return {
    connection,
    url,
    method,
    headers: checked,
    ...(body === undefined ? {} : { body }),
    as,
  };
}

/** Whether text starts as an absolute address does, with a scheme. */
function absolute(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(text);
}

/**
 * Where a request goes: its `url` resolved against the connection's
 * address, the whole one its secret keeps when that is secret. It must be
 * at one of the connection's origins.
 */
export function requestUrl(connection: KeptConnection, secret: ConnectionSecret, url: string): URL {
  const base = secret.address ?? connection.address;
  let resolved: URL;
  try {
    resolved = url === "" ? new URL(base) : absolute(url) ? new URL(url) : new URL(url, base);
  } catch {
    throw new RequestRefused("The request's address does not read as one.");
  }
  if (!connection.origins.includes(resolved.origin)) {
    throw new RequestRefused(
      absolute(url)
        ? `The connection does not reach ${resolved.origin}.`
        : "The connection's address does not read as one it reaches.",
    );
  }
  resolved.hash = "";
  return resolved;
}

/**
 * Whether a redirect may be followed: to one of the connection's origins,
 * or, for an ICS feed, which hosts often send on elsewhere, to any address
 * of the schemes the device allows.
 */
export function mayFollow(connection: KeptConnection, next: URL, http: boolean): boolean {
  if (connection.origins.includes(next.origin)) return true;
  if (connection.service !== "ics") return false;
  return next.protocol === "https:" || (http && next.protocol === "http:");
}

/** UTF-8 text as Base64. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** The `Authorization` header a secret gives: Bearer for a token, Basic for a user and password. */
export function credentialOf(secret: ConnectionSecret): string | undefined {
  if (secret.token !== undefined && secret.token !== "") return `Bearer ${secret.token}`;
  if (secret.user !== undefined && secret.user !== "") {
    const pair = new TextEncoder().encode(`${secret.user}:${secret.password ?? ""}`);
    return `Basic ${base64Of(pair)}`;
  }
  return undefined;
}

/** Reads an answer's body, up to the limit. */
async function readBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > answerLimit) {
    throw new RequestRefused("The answer is larger than 20 MB.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > answerLimit) throw new RequestRefused("The answer is larger than 20 MB.");
    return whole;
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > answerLimit) {
      await reader.cancel();
      throw new RequestRefused("The answer is larger than 20 MB.");
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

/** Text in the charset its type names, else UTF-8. */
function decode(bytes: Uint8Array, type: string | null): string {
  const charset = /;\s*charset="?([^";]+)"?/i.exec(type ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const redirects = new Set([301, 302, 303, 307, 308]);

export interface SendOptions {
  readonly connection: KeptConnection;
  readonly secret: ConnectionSecret;
  readonly request: PluginRequest;
  /** Sends with `redirect: "manual"`: Go's on the desktop, Node's on a server. */
  readonly fetch: typeof fetch;
  /** Whether `http:` addresses may be reached, as on the desktop. */
  readonly http: boolean;
  /** Ends the request early, as when its plugin stops. */
  readonly signal?: AbortSignal;
}

/**
 * Sends a plugin's request with its connection's credential, following
 * redirects the connection allows, and gives the answer as it crosses to
 * the plugin: its status, the headers it needs, and its body.
 */
export async function sendRequest(options: SendOptions): Promise<Answer> {
  const { connection, secret, request, http } = options;
  let url = requestUrl(connection, secret, request.url);
  let method: string = request.method;
  let body = request.body;
  const credential = credentialOf(secret);
  const timeout = AbortSignal.timeout(requestTime);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && !(http && url.protocol === "http:")) {
      throw new RequestRefused(`The app reaches no ${url.protocol} address.`);
    }
    const headers = new Headers(request.headers);
    // The credential goes only to the connection's own origins.
    if (credential !== undefined && connection.origins.includes(url.origin)) {
      headers.set("authorization", credential);
    }
    let response: Response;
    try {
      response = await options.fetch(url.href, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
    } catch {
      if (timeout.aborted) throw new RequestRefused("The request took longer than a minute.");
      if (signal.aborted) throw new RequestRefused("The request was stopped.");
      // Not the error's own words: they name the address, which may be a feed's secret.
      throw new RequestRefused(`${url.origin} could not be reached.`);
    }
    if (response.type === "opaqueredirect") {
      throw new RequestRefused(`${url.origin} sent the request on, which this app cannot follow.`);
    }
    const location = response.headers.get("location");
    if (redirects.has(response.status) && location !== null) {
      if (hop >= redirectLimit) throw new RequestRefused("The request was sent on too many times.");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new RequestRefused(`${url.origin} sent the request on to no address.`);
      }
      if (!mayFollow(connection, next, http)) {
        throw new RequestRefused(
          `${url.origin} sent the request on to ${next.origin}, which the connection does not reach.`,
        );
      }
      // As browsers do: a 303, or a POST sent on by a 301 or 302, becomes a GET.
      const becomesGet =
        (response.status === 303 && method !== "HEAD") ||
        (method === "POST" && (response.status === 301 || response.status === 302));
      if (becomesGet) {
        method = "GET";
        body = undefined;
      }
      await response.body?.cancel();
      url = next;
      continue;
    }
    const kept: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (keptHeader(name.toLowerCase())) kept[name.toLowerCase()] = value;
    });
    if (method === "HEAD") return { status: response.status, headers: kept };
    const bytes = await readBody(response);
    return request.as === "bytes"
      ? { status: response.status, headers: kept, base64: base64Of(bytes) }
      : {
          status: response.status,
          headers: kept,
          text: decode(bytes, kept["content-type"] ?? null),
        };
  }
}
