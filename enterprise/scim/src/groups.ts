// A SCIM directory's groups, read (ADR 0085): each with its members, the
// directory's accounts. Entra ID's test connection looks one up by a
// random name, as it does a user; making and changing groups, and the
// places they give in workspaces, come with the next part.
import { type Queryable, readText, readTextOrNull, readTime } from "@nether/server/src/db.ts";
import { ScimError } from "./errors.ts";
import { type Comparison, coreGroupSchema } from "./paths.ts";

export interface GroupRow {
  readonly id: string;
  readonly name: string;
  readonly externalId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MemberRef {
  readonly value: string;
  readonly display: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const filterable = "Nether filters groups by id, displayName, externalId and members.value.";

function rowOf(row: Record<string, unknown>): GroupRow {
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    externalId: readTextOrNull(row, "external_id"),
    createdAt: readTime(row, "created_at"),
    updatedAt: readTime(row, "updated_at"),
  };
}

/** A filter's comparisons as SQL over `g`, the group. */
function groupFilter(comparisons: readonly Comparison[], params: unknown[]): string {
  const parts: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${String(params.length)}`;
  };
  for (const { path, value } of comparisons) {
    const plain = path.filter === undefined && path.sub === undefined;
    if (path.schema === "enterprise" || path.schema === "other" || typeof value !== "string") {
      throw new ScimError(400, filterable, "invalidFilter");
    }
    if (path.attr === "id" && plain) parts.push(`g.id::text = lower(${add(value)})`);
    else if (path.attr === "displayname" && plain) {
      parts.push(`lower(g.name) = lower(${add(value)})`);
    } else if (path.attr === "externalid" && plain) parts.push(`g.external_id = ${add(value)}`);
    else if (path.attr === "members" && path.sub === "value" && path.filter === undefined) {
      parts.push(
        `EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id
                    AND gm.user_id::text = lower(${add(value)}))`,
      );
    } else throw new ScimError(400, filterable, "invalidFilter");
  }
  return parts.length === 0 ? "true" : parts.join(" AND ");
}

/** A page of a directory's groups, in the order they were made. */
export async function listGroups(
  db: Queryable,
  directory: string,
  comparisons: readonly Comparison[],
  startIndex: number,
  count: number,
): Promise<{ readonly total: number; readonly rows: GroupRow[] }> {
  const params: unknown[] = [directory];
  const from = `FROM groups g WHERE g.directory_id = $1 AND ${groupFilter(comparisons, params)}`;
  const counted = await db.query(`SELECT count(*)::int AS total ${from}`, params);
  const total = Number(counted.rows[0]?.total ?? 0);
  if (count === 0) return { total, rows: [] };
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.external_id, g.created_at, g.updated_at ${from}
      ORDER BY g.created_at, g.id OFFSET ${String(startIndex - 1)} LIMIT ${String(count)}`,
    params,
  );
  return { total, rows: rows.map(rowOf) };
}

export async function findGroup(
  db: Queryable,
  directory: string,
  id: string,
): Promise<GroupRow | undefined> {
  if (!uuid.test(id)) return undefined;
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.external_id, g.created_at, g.updated_at FROM groups g
      WHERE g.directory_id = $1 AND g.id = $2`,
    [directory, id.toLowerCase()],
  );
  return rows[0] === undefined ? undefined : rowOf(rows[0]);
}

/** Each group's members, by their accounts' IDs and names. */
export async function membersOf(
  db: Queryable,
  groups: readonly string[],
): Promise<Map<string, MemberRef[]>> {
  const found = new Map<string, MemberRef[]>();
  if (groups.length === 0) return found;
  const { rows } = await db.query(
    `SELECT gm.group_id, u.id, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ANY($1::uuid[]) ORDER BY gm.created_at, u.id`,
    [groups],
  );
  for (const row of rows) {
    const group = readText(row, "group_id");
    const list = found.get(group) ?? [];
    list.push({ value: readText(row, "id"), display: readText(row, "name") });
    found.set(group, list);
  }
  return found;
}

/** A group as SCIM gives it back. */
export function groupResource(
  row: GroupRow,
  members: readonly MemberRef[],
  base: string | null,
): Record<string, unknown> {
  return {
    schemas: [coreGroupSchema],
    id: row.id,
    ...(row.externalId === null ? {} : { externalId: row.externalId }),
    displayName: row.name,
    members: members.map((member) => ({
      value: member.value,
      display: member.display,
      ...(base === null ? {} : { $ref: `${base}/Users/${member.value}` }),
    })),
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      ...(base === null ? {} : { location: `${base}/Groups/${row.id}` }),
    },
  };
}
