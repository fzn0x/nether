// The directories an instance admin adds on the console's Directories page
// (ADR 0085): each by a short name of the admin's, which its SCIM address
// carries, with the email domains it speaks for, one directory at most
// each, and whether it may make accounts at other domains. A SCIM
// directory has one bearer token at a time, kept as its SHA-256 with its
// last characters to tell it by, and it ends: a year unless the admin
// picks another length, two at most.
import { randomBytes } from "node:crypto";
import {
  type Queryable,
  readBoolean,
  readText,
  readTextOrNull,
  readTime,
} from "@nether/server/src/db.ts";
import { tokenHash } from "@nether/server/src/sessions.ts";

export type DirectoryKind = "scim" | "ldap";

export interface Directory {
  readonly id: string;
  readonly kind: DirectoryKind;
  readonly name: string;
  readonly domains: readonly string[];
  /** Whether it may make accounts at addresses outside its domains. */
  readonly otherDomains: boolean;
  /** Its token, by its last characters, and when it ends; none until one is made. */
  readonly token: { readonly hint: string; readonly expiresAt: Date } | null;
  readonly createdAt: Date;
}

/** A directory's short name: lowercase letters, digits and hyphens, as Okta's base address takes no underscore. */
export const directoryIdPattern = "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$";

/** What a SCIM token starts with, so it is told from the server's other tokens. */
export const tokenPrefix = "nether_scim_";

/** Days a token lasts unless the admin picks another length, and the most it may. */
export const tokenDays = 365;
export const mostTokenDays = 730;

const domainLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const domainPattern = new RegExp(`^(?=.{1,253}$)(?:${domainLabel}\\.)+${domainLabel}$`);

/** An email domain as kept: trimmed and lowercase, or undefined when it is not one. */
export function domainOf(text: string): string | undefined {
  const domain = text.trim().toLowerCase().replace(/^@/, "");
  return domainPattern.test(domain) ? domain : undefined;
}

/** The domain of an address, lowercase. */
export function addressDomain(email: string): string {
  return (email.split("@").at(-1) ?? "").toLowerCase();
}

/** A new token: the prefix and 32 random bytes, shown once. */
export function newDirectoryToken(): string {
  return `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
}

const columns = `d.id, d.kind, d.name, d.other_domains, d.token_hint, d.token_expires_at,
  d.created_at,
  coalesce((SELECT array_agg(domain ORDER BY domain) FROM directory_domains
             WHERE directory_id = d.id), '{}') AS domains`;

function directoryOf(row: Record<string, unknown>): Directory {
  const hint = readTextOrNull(row, "token_hint");
  const domains = Array.isArray(row.domains) ? row.domains.map(String) : [];
  return {
    id: readText(row, "id"),
    kind: readText(row, "kind") === "ldap" ? "ldap" : "scim",
    name: readText(row, "name"),
    domains,
    otherDomains: readBoolean(row, "other_domains"),
    token:
      hint === null || row.token_expires_at === null
        ? null
        : { hint, expiresAt: readTime(row, "token_expires_at") },
    createdAt: readTime(row, "created_at"),
  };
}

export async function listDirectories(db: Queryable): Promise<Directory[]> {
  const { rows } = await db.query(
    `SELECT ${columns} FROM directories d ORDER BY lower(d.name), d.id`,
  );
  return rows.map(directoryOf);
}

/** A directory, locked until the transaction ends when `lock` says so. */
export async function findDirectory(
  db: Queryable,
  id: string,
  lock = false,
): Promise<Directory | undefined> {
  const { rows } = await db.query(
    `SELECT ${columns} FROM directories d WHERE d.id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] === undefined ? undefined : directoryOf(rows[0]);
}

/** The SCIM directory a bearer token is, at its own address, while the token lasts. */
export async function directoryByToken(
  db: Queryable,
  id: string,
  token: string,
): Promise<Directory | undefined> {
  const { rows } = await db.query(
    `SELECT ${columns} FROM directories d
      WHERE d.id = $1 AND d.kind = 'scim' AND d.token_hash = $2 AND d.token_expires_at > now()`,
    [id, tokenHash(token)],
  );
  return rows[0] === undefined ? undefined : directoryOf(rows[0]);
}

/** The directory a domain belongs to, if one does. */
export async function domainOwner(db: Queryable, domain: string): Promise<string | undefined> {
  const { rows } = await db.query("SELECT directory_id FROM directory_domains WHERE domain = $1", [
    domain,
  ]);
  return rows[0] === undefined ? undefined : readText(rows[0], "directory_id");
}

/** Sets a directory's domains, replacing those it had. */
export async function setDomains(
  tx: Queryable,
  id: string,
  domains: readonly string[],
): Promise<void> {
  await tx.query("DELETE FROM directory_domains WHERE directory_id = $1", [id]);
  for (const domain of domains) {
    await tx.query("INSERT INTO directory_domains (domain, directory_id) VALUES ($1, $2)", [
      domain,
      id,
    ]);
  }
}

/** How many accounts a directory manages, and how many of those are deactivated. */
export async function accountCounts(
  db: Queryable,
  id: string,
): Promise<{ readonly accounts: number; readonly deactivated: number }> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS accounts,
            count(*) FILTER (WHERE u.deactivated_at IS NOT NULL)::int AS deactivated
       FROM directory_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.directory_id = $1`,
    [id],
  );
  return {
    accounts: Number(rows[0]?.accounts ?? 0),
    deactivated: Number(rows[0]?.deactivated ?? 0),
  };
}
