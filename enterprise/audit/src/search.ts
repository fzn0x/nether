// Searching the audit log (ADR 0081): the newest events first, by an actor,
// an action or a group of them, a workspace, an outcome and a time, a page
// at a time by place in the log, so a page reads the same however many
// events come in meanwhile.
import type { Queryable } from "@nether/server/src/db.ts";
import { type AuditRow, rowOf } from "./log.ts";

/** The actions each group of the console's filter holds, as the requirement names them. */
export const actionGroups = {
  signIns: [
    "session.signed_in",
    "session.signed_out",
    "session.revoked",
    "account.created",
    "account.password_changed",
    "share_link.opened",
  ],
  permissions: [
    "member.joined",
    "member.role_changed",
    "member.removed",
    "member.left",
    "member.key_granted",
    "grant.set",
    "grant.removed",
    "teamspace.created",
    "teamspace.changed",
    "teamspace.deleted",
    "page.shared",
    "page.changed",
    "page.unshared",
    "private_space.created",
    "note.unit_changed",
    "workspace.created",
    "workspace.changed",
    "token.created",
    "instance.feature_changed",
  ],
  shares: [
    "share_link.created",
    "share_link.revoked",
    "site.published",
    "site.changed",
    "site.unpublished",
    "site.domain_set",
    "site.domain_removed",
    "workspace.publishing_changed",
    "invitation.created",
    "invitation.revoked",
    "invitation.accepted",
    "webhook.created",
    "webhook.changed",
    "webhook.deleted",
    "webhook.secret_changed",
  ],
  exports: [
    "note.read_by_api",
    "database.read_by_api",
    "search.read_by_api",
    "export.made",
    "backup.made",
  ],
  deletions: ["note.deleted", "workspace.deleted", "account.deleted", "token.revoked"],
  log: [
    "audit.destination_added",
    "audit.destination_changed",
    "audit.destination_removed",
    "audit.retention_changed",
    "audit.checked",
    "audit.purged",
    "audit.checkpoint",
    "audit.key_changed",
    "audit.export_gap",
  ],
} as const;

export type ActionGroup = keyof typeof actionGroups;

export function isActionGroup(name: string): name is ActionGroup {
  return Object.hasOwn(actionGroups, name);
}

/** What a search asks for: every filter is optional. */
export interface Filters {
  /** An account's or a share link's ID. */
  readonly actor?: string | undefined;
  /** An email, as an account had it, or as someone typed it to sign in; any case. */
  readonly email?: string | undefined;
  readonly action?: string | undefined;
  readonly group?: ActionGroup | undefined;
  readonly workspace?: string | undefined;
  readonly outcome?: "success" | "failure" | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Events before this place in the log, for the next page. */
  readonly before?: number | undefined;
  readonly limit: number;
}

/** A page of events, and the place to ask before for the next; none at the last. */
export async function searchLog(
  db: Queryable,
  filters: Filters,
): Promise<{ readonly events: AuditRow[]; readonly next: number | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (place: string) => string, value: unknown) => {
    params.push(value);
    where.push(clause(`$${String(params.length)}`));
  };
  if (filters.actor !== undefined) add((at) => `actor_id = ${at}`, filters.actor.toLowerCase());
  if (filters.email !== undefined) {
    add((at) => `lower(actor_email) = ${at}`, filters.email.trim().toLowerCase());
  }
  if (filters.action !== undefined) add((at) => `action = ${at}`, filters.action);
  if (filters.group !== undefined) {
    add((at) => `action = ANY(${at}::text[])`, [...actionGroups[filters.group]]);
  }
  if (filters.workspace !== undefined) {
    add((at) => `workspace_id = ${at}`, filters.workspace.toLowerCase());
  }
  if (filters.outcome !== undefined) add((at) => `outcome = ${at}`, filters.outcome);
  if (filters.from !== undefined) add((at) => `at >= ${at}`, filters.from.toISOString());
  if (filters.to !== undefined) add((at) => `at < ${at}`, filters.to.toISOString());
  if (filters.before !== undefined) add((at) => `seq < ${at}`, filters.before);
  params.push(filters.limit + 1);
  const { rows } = await db.query(
    `SELECT * FROM audit_events ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY seq DESC LIMIT $${String(params.length)}`,
    params,
  );
  const events = rows.slice(0, filters.limit).map(rowOf);
  const next = rows.length > filters.limit ? (events.at(-1)?.seq ?? null) : null;
  return { events, next };
}

/** An event as the console shows it: never its hashes. */
export function shownEvent(row: AuditRow) {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    action: row.action,
    outcome: row.outcome,
    reason: row.reason,
    actor: {
      type: row.actorType,
      id: row.actorId,
      name: row.actorName,
      email: row.actorEmail,
      token: row.tokenId === null ? null : { id: row.tokenId, name: row.tokenName },
    },
    workspace: row.workspaceId === null ? null : { id: row.workspaceId, name: row.workspaceName },
    target:
      row.targetType === null
        ? null
        : { type: row.targetType, id: row.targetId, name: row.targetName },
    address: row.address,
    userAgent: row.userAgent,
    details: row.details,
  };
}
