// Reaching an LDAP directory (ADR 0085): always encrypted, by `ldaps://`
// or StartTLS on `ldap://`, its certificate checked against the system's
// authorities, those the admin pasted, or a pinned SHA-256 fingerprint,
// with no way to skip the check. Its host is resolved and checked under
// the outbound rules (ADR 0060): an address that is not public only when
// NETHER_LDAP_PRIVATE allows it, and the connection goes to the address
// checked, with TLS given the name. A run reads on one connection: ldapts
// reconnects on its own, without the bind or StartTLS, so the socket
// factories Nether gives it refuse a second one, and a dropped connection
// fails the run.
import { isIP, type Socket, connect as netConnect } from "node:net";
import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from "node:tls";
import { Client, type Entry, ResultCodeError } from "ldapts";
import { type PrivatePolicy, type Resolver, checkedHost } from "@nether/server/src/outbound.ts";
import { type LdapSettings, addressOf } from "./ldapSettings.ts";

/** The setting that lets a directory be at an address that is not public. */
export const privateSetting = "NETHER_LDAP_PRIVATE";

/** Where the server may reach directories, and how long it waits. */
export interface LdapReach {
  readonly policy: PrivatePolicy;
  /** What gives a host's addresses; the system's resolver unless a test gives another. */
  readonly resolve?: Resolver;
  /** Milliseconds to connect, TLS included. */
  readonly connectTimeout?: number;
  /** Milliseconds for each operation, as each page of a search. */
  readonly pageTimeout?: number;
}

/** Why reaching or reading a directory failed, said for the console. */
export class LdapFailure extends Error {
  override readonly name = "LdapFailure";
}

const connectTimeout = 10_000;
const pageTimeout = 60_000;

/** Entries a page holds, under Active Directory's 1,000. */
export const pageSize = 500;

const dropped =
  "The connection to the directory dropped. A run reads on one connection, so it stopped; the next run tries again.";

/** Rejects when `work` takes longer than `ms`, saying what it waited for. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new LdapFailure(`${what} took longer than ${String(ms / 1000)} seconds.`));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
  });
}

/** A TCP connection to the address checked. */
function connectTcp(address: string, port: number, ms: number, what: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LdapFailure(`No connection to ${what} within ${String(ms / 1000)} seconds.`));
    }, ms);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(new LdapFailure(`Could not reach ${what}: ${error.message}`));
    });
  });
}

/** Why a TLS connection's certificate is refused, or undefined when it is trusted. */
function untrusted(socket: TLSSocket, pinned: string | null): string | undefined {
  if (pinned !== null) {
    return socket.getPeerCertificate().fingerprint256 === pinned
      ? undefined
      : "The directory's certificate is not the one pinned.";
  }
  return socket.authorized
    ? undefined
    : `The directory's certificate is not trusted: ${String(socket.authorizationError)}`;
}

/** TLS over a connection already made, checked before it is used. */
function startTls(
  socket: Socket,
  options: ConnectionOptions,
  pinned: string | null,
  ms: number,
  what: string,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ ...options, socket });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new LdapFailure(`No TLS with ${what} within ${String(ms / 1000)} seconds.`));
    }, ms);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      const why = untrusted(secure, pinned);
      if (why !== undefined) {
        secure.destroy();
        reject(new LdapFailure(why));
        return;
      }
      secure.removeAllListeners("error");
      resolve(secure);
    });
    secure.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(new LdapFailure(`Could not reach ${what} by TLS: ${error.message}`));
    });
  });
}

/** What the bind's refusal says, for the console. */
function bindRefusal(error: unknown): LdapFailure {
  if (error instanceof ResultCodeError && error.code === 49) {
    return new LdapFailure("The directory refused the bind DN and password.");
  }
  const why = error instanceof Error ? error.message : String(error);
  return new LdapFailure(`The directory refused the bind: ${why}`);
}

/** A client bound to a directory, and what closes its connection. */
export interface OpenLdap {
  readonly client: Client;
  /** Unbinds, and closes the connection whatever the directory answers. */
  close(): Promise<void>;
}

/**
 * A client bound to the directory, over one encrypted connection to the
 * address its host was checked to resolve to. The caller closes it.
 */
export async function openLdap(
  settings: Pick<LdapSettings, "url" | "ca" | "fingerprint" | "bindDn">,
  password: string,
  reach: LdapReach,
): Promise<OpenLdap> {
  const address = addressOf(settings.url);
  const what = `${address.host}:${String(address.port)}`;
  const to = await checkedHost(address.host, {
    policy: reach.policy,
    ...(reach.resolve === undefined ? {} : { resolve: reach.resolve }),
    allowedBy: privateSetting,
  });
  if (typeof to === "string") throw new LdapFailure(to);
  const connectMs = reach.connectTimeout ?? connectTimeout;
  const timeout = reach.pageTimeout ?? pageTimeout;
  const pinned = settings.fingerprint;
  const tls: ConnectionOptions = {
    minVersion: "TLSv1.2",
    // A pinned certificate is checked by its fingerprint; every other one
    // by its authority and its name.
    rejectUnauthorized: pinned === null,
    ...(isIP(address.host) === 0 ? { servername: address.host } : {}),
    ...(settings.ca === null ? {} : { ca: settings.ca }),
  };

  const tcp = await connectTcp(to.address, address.port, connectMs, what);
  let secure: TLSSocket | undefined;
  const destroy = () => {
    secure?.destroy();
    tcp.destroy();
  };
  try {
    let client: Client;
    if (address.secure) {
      const ready = await startTls(tcp, tls, pinned, connectMs, what);
      secure = ready;
      let given = false;
      client = new Client({
        url: settings.url,
        timeout,
        createSecureConnection: () => {
          if (given) throw new LdapFailure(dropped);
          given = true;
          return ready;
        },
      });
    } else {
      // StartTLS: the client's first connection is this one, and its one
      // upgrade is checked here before the bind is sent.
      let connected = false;
      let refused: string | undefined;
      client = new Client({
        url: settings.url,
        timeout,
        createConnection: () => {
          if (connected) throw new LdapFailure(dropped);
          connected = true;
          return tcp;
        },
        createSecureConnection: (options?: unknown) => {
          const upgrade =
            typeof options === "object" && options !== null
              ? (options as ConnectionOptions)
              : undefined;
          if (secure !== undefined || upgrade?.socket === undefined) {
            throw new LdapFailure(dropped);
          }
          const made = tlsConnect(upgrade);
          secure = made;
          // Before the client hears of it: a certificate not trusted leaves
          // the connection closed, and the bind is never sent.
          made.once("secureConnect", () => {
            refused = untrusted(made, pinned);
            if (refused !== undefined) made.destroy();
          });
          return made;
        },
      });
      try {
        await within(client.startTLS({ ...tls }), connectMs, `StartTLS with ${what}`);
      } catch (error) {
        if (error instanceof LdapFailure) throw error;
        const why = error instanceof Error ? error.message : String(error);
        throw new LdapFailure(`Could not start TLS with ${what}: ${why}`);
      }
      if (refused !== undefined) throw new LdapFailure(refused);
    }
    try {
      await within(client.bind(settings.bindDn, password), timeout, "The bind");
    } catch (error) {
      throw error instanceof LdapFailure ? error : bindRefusal(error);
    }
    return {
      client,
      async close() {
        await within(client.unbind(), connectMs, "Unbinding").catch(() => undefined);
        destroy();
      },
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

/** Why a page of a search is refused: a referral, which Nether never follows. */
function referral(references: readonly string[]): LdapFailure {
  return new LdapFailure(
    `The directory sent a referral to ${references[0] ?? "another server"}, and Nether follows none. Set the base DN to where the entries are, as an organizational unit.`,
  );
}

/** What a failed search says, for the console. */
function searchFailure(error: unknown, what: string): LdapFailure {
  if (error instanceof LdapFailure) return error;
  const why = error instanceof Error ? error.message : String(error);
  return new LdapFailure(`Reading ${what} failed: ${why}`);
}

/** Every entry under `base` that `filter` finds, in pages; any error, referral or limit throws. */
export async function searchAll(
  client: Client,
  search: {
    readonly base: string;
    readonly filter: string;
    readonly attributes: readonly string[];
    readonly binary: readonly string[];
    readonly what: string;
  },
  stopped: () => boolean = () => false,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  try {
    const pages = client.searchPaginated(search.base, {
      scope: "sub",
      filter: search.filter,
      attributes: [...search.attributes],
      explicitBufferAttributes: [...search.binary],
      paged: { pageSize },
    });
    for await (const page of pages) {
      if (page.searchReferences.length > 0) throw referral(page.searchReferences);
      entries.push(...page.searchEntries);
      if (stopped()) throw new LdapFailure("The server stopped during the run.");
    }
  } catch (error) {
    throw searchFailure(error, search.what);
  }
  return entries;
}

/** A few entries under `base`, as testing a connection reads them. */
export async function searchSome(
  client: Client,
  search: {
    readonly base: string;
    readonly filter: string;
    readonly attributes: readonly string[];
    readonly binary: readonly string[];
    readonly what: string;
  },
  most: number,
): Promise<Entry[]> {
  try {
    const { searchEntries, searchReferences } = await client.search(search.base, {
      scope: "sub",
      filter: search.filter,
      attributes: [...search.attributes],
      explicitBufferAttributes: [...search.binary],
      sizeLimit: most,
    });
    if (searchReferences.length > 0) throw referral(searchReferences);
    return searchEntries.slice(0, most);
  } catch (error) {
    throw searchFailure(error, search.what);
  }
}

/** One entry by its DN, or undefined when there is none, as a group nested in a read one. */
export async function readEntry(
  client: Client,
  dn: string,
  attributes: readonly string[],
): Promise<Entry | undefined> {
  try {
    const { searchEntries, searchReferences } = await client.search(dn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: [...attributes],
    });
    if (searchReferences.length > 0) throw referral(searchReferences);
    return searchEntries[0];
  } catch (error) {
    // A DN a membership still names after its entry went.
    if (error instanceof ResultCodeError && error.code === 32) return undefined;
    throw searchFailure(error, dn);
  }
}
