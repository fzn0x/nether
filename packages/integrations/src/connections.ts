// A connection as the app keeps it (ADR 0090): what a plugin may see of it,
// the origins its requests may reach, and its secret apart, as the
// keychain or the server keeps it.
import { type Connection, type Service, isService } from "@nether/plugin-api";

/** A connection as the app keeps it, without its secret. */
export interface KeptConnection {
  readonly id: string;
  readonly service: Service;
  /** What the person calls it. */
  readonly name: string;
  /** Who it acts as at the service; empty when the service does not say. */
  readonly account: string;
  /**
   * The base address its requests go under. For a feed whose address is
   * its secret, the host alone; the whole address is in the secret.
   */
  readonly address: string;
  /** The service's web host, for links to it; empty when none. */
  readonly web: string;
  /** The origins its requests may reach, as `https://calendar.example.org`. */
  readonly origins: readonly string[];
}

/** What a connection keeps secret, as the keychain holds it, in JSON. */
export interface ConnectionSecret {
  /** The whole address requests resolve against, when it is secret, as an ICS feed's. */
  readonly address?: string;
  /** For Basic authentication. */
  readonly user?: string;
  readonly password?: string;
  /** For `Authorization: Bearer`. */
  readonly token?: string;
}

/** A secret as kept, read; what does not read is no secret. */
export function readSecret(text: string | undefined): ConnectionSecret {
  if (text === undefined || text === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const { address, user, password, token } = value as Readonly<Record<string, unknown>>;
  return {
    ...(typeof address === "string" ? { address } : {}),
    ...(typeof user === "string" ? { user } : {}),
    ...(typeof password === "string" ? { password } : {}),
    ...(typeof token === "string" ? { token } : {}),
  };
}

/** A secret as it is kept. */
export function writeSecret(secret: ConnectionSecret): string {
  return JSON.stringify(secret);
}

/** A kept connection as a plugin sees it, from this device or the account's server. */
export function shownConnection(
  connection: KeptConnection,
  where: Connection["where"],
): Connection {
  return {
    id: connection.id,
    service: connection.service,
    name: connection.name,
    address: connection.address,
    where,
    ...(connection.account === "" ? {} : { account: connection.account }),
    ...(connection.web === "" ? {} : { web: connection.web }),
  };
}

/** Kept connections as a store gives them; any that do not read are left out. */
export function readKeptConnections(value: unknown): KeptConnection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each: unknown): KeptConnection[] => {
    if (typeof each !== "object" || each === null) return [];
    const { id, service, name, account, address, web, origins } = each as Readonly<
      Record<string, unknown>
    >;
    if (
      typeof id !== "string" ||
      !isService(service) ||
      typeof name !== "string" ||
      typeof address !== "string" ||
      !Array.isArray(origins)
    ) {
      return [];
    }
    return [
      {
        id,
        service,
        name,
        account: typeof account === "string" ? account : "",
        address,
        web: typeof web === "string" ? web : "",
        origins: origins.filter((origin): origin is string => typeof origin === "string"),
      },
    ];
  });
}
