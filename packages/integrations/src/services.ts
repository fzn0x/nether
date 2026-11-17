// The services connections reach, as far as this part of ADR 0090 builds
// them: ICS feeds. Each says how a connection to it is made from what the
// person types, and how the app checks one before keeping it.
import type { ConnectionSecret, KeptConnection } from "./connections.ts";
import { RequestRefused, sendRequest } from "./requests.ts";

/** What the person types for an ICS feed. */
export interface FeedInput {
  readonly id: string;
  readonly name: string;
  /** The feed's address, read by `readAddress`. */
  readonly url: URL;
  /** For a feed behind Basic authentication; most need none, their address being their secret. */
  readonly user?: string;
  readonly password?: string;
}

/**
 * An ICS feed's connection: shown by its host alone, since a feed's
 * address, as Google Calendar's secret address, is often its secret, and
 * reaching that host's origin.
 */
export function feedConnection(input: FeedInput): {
  readonly connection: KeptConnection;
  readonly secret: ConnectionSecret;
} {
  const user = input.user?.trim() ?? "";
  return {
    connection: {
      id: input.id,
      service: "ics",
      name: input.name.trim() === "" ? input.url.host : input.name.trim(),
      account: user,
      address: input.url.host,
      web: "",
      origins: [input.url.origin],
    },
    secret: {
      address: input.url.href,
      ...(user === "" ? {} : { user, password: input.password ?? "" }),
    },
  };
}

/** Why a connection did not check: an answer that is not a success, one that is not a calendar, or a request that failed. */
export type CheckProblem =
  | { readonly problem: "status"; readonly status: number }
  | { readonly problem: "notCalendar" }
  | { readonly problem: "unreachable"; readonly message: string };

/** Whether text is an iCalendar file, as a feed gives one. */
export function isCalendar(text: string): boolean {
  return /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 1024));
}

/** Checks a connection before the app keeps it; undefined when it works. */
export async function checkConnection(
  connection: KeptConnection,
  secret: ConnectionSecret,
  fetch: typeof globalThis.fetch,
  http: boolean,
): Promise<CheckProblem | undefined> {
  try {
    const answer = await sendRequest({
      connection,
      secret,
      request: { connection: connection.id, url: "", method: "GET", headers: {}, as: "text" },
      fetch,
      http,
    });
    if (answer.status < 200 || answer.status > 299) {
      return { problem: "status", status: answer.status };
    }
    return isCalendar(answer.text ?? "") ? undefined : { problem: "notCalendar" };
  } catch (error) {
    return {
      problem: "unreachable",
      message: error instanceof RequestRefused ? error.message : "The request failed.",
    };
  }
}
