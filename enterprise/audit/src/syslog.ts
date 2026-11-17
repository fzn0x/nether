// The audit log by syslog (ADR 0081): RFC 5424 messages over TLS, framed by
// their length in octets as RFC 5425 has it. Facility 13, log audit;
// severity 5, notice, or 4, warning, for a failure. TIMESTAMP is the
// event's time, HOSTNAME the server's, APP-NAME `nether`, MSGID the action,
// the structured data the registered `origin` element, and MSG the event as
// JSON after the byte order mark RFC 5424 asks of UTF-8. No plain TCP and
// no UDP: TLS 1.2 or later, the server checked against the system's
// authorities, one the admin gives, or a pinned SHA-256 fingerprint.
import { readFileSync } from "node:fs";
import { type TLSSocket, connect } from "node:tls";

/** The port RFC 5425 gives syslog over TLS. */
export const syslogPort = 6514;

/** Facility 13, log audit (RFC 5424, section 6.2.1). */
const facility = 13;

/** RFC 5424's UTF-8 byte order mark, before a MSG in UTF-8; made here, not written in the source. */
const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);

/** A syslog destination's host and port, from `host`, `host:port` or `[v6]:port`. */
export function syslogAddress(text: string): { readonly host: string; readonly port: number } {
  const trimmed = text.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  const plain = /^([^:\s/]+)(?::(\d+))?$/.exec(trimmed);
  const found = bracketed ?? plain;
  const host = found?.[1];
  if (found === null || host === undefined || host === "") {
    throw new Error(
      "A syslog destination is a host, with its port if not 6514, as siem.example.org:6514.",
    );
  }
  const port = found[2] === undefined ? syslogPort : Number(found[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("A syslog destination's port is from 1 to 65535.");
  }
  return { host, port };
}

/** A SHA-256 fingerprint as Node gives it: upper-case hex pairs joined by colons. */
export function fingerprintOf(text: string): string {
  const hex = text.replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new Error("A certificate's SHA-256 fingerprint is 64 hex digits, colons allowed.");
  }
  return hex.match(/../g)?.join(":") ?? hex;
}

/** RFC 5424's PRINTUSASCII, 1 to `max` characters, or the nil value. */
function printable(text: string, max: number): string {
  const kept = text.replace(/[^\x21-\x7e]/g, "").slice(0, max);
  return kept === "" ? "-" : kept;
}

/** A structured data parameter's value, with `"`, `\` and `]` escaped (RFC 5424, section 6.3.3). */
function paramValue(text: string): string {
  return text.replace(/["\\\]]/g, "\\$&");
}

/** What a message tells of an event. */
export interface SyslogEvent {
  readonly at: string;
  readonly action: string;
  readonly outcome: "success" | "failure";
  /** The event as JSON, the message's MSG. */
  readonly json: string;
}

/** One RFC 5424 message, framed by its length in octets for RFC 5425. */
export function syslogFrame(event: SyslogEvent, host: string, version: string): Buffer {
  const severity = event.outcome === "failure" ? 4 : 5;
  const header = [
    `<${String(facility * 8 + severity)}>1`,
    event.at,
    printable(host, 255),
    "nether",
    "-",
    printable(event.action, 32),
    `[origin software="nether" swVersion="${paramValue(version)}"]`,
  ].join(" ");
  const message = Buffer.concat([
    Buffer.from(`${header} `, "utf8"),
    byteOrderMark,
    Buffer.from(event.json, "utf8"),
  ]);
  return Buffer.concat([Buffer.from(`${String(message.length)} `, "ascii"), message]);
}

/** How a syslog destination's server is trusted. */
export interface SyslogTrust {
  /** A certificate authority in PEM to trust, beside none of the system's. */
  readonly ca?: string | undefined;
  /** The server certificate's SHA-256 fingerprint, trusted whoever signed it. */
  readonly fingerprint?: string | undefined;
}

/** The client certificate for mutual TLS, from the files NETHER_AUDIT_SYSLOG_CERT and _KEY name. */
export interface ClientCertificate {
  readonly cert: Buffer;
  readonly key: Buffer;
}

/** The client certificate the environment names, if it names one; both files or neither. */
export function clientCertificate(env: NodeJS.ProcessEnv): ClientCertificate | undefined {
  const cert = env.NETHER_AUDIT_SYSLOG_CERT?.trim() ?? "";
  const key = env.NETHER_AUDIT_SYSLOG_KEY?.trim() ?? "";
  if (cert === "" && key === "") return undefined;
  if (cert === "" || key === "") {
    throw new Error(
      "NETHER_AUDIT_SYSLOG_CERT and NETHER_AUDIT_SYSLOG_KEY name a certificate and its key together.",
    );
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

/**
 * A connection to a syslog server, kept open between batches. A batch is
 * taken once it is written and the connection still stands; after a break
 * it is sent again in full, so a SIEM may see an event twice and drops it
 * by its `id` (RFC 5425 has no acknowledgements).
 */
export class SyslogConnection {
  readonly #socket: TLSSocket;
  #broken: Error | undefined;

  private constructor(socket: TLSSocket) {
    this.#socket = socket;
    socket.on("error", (error) => {
      this.#broken ??= error;
    });
    socket.on("close", () => {
      this.#broken ??= new Error("The syslog server closed the connection.");
    });
    // A syslog server sends nothing back: anything it does is read and dropped.
    socket.resume();
  }

  /** Connects, checked as `trust` says; rejects within `timeout` milliseconds. */
  static open(
    address: { readonly host: string; readonly port: number },
    trust: SyslogTrust,
    client: ClientCertificate | undefined,
    timeout = 10_000,
  ): Promise<SyslogConnection> {
    return new Promise((resolve, reject) => {
      const pinned = trust.fingerprint === undefined ? undefined : fingerprintOf(trust.fingerprint);
      const socket = connect({
        host: address.host,
        port: address.port,
        servername: /^[\d.]+$|:/.test(address.host) ? undefined : address.host,
        minVersion: "TLSv1.2",
        // A pinned certificate is checked by its fingerprint, below.
        rejectUnauthorized: pinned === undefined,
        ...(trust.ca === undefined ? {} : { ca: trust.ca }),
        ...(client === undefined ? {} : { cert: client.cert, key: client.key }),
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `No TLS connection to ${address.host}:${String(address.port)} within ${String(timeout / 1000)} seconds.`,
          ),
        );
      }, timeout);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        if (pinned !== undefined && socket.getPeerCertificate().fingerprint256 !== pinned) {
          socket.destroy();
          reject(new Error("The syslog server's certificate is not the one pinned."));
          return;
        }
        resolve(new SyslogConnection(socket));
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Could not reach ${address.host}:${String(address.port)} by TLS: ${error.message}`,
          ),
        );
      });
    });
  }

  /** Whether the connection still stands. */
  get open(): boolean {
    return this.#broken === undefined && !this.#socket.destroyed;
  }

  /** Writes a batch of frames; resolves once written, the connection still standing. */
  write(frames: readonly Buffer[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(this.#broken ?? new Error("The connection is closed."));
        return;
      }
      this.#socket.write(Buffer.concat(frames), (error) => {
        if (error !== undefined && error !== null) reject(error);
        else if (!this.open) reject(this.#broken ?? new Error("The connection broke."));
        else resolve();
      });
    });
  }

  close(): void {
    this.#socket.end();
    this.#socket.destroy();
  }
}
