// The console's Workspaces page (ADR 0083): every workspace on the server,
// with its owners, its members by role, its notes and its size, counted
// when the page asks; a workspace's members; and an instance admin setting
// a member's role, by the server's own rules. It reads no note's title or
// text. An account a directory deactivated shows as such (ADR 0085).
import {
  type Database,
  type Row,
  readBoolean,
  readCount,
  readText,
  readTime,
} from "@nether/server/src/db.ts";

/** How many workspaces a page of the list holds. */
export const pageSize = 50;

/** A workspace's owner, as the list names them. */
export interface Owner {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** Whether the account is deactivated, so it signs in no way. */
  readonly deactivated: boolean;
}

/** A workspace as the console lists it. */
export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly encryption: "none" | "end-to-end";
  readonly createdAt: string;
  readonly owners: readonly Owner[];
  /** Its owners whose accounts are not deactivated: none marks it No active owner (ADR 0085). */
  readonly activeOwners: number;
  /** How many of its members have each role. */
  readonly roles: {
    readonly owner: number;
    readonly admin: number;
    readonly member: number;
    readonly guest: number;
  };
  /** Its notes, where the server can read them: null for an encrypted workspace. */
  readonly notes: number | null;
  /** Its bytes, from the rows' lengths: its documents, their history, and its attachments. */
  readonly bytes: {
    readonly documents: number;
    readonly history: number;
    readonly attachments: number;
  };
  readonly attachments: number;
  /** When a document in it last changed, if one has. */
  readonly changedAt: string | null;
}

/** A member of a workspace, as its page in the console shows them. */
export interface WorkspaceMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly joinedAt: string;
  /** Whether the account is deactivated, so it signs in no way. */
  readonly deactivated: boolean;
}

/** A page of the list, and the cursor for the next, if there is one. */
export interface WorkspacePage {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly next: string | null;
}

/** Where a page starts: after the workspace with this sort name and ID. */
interface Cursor {
  readonly name: string;
  readonly id: string;
}

/** The cursor a page gives for the next, opaque to the page. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id])).toString("base64url");
}

/** A cursor from a page's `next`, or undefined when it is not one. */
export function decodeCursor(text: string): Cursor | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      /^[0-9a-f-]{36}$/.test(value[1])
    ) {
      return { name: value[0], id: value[1] };
    }
  } catch {
    // Not base64url JSON: not a cursor.
  }
  return undefined;
}

// Each workspace with what the list shows. Its counts and bytes come from
// the rows, never their contents: octet_length reads a value's length
// without reading the value. A note's document is named by its ID: the
// vaults' documents and the notes' comments are not notes.
const summaries = String.raw`
  SELECT w.id, w.name, lower(w.name) AS sort_name, w.encryption, w.created_at,
         o.owners, o.active_owners, r.owner, r.admin, r.member, r.guest,
         d.notes, d.bytes + e.bytes AS document_bytes, v.bytes AS history_bytes,
         a.count AS attachments, a.bytes AS attachment_bytes,
         greatest(d.changed_at, e.changed_at) AS changed_at
    FROM workspaces w
    CROSS JOIN LATERAL (
      SELECT coalesce(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email,
                                                 'deactivated', u.deactivated_at IS NOT NULL)
                               ORDER BY lower(u.name), lower(u.email)), '[]'::json) AS owners,
             count(*) FILTER (WHERE u.deactivated_at IS NULL) AS active_owners
        FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = w.id AND m.role = 'owner'
    ) o
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.role = 'owner') AS owner,
             count(*) FILTER (WHERE m.role = 'admin') AS admin,
             count(*) FILTER (WHERE m.role = 'member') AS member,
             count(*) FILTER (WHERE m.role = 'guest') AS guest
        FROM memberships m WHERE m.workspace_id = w.id
    ) r
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE doc.name !~ '^vault' AND doc.name !~ '\.comments$') AS notes,
             coalesce(sum(octet_length(doc.state)), 0)::bigint AS bytes,
             max(doc.updated_at) AS changed_at
        FROM documents doc WHERE doc.workspace_id = w.id
    ) d
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(octet_length(up.data)), 0)::bigint AS bytes,
             max(up.created_at) AS changed_at
        FROM encrypted_updates up WHERE up.workspace_id = w.id
    ) e
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(octet_length(ver.state)), 0)::bigint AS bytes
        FROM document_versions ver WHERE ver.workspace_id = w.id
    ) v
    CROSS JOIN LATERAL (
      SELECT count(*) AS count, coalesce(sum(att.size), 0)::bigint AS bytes
        FROM attachments att WHERE att.workspace_id = w.id
    ) a`;

function owners(value: unknown): Owner[] {
  // node-postgres and PGlite both give json as parsed values.
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((owner) => {
    const row = typeof owner === "object" && owner !== null ? (owner as Row) : undefined;
    return {
      id: readText(row, "id"),
      name: readText(row, "name"),
      email: readText(row, "email"),
      deactivated: readBoolean(row, "deactivated"),
    };
  });
}

function summary(row: Row): WorkspaceSummary {
  const encryption = readText(row, "encryption") === "end-to-end" ? "end-to-end" : "none";
  const changed = row.changed_at;
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    encryption,
    createdAt: readTime(row, "created_at").toISOString(),
    owners: owners(row.owners),
    activeOwners: readCount(row, "active_owners"),
    roles: {
      owner: readCount(row, "owner"),
      admin: readCount(row, "admin"),
      member: readCount(row, "member"),
      guest: readCount(row, "guest"),
    },
    notes: encryption === "end-to-end" ? null : readCount(row, "notes"),
    bytes: {
      documents: readCount(row, "document_bytes"),
      history: readCount(row, "history_bytes"),
      attachments: readCount(row, "attachment_bytes"),
    },
    attachments: readCount(row, "attachments"),
    changedAt: changed instanceof Date ? changed.toISOString() : null,
  };
}

/**
 * A page of the server's workspaces, by name, after `after` when given. A
 * search finds a workspace by its name, or by a member's name or email;
 * `ownerless` keeps those with no active owner, whose owners left or were
 * deactivated, for an instance admin to give one (ADR 0085).
 */
export async function listWorkspaces(
  db: Database,
  options: {
    readonly search?: string;
    readonly after?: Cursor;
    readonly ownerless?: boolean;
  } = {},
): Promise<WorkspacePage> {
  const search = options.search?.trim() ?? "";
  const { rows } = await db.query(
    `${summaries}
      WHERE ($1 = '' OR strpos(lower(w.name), lower($1)) > 0
             OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                         WHERE m.workspace_id = w.id
                           AND (strpos(lower(u.name), lower($1)) > 0
                                OR strpos(lower(u.email), lower($1)) > 0)))
        AND ($2::text IS NULL OR (lower(w.name), w.id) > ($2::text, $3::uuid))
        AND (NOT $4::boolean OR o.active_owners = 0)
      ORDER BY lower(w.name), w.id
      LIMIT ${String(pageSize + 1)}`,
    [search, options.after?.name ?? null, options.after?.id ?? null, options.ownerless === true],
  );
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    workspaces: page.map(summary),
    next:
      rows.length > pageSize && last !== undefined
        ? encodeCursor({ name: readText(last, "sort_name"), id: readText(last, "id") })
        : null,
  };
}

/** One workspace, with its members, or undefined when there is none such. */
export async function workspaceWithMembers(
  db: Database,
  id: string,
): Promise<{ workspace: WorkspaceSummary; members: WorkspaceMember[] } | undefined> {
  const { rows } = await db.query(`${summaries} WHERE w.id = $1`, [id]);
  const row = rows[0];
  if (row === undefined) return undefined;
  const members = await db.query(
    `SELECT u.id, u.name, u.email, m.role, m.created_at,
            u.deactivated_at IS NOT NULL AS deactivated
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY lower(u.name), lower(u.email)`,
    [id],
  );
  return {
    workspace: summary(row),
    members: members.rows.map((member) => ({
      id: readText(member, "id"),
      name: readText(member, "name"),
      email: readText(member, "email"),
      role: readText(member, "role"),
      joinedAt: readTime(member, "created_at").toISOString(),
      deactivated: readBoolean(member, "deactivated"),
    })),
  };
}
