// An account's personal access tokens (ADR 0059), as the app manages them
// with the account's session: listed, made with the password again, and
// revoked. A new token's secret is in the answer that makes it, and never
// again; the server keeps its hash and its last four characters.
import { t } from "./messages.ts";
import { ServerError, request } from "./server.ts";

type Fetch = typeof fetch;

/** A token as its owner sees it: never its secret. */
export interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly access: "read" | "write";
  /** Its last four characters. */
  readonly hint: string;
  /** The one workspace it reaches, or null for all of the account's. */
  readonly workspace: { readonly id: string; readonly name: string } | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly usedAt: string | null;
}

export interface NewApiToken {
  readonly name: string;
  readonly access: "read" | "write";
  readonly workspace?: string;
  readonly expiresInDays?: number;
  /** The account's password; an account without one leaves it out, within minutes of signing in. */
  readonly password?: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function odd(base: string): ServerError {
  return new ServerError(0, t("serverOddAnswer", { server: base }));
}

function text(value: unknown, base: string): string {
  if (typeof value !== "string") throw odd(base);
  return value;
}

function textOrNull(value: unknown, base: string): string | null {
  return value === null || value === undefined ? null : text(value, base);
}

function tokenOf(value: unknown, base: string): ApiToken {
  const token = record(value);
  const workspace = token.workspace === null ? null : record(token.workspace);
  return {
    id: text(token.id, base),
    name: text(token.name, base),
    access: token.access === "write" ? "write" : "read",
    hint: text(token.hint, base),
    workspace:
      workspace === null
        ? null
        : { id: text(workspace.id, base), name: text(workspace.name, base) },
    expiresAt: textOrNull(token.expiresAt, base),
    createdAt: text(token.createdAt, base),
    usedAt: textOrNull(token.usedAt, base),
  };
}

/** The account's tokens, the oldest first. */
export async function apiTokens(fetcher: Fetch, base: string, session: string) {
  const answer = record(await request(fetcher, base, "/api/tokens", { token: session }));
  const list = Array.isArray(answer.tokens) ? (answer.tokens as unknown[]) : [];
  return list.map((item) => tokenOf(item, base));
}

/** Makes a token; its secret is given this once. */
export async function makeApiToken(
  fetcher: Fetch,
  base: string,
  session: string,
  made: NewApiToken,
): Promise<{ readonly token: ApiToken; readonly secret: string }> {
  const answer = await request(fetcher, base, "/api/tokens", {
    token: session,
    body: {
      name: made.name,
      access: made.access,
      ...(made.workspace === undefined ? {} : { workspace: made.workspace }),
      ...(made.expiresInDays === undefined ? {} : { expiresInDays: made.expiresInDays }),
      ...(made.password === undefined || made.password === "" ? {} : { password: made.password }),
    },
  });
  return { token: tokenOf(answer, base), secret: text(record(answer).token, base) };
}

/** Revokes a token at once. */
export async function revokeApiToken(
  fetcher: Fetch,
  base: string,
  session: string,
  id: string,
): Promise<void> {
  await request(fetcher, base, `/api/tokens/${id}`, { method: "DELETE", token: session });
}
