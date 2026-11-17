// Requests the server sends where someone told it to, as webhooks are
// (ADR 0060), and the web app's AI requests (ADR 0070). A server sits
// inside a network: its database, Valkey, a cloud's metadata at
// 169.254.169.254 and the admin's other services are all a request away.
// So each request resolves its host when it is sent, refuses every address
// that is not public unless the admin allows it (NETHER_WEBHOOK_PRIVATE,
// NETHER_AI_PRIVATE), and connects to the address it checked, so a name
// cannot resolve to a public address when checked and a private one when
// used. Redirects are not followed. A webhook's answer's body is not read;
// an AI provider's is streamed back. Signatures follow the Standard
// Webhooks spec.
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, type LookupFunction, isIP } from "node:net";

/** Which addresses that are not public a request may reach: none, all, or these. */
export type PrivatePolicy = boolean | readonly string[];

/** An address a host resolved to. */
export interface Resolved {
  readonly address: string;
  readonly family: 4 | 6;
}

/** What gives a host's addresses; the system's resolver unless a test gives another. */
export type Resolver = (host: string) => Promise<readonly Resolved[]>;

const notPublic = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8], // "this network", the unspecified address among it
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared, carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, with clouds' metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relays
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  notPublic.addSubnet(network, bits, "ipv4");
}
for (const [network, bits] of [
  // IPv4-mapped addresses are checked as IPv4: BlockList matches IPv4
  // addresses against ::ffff:0:0/96, so that range is not listed here.
  ["::", 96], // unspecified, loopback, and IPv4-compatible
  ["::ffff:0:0:0", 96], // IPv4-translated (RFC 2765), not routed, nor public
  ["64:ff9b::", 96], // NAT64, which reaches IPv4 addresses
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // protocol assignments, Teredo among them
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which reaches IPv4 addresses
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local, as it was
  ["ff00::", 8], // multicast
] as const) {
  notPublic.addSubnet(network, bits, "ipv6");
}

/** An IPv6 address's eight 16-bit words, or undefined when it does not read as one. */
function words(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const read = (part: string | undefined) =>
    part === undefined || part === "" ? [] : part.split(":").map((word) => parseInt(word, 16));
  const head = read(halves[0]);
  const rest = read(halves[1]);
  const gap = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array<number>(Math.max(gap, 0)).fill(0), ...rest];
  return all.length === 8 && all.every((word) => word >= 0 && word <= 0xffff) ? all : undefined;
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, as `::ffff:127.0.0.1`. */
function mappedIPv4(address: string): string | undefined {
  const all = words(address);
  if (all === undefined || all.slice(0, 5).some((word) => word !== 0) || all[5] !== 0xffff) {
    return undefined;
  }
  const [high = 0, low = 0] = all.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** An address as it is checked: an IPv4-mapped IPv6 address as its IPv4 address. */
function checkedForm(address: string): Resolved | undefined {
  const version = isIP(address);
  if (version === 4) return { address, family: 4 };
  if (version !== 6) return undefined;
  const mapped = mappedIPv4(address);
  return mapped === undefined ? { address, family: 6 } : { address: mapped, family: 4 };
}

/** Whether an address is a public one: none of the loopback, private and reserved ranges. */
export function isPublicAddress(address: string): boolean {
  const form = checkedForm(address);
  if (form === undefined) return false;
  return !notPublic.check(form.address, form.family === 4 ? "ipv4" : "ipv6");
}

/** The ranges proxy-addr names, which NETHER_TRUST_PROXY and NETHER_WEBHOOK_PRIVATE share. */
const namedRanges: Readonly<Record<string, readonly (readonly [string, number])[]>> = {
  loopback: [
    ["127.0.0.0", 8],
    ["::1", 128],
  ],
  linklocal: [
    ["169.254.0.0", 16],
    ["fe80::", 10],
  ],
  uniquelocal: [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["fc00::", 7],
  ],
};

/** Whether the admin's policy lets a request reach an address that is not public. */
export function allowsPrivate(policy: PrivatePolicy, address: string): boolean {
  if (typeof policy === "boolean") return policy;
  const form = checkedForm(address);
  if (form === undefined) return false;
  const allowed = new BlockList();
  for (const entry of policy) {
    for (const [network, bits] of namedRanges[entry] ?? []) {
      allowed.addSubnet(network, bits, isIP(network) === 4 ? "ipv4" : "ipv6");
    }
    if (namedRanges[entry] !== undefined) continue;
    const [network = "", bits] = entry.split("/");
    const family = isIP(network) === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) allowed.addAddress(network, family);
    else allowed.addSubnet(network, Number(bits), family);
  }
  return allowed.check(form.address, form.family === 4 ? "ipv4" : "ipv6");
}

/** Whether an address may be reached: a public one, or one the admin allows. */
export function reachable(policy: PrivatePolicy, address: string): boolean {
  return isPublicAddress(address) || allowsPrivate(policy, address);
}

const systemResolver: Resolver = async (host) => {
  const found = await lookup(host, { all: true, order: "verbatim" });
  return found.map((item) => ({ address: item.address, family: item.family === 6 ? 6 : 4 }));
};

/** A URL's host as resolving takes it: an IPv6 address without its brackets. */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * Why a webhook's address cannot be saved, or undefined when it can:
 * `https://`, or `http://` when the admin allows private addresses; no user
 * or password in it; and, when its host is an address, one it may reach.
 */
export function addressProblem(text: string, policy: PrivatePolicy): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "This is not an address.";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy !== false)) {
    return "A webhook's address is https://.";
  }
  if (url.username !== "" || url.password !== "") {
    return "A webhook's address has no user or password in it.";
  }
  const host = hostOf(url);
  if (host === "") return "This address has no host.";
  if (isIP(host) !== 0 && !reachable(policy, host)) {
    return "This address is not a public one, and the server's admin allows no other.";
  }
  return undefined;
}

/** What sending gave: the answer's status, or why there was none. */
export type Outcome =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly status?: number; readonly error: string };

export interface SendOptions {
  readonly policy: PrivatePolicy;
  readonly resolve?: Resolver;
  /** How long to wait for the answer's status, in milliseconds. */
  readonly timeout?: number;
  /** The setting that allows addresses that are not public, which a refusal names. */
  readonly allowedBy?: string;
}

/**
 * The address a request to `url` connects to, once checked: every address
 * its host resolves to must be one it may reach, and `http://` goes only to
 * a private address the admin allows.
 */
async function target(url: URL, options: SendOptions): Promise<Resolved | string> {
  const first = await checkedHost(hostOf(url), options);
  if (typeof first === "string") return first;
  if (url.protocol === "http:" && isPublicAddress(first.address)) {
    return "http:// goes only to a private address the admin allows; a public one takes https://.";
  }
  return first;
}

/**
 * The address a connection to `host` goes to, once checked: every address
 * it resolves to must be one it may reach, as an LDAP directory's are
 * (ADR 0085); or why it may not be reached. The caller connects to that
 * address, and gives TLS the name.
 */
export async function checkedHost(host: string, options: SendOptions): Promise<Resolved | string> {
  const literal = checkedForm(host);
  let found: readonly Resolved[];
  if (isIP(host) !== 0 && literal !== undefined)
    found = [{ address: host, family: literal.family }];
  else {
    try {
      found = await (options.resolve ?? systemResolver)(host);
    } catch (error) {
      return `${host} does not resolve: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const first = found[0];
  if (first === undefined) return `${host} resolves to no address.`;
  const refused = found.find((item) => !reachable(options.policy, item.address));
  if (refused !== undefined) {
    return `${host} resolves to ${refused.address}, which is not a public address: the server's admin can allow it with ${options.allowedBy ?? "NETHER_WEBHOOK_PRIVATE"}.`;
  }
  return first;
}

/** A lookup that gives the address already checked, whatever the host. */
function pinned(to: Resolved): LookupFunction {
  return (_host, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: to.address, family: to.family }]);
    } else {
      callback(null, to.address, to.family);
    }
  };
}

/**
 * Posts `body` to `address`, with `headers`, to the address its host
 * resolved to when checked; a 2xx answer is delivered.
 */
export async function post(
  address: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  options: SendOptions,
): Promise<Outcome> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, error: "This is not an address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "A webhook's address is https://." };
  }
  const to = await target(url, options);
  if (typeof to === "string") return { ok: false, error: to };
  const host = hostOf(url);
  const timeout = options.timeout ?? 10_000;
  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup: pinned(to),
        agent: false,
        ...(isIP(host) === 0 ? { servername: host } : {}),
      },
      (answer: IncomingMessage) => {
        const status = answer.statusCode ?? 0;
        // The answer's body is not read: only its status counts.
        answer.destroy();
        finish(
          status >= 200 && status < 300
            ? { ok: true, status }
            : { ok: false, status, error: `The address answered ${String(status)}.` },
        );
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, error: `No answer within ${String(timeout / 1000)} seconds.` });
    }, timeout);
    request.on("error", (error) => {
      finish({ ok: false, error: `Could not send: ${error.message}` });
    });
    request.end(body);
  });
}

/** An answer whose body is read as it comes, or why there is none. */
export type Opened =
  | {
      readonly ok: true;
      readonly answer: IncomingMessage;
      /** Ends the request and its answer, as when the one who asked has gone. */
      readonly close: () => void;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Posts `body` to `address` as `post` does, checked and pinned to the
 * address its host resolved to, and gives the answer to read as it comes,
 * as a relay streams a reply back (ADR 0070). Redirects are not followed.
 */
export async function open(
  address: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  options: SendOptions,
): Promise<Opened> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { ok: false, error: "This is not an address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "This address is not http:// or https://." };
  }
  const to = await target(url, options);
  if (typeof to === "string") return { ok: false, error: to };
  const host = hostOf(url);
  const timeout = options.timeout ?? 10_000;
  return new Promise<Opened>((resolve) => {
    let settled = false;
    const finish = (outcome: Opened) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: pinned(to),
        agent: false,
        ...(isIP(host) === 0 ? { servername: host } : {}),
      },
      (answer: IncomingMessage) => {
        finish({
          ok: true,
          answer,
          close: () => {
            request.destroy();
            answer.destroy();
          },
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, error: `No answer within ${String(timeout / 1000)} seconds.` });
    }, timeout);
    request.on("error", (error) => {
      finish({ ok: false, error: `Could not send: ${error.message}` });
    });
    request.end(body);
  });
}

/** What a checked fetch is asked, as `fetch` and openid-client's `customFetch` ask it. */
export interface CheckedRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | URLSearchParams | Uint8Array | ArrayBuffer | null;
  readonly signal?: AbortSignal | null;
}

/** A fetch whose requests are checked and pinned as `post`'s are. */
export type CheckedFetch = (address: string, request?: CheckedRequest) => Promise<Response>;

/** The bytes of a body a checked fetch sends. */
function bodyBytes(body: CheckedRequest["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
}

/**
 * A fetch for addresses an admin named, as a sign-on provider's metadata
 * and endpoints are (ADR 0080): each request checked and pinned to the
 * address its host resolved to, as `post` does, redirects given back
 * rather than followed, and an answer read to `limit` bytes at most. A
 * refusal rejects, saying why, as a failed fetch does.
 */
export function checkedFetch(options: SendOptions & { readonly limit?: number }): CheckedFetch {
  const limit = options.limit ?? 1_000_000;
  return async (address, init = {}) => {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("This address is not http:// or https://.");
    }
    const to = await target(url, options);
    if (typeof to === "string") throw new Error(to);
    const host = hostOf(url);
    const timeout = options.timeout ?? 10_000;
    const body = bodyBytes(init.body);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: Response | Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port === "" ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? "GET",
          headers: {
            ...init.headers,
            ...(body === undefined ? {} : { "content-length": String(body.length) }),
          },
          lookup: pinned(to),
          agent: false,
          ...(isIP(host) === 0 ? { servername: host } : {}),
        },
        (answer: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          answer.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              request.destroy();
              finish(new Error(`The answer is larger than ${String(limit)} bytes.`));
              return;
            }
            chunks.push(chunk);
          });
          answer.on("end", () => {
            const status = answer.statusCode ?? 502;
            const headers = new Headers();
            for (const [name, value] of Object.entries(answer.headers)) {
              if (typeof value === "string") headers.set(name, value);
              else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            }
            // A Response for these statuses takes no body.
            const empty = [101, 204, 205, 304].includes(status);
            finish(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
          });
          answer.on("error", (error) => {
            finish(error);
          });
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish(new Error(`No answer within ${String(timeout / 1000)} seconds.`));
      }, timeout);
      init.signal?.addEventListener("abort", () => {
        request.destroy();
        finish(new Error("The request was stopped."));
      });
      request.on("error", (error) => {
        finish(new Error(`Could not reach ${host}: ${error.message}`));
      });
      request.end(body);
    });
  };
}

/** A new webhook secret: `whsec_` and 32 random bytes in base64, as Standard Webhooks has it. */
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/**
 * The `webhook-signature` header of a message, as Standard Webhooks has it:
 * `v1,` and the base64 HMAC-SHA256 of `<id>.<timestamp>.<body>`, keyed by
 * the bytes of the secret after `whsec_`.
 */
export function signature(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = createHmac("sha256", key).update(`${id}.${String(timestamp)}.${body}`);
  return `v1,${signed.digest("base64")}`;
}
