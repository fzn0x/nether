// Webhooks' outbox (ADR 0060): the notes made, changed and removed in a
// workspace with a webhook, found as their documents are stored, in the
// same transaction, so a change is never told for a store that rolled
// back, nor lost by a crash after one. A burst of changes to one note is
// one row, told 30 seconds after its last store and at most five minutes
// after its first. When it is due, it becomes an event for each webhook
// that listens to it and whose maker opens the note's unit then: the
// note's ID, path and title, never its text.
import { randomUUID } from "node:crypto";
import { type Database, type Queryable, readText, readTime } from "./db.ts";
import { pathsOf, titleOf } from "./search.ts";
import { type Level, accessible, general, unitOfDocument } from "./units.ts";

export type ChangeKind = "created" | "updated" | "deleted";

export const eventTypes = ["note.created", "note.updated", "note.deleted"] as const;
export type EventType = (typeof eventTypes)[number];

/** How long a note's change waits after its last store, and at most after its first. */
const quiet = "30 seconds";
const longest = "5 minutes";

/** Whether a workspace has a webhook that is on, so its stores are watched. */
export async function hasWebhooks(db: Queryable, workspaceId: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM webhooks WHERE workspace_id = $1 AND enabled LIMIT 1",
    [workspaceId],
  );
  return rows.length > 0;
}

/**
 * What one note's changes come to, the one waiting and the next: made then
 * changed is made; changed then removed is removed; made then removed is
 * nothing (null); removed then made, as a note restored, is changed.
 */
export function fold(waiting: ChangeKind | undefined, next: ChangeKind): ChangeKind | null {
  if (waiting === undefined) return next;
  if (waiting === "created") return next === "deleted" ? null : "created";
  if (waiting === "updated") return next === "deleted" ? "deleted" : "updated";
  return next === "created" ? "updated" : "deleted";
}

function isKind(value: unknown): value is ChangeKind {
  return value === "created" || value === "updated" || value === "deleted";
}

/** Keeps a note's change in the outbox, folded into the one waiting, if any. */
async function keep(
  tx: Queryable,
  workspaceId: string,
  note: string,
  kind: ChangeKind,
  path: string,
): Promise<void> {
  const { rows } = await tx.query(
    "SELECT kind FROM webhook_changes WHERE workspace_id = $1 AND note = $2 FOR UPDATE",
    [workspaceId, note],
  );
  const waiting = rows[0]?.kind;
  const folded = fold(isKind(waiting) ? waiting : undefined, kind);
  if (folded === null) {
    await tx.query("DELETE FROM webhook_changes WHERE workspace_id = $1 AND note = $2", [
      workspaceId,
      note,
    ]);
    return;
  }
  await tx.query(
    `INSERT INTO webhook_changes (workspace_id, note, kind, path, first_at, last_at, due_at)
     VALUES ($1, $2, $3, $4, now(), now(), now() + interval '${quiet}')
     ON CONFLICT (workspace_id, note) DO UPDATE SET
       kind = excluded.kind,
       path = CASE WHEN excluded.path <> '' THEN excluded.path ELSE webhook_changes.path END,
       last_at = now(),
       due_at = LEAST(now() + interval '${quiet}', webhook_changes.first_at + interval '${longest}')`,
    [workspaceId, note, folded, path],
  );
}

/**
 * Keeps the changes a unit's vault document makes as it is stored, before
 * the search index takes its paths: a note listed that had no path is
 * made, one moved is changed, and one gone from the unit the server's
 * record puts it in is removed. A note the record puts in another unit
 * is that unit's to tell, so a note moving between units is changed, not
 * removed and made.
 */
export async function keepListChanges(
  tx: Queryable,
  workspaceId: string,
  unit: string,
  state: Uint8Array,
  before: Uint8Array | undefined,
): Promise<void> {
  const now = new Map([...pathsOf(state)].map(([id, path]) => [id.toLowerCase(), path]));
  const was = new Map([...pathsOf(before)].map(([id, path]) => [id.toLowerCase(), path]));
  const touched = [
    ...[...now].filter(([id, path]) => was.get(id) !== path).map(([id]) => id),
    ...[...was.keys()].filter((id) => !now.has(id)),
  ];
  if (touched.length === 0) return;
  const { rows } = await tx.query(
    `SELECT n.id, COALESCE(s.path, '') AS path, COALESCE(u.unit_id::text, $3) AS unit
       FROM unnest($2::text[]) AS n(id)
       LEFT JOIN note_search s ON s.workspace_id = $1 AND s.note = n.id
       LEFT JOIN note_units u ON u.workspace_id = $1 AND u.note = n.id`,
    [workspaceId, touched, general],
  );
  for (const row of rows) {
    const id = readText(row, "id");
    if (readText(row, "unit") !== unit) continue;
    const path = now.get(id);
    if (path === undefined) {
      await keep(tx, workspaceId, id, "deleted", was.get(id) ?? "");
    } else {
      await keep(tx, workspaceId, id, readText(row, "path") === "" ? "created" : "updated", path);
    }
  }
}

/**
 * Keeps a note's change as its document is stored, when its state is not
 * the one stored, and only for a note a vault document lists: a note not
 * listed yet is made when it is.
 */
export async function keepNoteChange(
  tx: Queryable,
  workspaceId: string,
  note: string,
  state: Uint8Array,
): Promise<void> {
  const { rows } = await tx.query(
    `SELECT s.path, d.state IS DISTINCT FROM $3::bytea AS changed
       FROM note_search s
       LEFT JOIN documents d ON d.workspace_id = s.workspace_id AND d.name = s.note
      WHERE s.workspace_id = $1 AND s.note = $2 AND s.path <> ''`,
    [workspaceId, note, state],
  );
  const row = rows[0];
  if (row?.changed !== true) return;
  await keep(tx, workspaceId, note, "updated", readText(row, "path"));
}

interface Hook {
  readonly id: string;
  readonly maker: string;
  readonly events: readonly string[];
}

/**
 * Turns the changes that are due into events, one for each webhook that
 * listens to their type and whose maker opens the note's unit now, read
 * with the note's path and title as they are now. Every node may run it:
 * each claims its changes with SKIP LOCKED, and sends none twice.
 */
export async function fanOut(db: Database, limit = 200): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows: due } = await tx.query(
      `DELETE FROM webhook_changes WHERE (workspace_id, note) IN (
         SELECT workspace_id, note FROM webhook_changes WHERE due_at <= now()
          ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING workspace_id, note, kind, path, last_at`,
      [limit],
    );
    const hooks = new Map<string, Hook[]>();
    const levels = new Map<string, ReadonlyMap<string, Level>>();
    for (const change of due) {
      const workspace = readText(change, "workspace_id");
      const note = readText(change, "note");
      const kind = readText(change, "kind");
      const type = `note.${kind}`;
      if (!hooks.has(workspace)) {
        const { rows } = await tx.query(
          "SELECT id, maker_id, events FROM webhooks WHERE workspace_id = $1 AND enabled",
          [workspace],
        );
        hooks.set(
          workspace,
          rows.map((row) => ({
            id: readText(row, "id"),
            maker: readText(row, "maker_id"),
            events: Array.isArray(row.events) ? (row.events as string[]) : [],
          })),
        );
      }
      const listening = (hooks.get(workspace) ?? []).filter((hook) => hook.events.includes(type));
      if (listening.length === 0) continue;
      let path = readText(change, "path");
      if (kind !== "deleted") {
        // Where it is now; one no list names any more is not told of.
        const { rows } = await tx.query(
          "SELECT path FROM note_search WHERE workspace_id = $1 AND note = $2",
          [workspace, note],
        );
        path = rows[0] === undefined ? "" : readText(rows[0], "path");
        if (path === "") continue;
      }
      const unit = await unitOfDocument(tx, workspace, note);
      const body = JSON.stringify({
        type,
        timestamp: readTime(change, "last_at").toISOString(),
        data: { workspace, note, path, title: titleOf(path) },
      });
      for (const hook of listening) {
        const key = `${workspace}/${hook.maker}`;
        let opens = levels.get(key);
        if (opens === undefined) {
          opens = (await accessible(tx, hook.maker, workspace)).levels;
          levels.set(key, opens);
        }
        if (!opens.has(unit)) continue;
        await tx.query(
          `INSERT INTO webhook_deliveries (id, webhook_id, type, body, status, next_at)
           VALUES ($1, $2, $3, $4, 'waiting', now())`,
          [randomUUID(), hook.id, type, body],
        );
      }
    }
    return due.length;
  });
}
