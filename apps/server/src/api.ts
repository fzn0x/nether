// The public API (ADR 0059), under /api/v1, for personal access tokens and
// sessions: the workspaces a caller reaches, their notes as Markdown with
// YAML frontmatter, their databases and rows as their files have them, and
// search. Every route over notes opens only the units the account opens,
// as sync does, narrowed by the token. Encrypted workspaces are listed,
// and their notes are not served: the server cannot read them.
import type { JsonValue } from "@nether/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Database, type Queryable, type Row, readText, readTime } from "./db.ts";
import { fail, limitBy, uuidField } from "./http.ts";
import type * as Markdown from "./markdown.ts";
import { maxResults, noteContent, search } from "./search.ts";
import type { SyncControl } from "./sync.ts";
import { type ApiCaller, apiCaller, callerActor, callerOf } from "./tokens.ts";
import { type EventTarget, type ServerEvents, originOf } from "./events.ts";
import { type Level, type Unit, accessible, general } from "./units.ts";
import { membership } from "./workspaces.ts";

/** How many notes a page lists unless asked, and the most it lists. */
const pageSize = 100;
const maxPageSize = 1000;

export const noWorkspace = "This account, or this token, reaches no such workspace.";
export const encryptedWorkspace =
  "This workspace is end-to-end encrypted: the server cannot read its notes, so the API cannot give them.";
export const noNote = "This workspace has no such note, or none this account may open.";
export const noDatabase = "This workspace has no such database, or none this account may open.";
const badCursor = "This `after` is not one the API gave.";

let reader: Promise<typeof Markdown> | undefined;

/** The Markdown reader and writer, with the editor's schema, loaded when the API first needs it. */
export function markdownReader(): Promise<typeof Markdown> {
  reader ??= import("./markdown.ts");
  return reader;
}

/** A workspace a caller reaches, and the units its account opens there. */
export interface Reached {
  readonly workspace: string;
  /** The units the account opens, General's key among them. */
  readonly opens: readonly string[];
  /** The level at which it opens each. */
  readonly levels: ReadonlyMap<string, Level>;
  /** Every unit of the workspace, whether the account opens it or not. */
  readonly units: ReadonlyMap<string, Unit>;
}

/** The workspace a caller asks for, if it reaches it and the server can read it; else why not. */
export async function reach(
  db: Queryable,
  caller: ApiCaller,
  id: string,
): Promise<Reached | readonly [number, string]> {
  const workspace = id.toLowerCase();
  if (caller.workspaceId !== null && caller.workspaceId !== workspace) return [404, noWorkspace];
  const member = await membership(db, caller.userId, workspace);
  if (member === undefined) return [404, noWorkspace];
  if (member.encryption !== "none") return [409, encryptedWorkspace];
  const { levels, units } = await accessible(db, caller.userId, workspace);
  return { workspace, opens: [...levels.keys()], levels, units };
}

/** Where a page of notes ends: the last one's path and ID, as an opaque text. */
function cursorOf(path: string, note: string): string {
  return Buffer.from(JSON.stringify([path, note]), "utf8").toString("base64url");
}

function readCursor(text: string): readonly [string, string] | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // Not one the API gave.
  }
  return undefined;
}

function readTags(row: Row): string[] {
  const tags = row.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function readUpdated(row: Row): string | null {
  return row.updated_at === null ? null : readTime(row, "updated_at").toISOString();
}

/** A JSON value as the database gives it back, or an empty object. */
function readObject(value: unknown): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

interface PageOptions {
  /** Only the notes under this folder, ending with a slash. */
  readonly under?: string;
  /** Only those right in the folder, not in folders below it. */
  readonly direct?: boolean;
  /** Only databases: notes with a schema. */
  readonly databases?: boolean;
  readonly after?: readonly [string, string];
  readonly limit: number;
}

/**
 * A page of the notes a workspace's vault documents list, in units the
 * account opens, by path: from the search index, kept as they are stored
 * (ADR 0050).
 */
async function pageOfNotes(
  db: Queryable,
  reached: Reached,
  options: PageOptions,
): Promise<{ readonly rows: Row[]; readonly next: string | null }> {
  const values: unknown[] = [reached.workspace, general, reached.opens];
  const add = (value: unknown) => `$${String(values.push(value))}`;
  const conditions = [
    "s.workspace_id = $1",
    "s.path <> ''",
    "COALESCE(u.unit_id::text, $2) = ANY($3::text[])",
  ];
  if (options.under !== undefined) {
    const folder = add(options.under);
    conditions.push(`left(s.path, length(${folder}::text)) = ${folder}::text`);
    if (options.direct === true) {
      conditions.push(`strpos(substr(s.path, length(${folder}::text) + 1), '/') = 0`);
    }
  }
  if (options.databases === true) {
    conditions.push("jsonb_typeof(s.properties -> 'database') = 'object'");
  }
  if (options.after !== undefined) {
    conditions.push(
      `(s.path COLLATE "C", s.note) > (${add(options.after[0])}::text COLLATE "C", ${add(options.after[1])}::text)`,
    );
  }
  const { rows } = await db.query(
    `SELECT s.note, s.path, s.title, s.tags, s.properties, d.updated_at
       FROM note_search s
       LEFT JOIN note_units u ON u.workspace_id = s.workspace_id AND u.note = s.note
       LEFT JOIN documents d ON d.workspace_id = s.workspace_id AND d.name = s.note
      WHERE ${conditions.join(" AND ")}
      ORDER BY s.path COLLATE "C", s.note
      LIMIT ${add(options.limit + 1)}`,
    values,
  );
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  const next =
    rows.length > options.limit && last !== undefined
      ? cursorOf(readText(last, "path"), readText(last, "note"))
      : null;
  return { rows: page, next };
}

/**
 * A note a workspace lists, in a unit the account opens: its path, title,
 * unit and when last stored.
 */
export async function listedNote(
  db: Queryable,
  reached: Reached,
  note: string,
): Promise<Row | undefined> {
  const { rows } = await db.query(
    `SELECT s.note, s.path, s.title, d.updated_at, COALESCE(u.unit_id::text, $3) AS unit
       FROM note_search s
       LEFT JOIN note_units u ON u.workspace_id = s.workspace_id AND u.note = s.note
       LEFT JOIN documents d ON d.workspace_id = s.workspace_id AND d.name = s.note
      WHERE s.workspace_id = $1 AND s.note = $2 AND s.path <> ''`,
    [reached.workspace, note.toLowerCase(), general],
  );
  const row = rows[0];
  if (row === undefined || !reached.opens.includes(readText(row, "unit"))) return undefined;
  return row;
}

/** The folder a database's rows are in: its note's path without `.md`, and a slash. */
export function rowsFolder(path: string): string {
  return `${path.replace(/\.md$/i, "")}/`;
}

export interface WorkspaceParams {
  readonly workspace: string;
}

export interface NoteParams extends WorkspaceParams {
  readonly note: string;
}

interface PageQuery {
  readonly after?: string;
  readonly limit?: number;
}

interface NotesQuery extends PageQuery {
  readonly folder?: string;
}

interface SearchQuery {
  readonly q: string;
  readonly workspace?: string;
  readonly limit?: number;
}

export const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

export const noteParams = {
  type: "object",
  required: ["workspace", "note"],
  properties: { workspace: uuidField, note: uuidField },
} as const;

const pageProperties = {
  after: { type: "string", minLength: 1, maxLength: 4096 },
  limit: { type: "integer", minimum: 1, maximum: maxPageSize },
} as const;

const pageQuery = {
  type: "object",
  additionalProperties: false,
  properties: pageProperties,
} as const;

const notesQuery = {
  type: "object",
  additionalProperties: false,
  properties: { ...pageProperties, folder: { type: "string", maxLength: 1000 } },
} as const;

const searchQuery = {
  type: "object",
  required: ["q"],
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 500 },
    workspace: uuidField,
    limit: { type: "integer", minimum: 1, maximum: maxResults },
  },
} as const;

/** Whether a request asks for a note's Markdown alone, rather than JSON. */
export function wantsMarkdown(request: FastifyRequest): boolean {
  return /\btext\/markdown\b/i.test(request.headers.accept ?? "");
}

/** A note as the API gives it, from the row `listedNote` found, with its entity tag. */
export async function noteAnswer(sync: SyncControl, reached: Reached, row: Row) {
  const id = readText(row, "note");
  const state = await sync.state(reached.workspace, id);
  const note = (await markdownReader()).readNote(state);
  return {
    tag: note.tag,
    markdown: note.markdown,
    body: {
      id,
      workspace: reached.workspace,
      path: readText(row, "path"),
      title: readText(row, "title"),
      tags: state === undefined ? [] : noteContent(state).tags,
      properties: note.properties,
      markdown: note.markdown,
      updatedAt: readUpdated(row),
    },
  };
}

/** A database the account opens, with its schema as it is now; undefined for none. */
export async function findDatabase(
  db: Queryable,
  sync: SyncControl,
  reached: Reached,
  note: string,
) {
  const row = await listedNote(db, reached, note);
  if (row === undefined) return undefined;
  const id = readText(row, "note");
  const state = await sync.state(reached.workspace, id);
  const schema = state === undefined ? undefined : noteContent(state).properties.database;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  return { row, id, schema };
}

/**
 * The public API's routes, reading. It gives the checks every route of the
 * API runs, its caller's and its limit, for the routes that write.
 */
/** The most notes an event names one by one: the rest it counts. */
const namedNotes = 50;

export function registerApi(
  app: FastifyInstance,
  db: Database,
  sync: SyncControl,
  events: ServerEvents,
) {
  const caller = apiCaller(db);

  /**
   * Tells of a request that gave notes' text or rows, before it is answered:
   * one event for the request, naming up to 50 notes, and how many more
   * (ADR 0081). An export the log cannot record is not given.
   */
  const toldRead = (
    request: FastifyRequest,
    action: "note.read_by_api" | "database.read_by_api" | "search.read_by_api",
    workspace: string | null,
    notes: readonly string[],
    target?: EventTarget,
  ) =>
    events.emit(
      db,
      {
        action,
        actor: callerActor(callerOf(request)),
        workspace,
        ...(target === undefined ? {} : { target }),
        details: {
          notes: [...notes.slice(0, namedNotes)],
          more: Math.max(0, notes.length - namedNotes),
        },
      },
      originOf(request),
    );
  // Per account, its tokens and sessions together, so more tokens are not more requests.
  const limit = limitBy(app, "api", 300, "1 minute", (request) => callerOf(request).limitKey);
  const searchLimit = limitBy(
    app,
    "api-search",
    120,
    "1 minute",
    (request) => callerOf(request).limitKey,
  );
  const checks = [caller, limit];

  app.get("/api/v1/me", { preHandler: checks }, (request) => {
    const me = callerOf(request);
    return {
      user: { id: me.userId, name: me.name, email: me.email },
      token: me.token,
    };
  });

  app.get("/api/v1/workspaces", { preHandler: checks }, async (request) => {
    const me = callerOf(request);
    const { rows } = await db.query(
      `SELECT w.id, w.name, w.encryption, m.role
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 AND ($2::uuid IS NULL OR w.id = $2::uuid)
        ORDER BY w.created_at, w.name`,
      [me.userId, me.workspaceId],
    );
    return {
      workspaces: rows.map((row) => ({
        id: readText(row, "id"),
        name: readText(row, "name"),
        role: readText(row, "role"),
        encryption: readText(row, "encryption"),
      })),
    };
  });

  app.get<{ Params: WorkspaceParams; Querystring: NotesQuery }>(
    "/api/v1/workspaces/:workspace/notes",
    { schema: { params: workspaceParams, querystring: notesQuery }, preHandler: checks },
    async (request, reply) => {
      const reached = await reach(db, callerOf(request), request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const after = request.query.after === undefined ? undefined : readCursor(request.query.after);
      if (request.query.after !== undefined && after === undefined) {
        return fail(reply, 400, badCursor);
      }
      const folder = request.query.folder?.replace(/^\/+|\/+$/g, "") ?? "";
      const page = await pageOfNotes(db, reached, {
        ...(folder === "" ? {} : { under: `${folder}/` }),
        ...(after === undefined ? {} : { after }),
        limit: request.query.limit ?? pageSize,
      });
      return {
        notes: page.rows.map((row) => ({
          id: readText(row, "note"),
          path: readText(row, "path"),
          title: readText(row, "title"),
          tags: readTags(row),
          updatedAt: readUpdated(row),
        })),
        next: page.next,
      };
    },
  );

  app.get<{ Params: NoteParams }>(
    "/api/v1/workspaces/:workspace/notes/:note",
    { schema: { params: noteParams }, preHandler: checks },
    async (request, reply) => {
      const reached = await reach(db, callerOf(request), request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const row = await listedNote(db, reached, request.params.note);
      if (row === undefined) return fail(reply, 404, noNote);
      const note = await noteAnswer(sync, reached, row);
      const id = readText(row, "note");
      await toldRead(request, "note.read_by_api", reached.workspace, [id], {
        type: "note",
        id,
        name: readText(row, "title"),
      });
      // What `If-Match` sends back to change the note only as it was read.
      reply.header("etag", note.tag);
      if (wantsMarkdown(request)) {
        return reply.type("text/markdown; charset=utf-8").send(note.markdown);
      }
      return note.body;
    },
  );

  app.get<{ Params: WorkspaceParams; Querystring: PageQuery }>(
    "/api/v1/workspaces/:workspace/databases",
    { schema: { params: workspaceParams, querystring: pageQuery }, preHandler: checks },
    async (request, reply) => {
      const reached = await reach(db, callerOf(request), request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const after = request.query.after === undefined ? undefined : readCursor(request.query.after);
      if (request.query.after !== undefined && after === undefined) {
        return fail(reply, 400, badCursor);
      }
      const page = await pageOfNotes(db, reached, {
        databases: true,
        ...(after === undefined ? {} : { after }),
        limit: request.query.limit ?? pageSize,
      });
      // Their schemas, one event for the page.
      await toldRead(
        request,
        "database.read_by_api",
        reached.workspace,
        page.rows.map((row) => readText(row, "note")),
      );
      return {
        databases: page.rows.map((row) => ({
          id: readText(row, "note"),
          path: readText(row, "path"),
          title: readText(row, "title"),
          schema: readObject(row.properties).database ?? null,
          updatedAt: readUpdated(row),
        })),
        next: page.next,
      };
    },
  );

  app.get<{ Params: NoteParams }>(
    "/api/v1/workspaces/:workspace/databases/:note",
    { schema: { params: noteParams }, preHandler: checks },
    async (request, reply) => {
      const reached = await reach(db, callerOf(request), request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const found = await findDatabase(db, sync, reached, request.params.note);
      if (found === undefined) return fail(reply, 404, noDatabase);
      await toldRead(request, "database.read_by_api", reached.workspace, [found.id], {
        type: "note",
        id: found.id,
        name: readText(found.row, "title"),
      });
      return {
        id: found.id,
        workspace: reached.workspace,
        path: readText(found.row, "path"),
        title: readText(found.row, "title"),
        schema: found.schema,
        updatedAt: readUpdated(found.row),
      };
    },
  );

  app.get<{ Params: NoteParams; Querystring: PageQuery }>(
    "/api/v1/workspaces/:workspace/databases/:note/rows",
    { schema: { params: noteParams, querystring: pageQuery }, preHandler: checks },
    async (request, reply) => {
      const reached = await reach(db, callerOf(request), request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const found = await findDatabase(db, sync, reached, request.params.note);
      if (found === undefined) return fail(reply, 404, noDatabase);
      const after = request.query.after === undefined ? undefined : readCursor(request.query.after);
      if (request.query.after !== undefined && after === undefined) {
        return fail(reply, 400, badCursor);
      }
      // Its rows are the notes right in the folder beside it, not in folders below (ADR 0018).
      const page = await pageOfNotes(db, reached, {
        under: rowsFolder(readText(found.row, "path")),
        direct: true,
        ...(after === undefined ? {} : { after }),
        limit: request.query.limit ?? pageSize,
      });
      // A page of rows is one event, naming its rows.
      await toldRead(
        request,
        "database.read_by_api",
        reached.workspace,
        page.rows.map((row) => readText(row, "note")),
        { type: "note", id: found.id, name: readText(found.row, "title") },
      );
      return {
        rows: page.rows.map((row) => ({
          id: readText(row, "note"),
          path: readText(row, "path"),
          title: readText(row, "title"),
          properties: readObject(row.properties),
          updatedAt: readUpdated(row),
        })),
        next: page.next,
      };
    },
  );

  app.get<{ Querystring: SearchQuery }>(
    "/api/v1/search",
    { schema: { querystring: searchQuery }, preHandler: [caller, limit, searchLimit] },
    async (request, reply) => {
      const me = callerOf(request);
      const asked = request.query.workspace?.toLowerCase();
      if (me.workspaceId !== null && asked !== undefined && asked !== me.workspaceId) {
        return fail(reply, 404, noWorkspace);
      }
      const only = asked ?? me.workspaceId ?? undefined;
      if (only !== undefined && (await membership(db, me.userId, only)) === undefined) {
        return fail(reply, 404, noWorkspace);
      }
      if (request.query.q.trim() === "") return fail(reply, 400, "Type something to search for.");
      const found = await search(db, me.userId, request.query.q, request.query.limit, only);
      // The notes whose passages it gave, never what was searched for.
      await toldRead(
        request,
        "search.read_by_api",
        only ?? null,
        found.results.map((result) => result.note),
      );
      return found;
    },
  );

  return { caller, limit };
}
