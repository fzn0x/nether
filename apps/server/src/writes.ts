// Writing through the public API (ADR 0059): making notes and database
// rows, replacing a note's Markdown, and sending a note to the trash. Each
// write goes through Hocuspocus, by a direct connection to the document,
// as the server's own edits of vault documents do, so editors with the note
// open see it as it is made and every device syncs it. Writing takes a
// write token, or a session, and edit access to the note's unit. A new
// note's unit is the one its path falls in, by the sync engine's rule over
// every unit of the workspace, so a path in a teamspace the account is not
// in is refused rather than put in General.
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@nether/core";
import type { ParsedMarkdown } from "@nether/markdown";
import type { FastifyInstance } from "fastify";
import { type Database, type Queryable, readText } from "./db.ts";
import { fail, limitBy } from "./http.ts";
import {
  type NoteParams,
  type Reached,
  type WorkspaceParams,
  findDatabase,
  listedNote,
  markdownReader,
  noDatabase,
  noNote,
  noteAnswer,
  noteParams,
  reach,
  type registerApi,
  rowsFolder,
  workspaceParams,
} from "./api.ts";
import type { SyncControl } from "./sync.ts";
import { type ApiCaller, callerOf } from "./tokens.ts";
import { general, unitLock, vaultDocument, writesAt } from "./units.ts";
import { originOf } from "./events.ts";

/** The largest note the API takes, in bytes of its Markdown. */
export const noteBytes = 5 * 1024 * 1024;

const readOnly = "This token only reads: writing takes a write token.";
const noWrite = "Writing there takes edit access, which this account does not have.";
const pathTaken = "A note has that path already.";
const unitGone =
  "Where the note goes changed as it was made, as a page that stopped being shared on its own: make it again.";
const badPath =
  "A note's path is folders and a name ending in .md, each without / \\ : * ? \" < > |, not hidden by a starting dot, and not ending with a dot or a space.";
const noPrivate =
  "This account has no private space in this workspace yet: the app makes it the first time it is opened there.";
const changedSince =
  "The note changed since it was read: read it again, and make the change on what it is now.";
const noText = "Send the note's Markdown as `markdown` in JSON, or as text/markdown.";

/** Characters one system or another does not take in a name. */
const unsafe = /[\\:*?"<>|]/;
/** Names Windows keeps for devices, with any extension. */
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export function hasControl(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    if (text.charCodeAt(at) < 0x20 || text.charCodeAt(at) === 0x7f) return true;
  }
  return false;
}

/** Whether a name can be a folder's or a file's on every system, and is not hidden. */
export function isName(part: string): boolean {
  return (
    part !== "" &&
    part.trim() === part &&
    !part.startsWith(".") &&
    !part.endsWith(".") &&
    !unsafe.test(part) &&
    !reserved.test(part)
  );
}

/**
 * Whether a path can be a note's: folders and a name ending in `.md`, each
 * a name every system takes, none hidden, as the sync engine takes paths
 * from the server.
 */
export function isNotePath(path: string): boolean {
  if (path.length > 1000 || !/\.md$/i.test(path) || hasControl(path)) return false;
  const parts = path.split("/");
  return parts.every(isName) && (parts.at(-1)?.length ?? 0) > ".md".length;
}

/** Whether a path is in an area: under a folder, or a page and under the folder beside it. */
function inArea(path: string, area: string): boolean {
  if (area.endsWith("/")) return path.toLowerCase().startsWith(area.toLowerCase());
  const folder = `${area.replace(/\.md$/i, "")}/`;
  return path === area || path.toLowerCase().startsWith(folder.toLowerCase());
}

/** How many folders down an area is: `Design/` one, `Design/Launch.md`'s two. */
function depthOf(area: string): number {
  return area.endsWith("/")
    ? area.split("/").length - 1
    : area.replace(/\.md$/i, "").split("/").length;
}

/**
 * The unit a new note's path falls in, as the sync engine finds it: the
 * deepest area holding it of every unit of the workspace, a teamspace's
 * folder, the account's own `Private` folder or a shared page and the
 * folder beside it; General's when none does. Undefined when the path is in
 * `Private` and the account has no private space there.
 */
export async function unitForPath(
  db: Queryable,
  reached: Reached,
  userId: string,
  path: string,
): Promise<string | undefined> {
  const units = [...reached.units.values()];
  const roots = units.flatMap((unit) =>
    unit.kind === "page" && unit.rootNote !== null ? [unit.rootNote] : [],
  );
  const pagePaths = new Map<string, string>();
  if (roots.length > 0) {
    const { rows } = await db.query(
      "SELECT note, path FROM note_search WHERE workspace_id = $1 AND note = ANY($2) AND path <> ''",
      [reached.workspace, roots],
    );
    for (const row of rows) pagePaths.set(readText(row, "note"), readText(row, "path"));
  }
  let found: string | undefined;
  let depth = -1;
  let ownPrivate = false;
  for (const unit of units) {
    let area: string | undefined;
    if (unit.kind === "team" && unit.name !== null) area = `${unit.name}/`;
    if (unit.kind === "private" && unit.ownerId === userId) {
      ownPrivate = true;
      area = "Private/";
    }
    if (unit.kind === "page" && unit.rootNote !== null) area = pagePaths.get(unit.rootNote);
    if (area === undefined || !inArea(path, area)) continue;
    const deep = depthOf(area);
    if (deep > depth) {
      found = unit.id;
      depth = deep;
    }
  }
  if (!ownPrivate && inArea(path, "Private/")) return undefined;
  return found ?? general;
}

/** Whether a workspace lists a note at a path already, in any unit, in any case. */
async function isTaken(db: Queryable, workspace: string, path: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM note_search WHERE workspace_id = $1 AND lower(path) = lower($2) LIMIT 1",
    [workspace, path],
  );
  return rows.length > 0;
}

/** Whether an `If-Match` header names a tag: `*`, or one of a list of strong tags. */
export function matchesTag(header: string, tag: string): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").some((item) => item.trim() === tag);
}

/** The Markdown a write sends: its text/markdown body, or its JSON's `markdown`. */
function sentMarkdown(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const markdown = (body as Record<string, unknown>).markdown;
    if (typeof markdown === "string") return markdown;
  }
  return undefined;
}

interface NewNote {
  readonly path: string;
  readonly markdown?: string;
}

interface NewRow {
  readonly title: string;
  readonly properties?: object;
  readonly markdown?: string;
}

const markdownField = { type: "string", maxLength: noteBytes } as const;

const newNoteBody = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1000 },
    markdown: markdownField,
  },
} as const;

const newRowBody = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    properties: { type: "object" },
    markdown: markdownField,
  },
} as const;

/** The routes of the public API that write, with the checks `registerApi` gave. */
export function registerWrites(
  app: FastifyInstance,
  db: Database,
  sync: SyncControl,
  checks: ReturnType<typeof registerApi>,
): void {
  // A note's Markdown may come as it is, as a file is sent: `curl --data-binary @note.md`.
  app.addContentTypeParser(
    "text/markdown",
    { parseAs: "string", bodyLimit: noteBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const writeLimit = limitBy(
    app,
    "api-write",
    120,
    "1 minute",
    (request) => callerOf(request).limitKey,
  );
  const preHandler = [checks.caller, checks.limit, writeLimit];
  // Room for a note of noteBytes, and its JSON's quotes and escapes.
  const bodyLimit = noteBytes * 2;

  /** The workspace a write is to, if the caller may write and reaches it; else why not. */
  async function writable(caller: ApiCaller, workspace: string) {
    if (caller.access !== "write") return [403, readOnly] as const;
    return reach(db, caller, workspace);
  }

  /**
   * Makes a note at a path: its document from the Markdown, its unit's
   * record, then its line in its unit's vault document, where the apps
   * hear of it and fetch it as a note made elsewhere (ADR 0037).
   */
  async function make(
    caller: ApiCaller,
    reached: Reached,
    path: string,
    note: ParsedMarkdown,
  ): Promise<string | readonly [number, string]> {
    if (!isNotePath(path)) return [400, badPath];
    const unit = await unitForPath(db, reached, caller.userId, path);
    if (unit === undefined) return [409, noPrivate];
    if (!writesAt(reached.levels.get(unit))) return [403, noWrite];
    const markdown = await markdownReader();
    // One make of a workspace at a time, on every node, so two makes of one
    // path go one after the other (ADR 0082). One in a unit also holds the
    // unit's lock, taken second on the same connection: a page's unit
    // dropped meanwhile, as when the page stops being shared on its own,
    // would leave the note listed nowhere (#179). Such a make waits, and is
    // refused once the unit is gone.
    const locks = [`api.make.${reached.workspace}`];
    if (unit !== general) locks.push(unitLock(unit));
    return db.lock(locks, async () => {
      if (await isTaken(db, reached.workspace, path)) return [409, pathTaken] as const;
      const id = randomUUID();
      if (unit !== general) {
        const placed = await db.transaction(async (tx) => {
          // Still there, and kept until this commits.
          const { rows } = await tx.query(
            "SELECT 1 FROM units WHERE id = $1 AND workspace_id = $2 FOR KEY SHARE",
            [unit, reached.workspace],
          );
          if (rows.length === 0) return false;
          await tx.query(
            `INSERT INTO note_units (workspace_id, note, unit_id) VALUES ($1, $2, $3)
             ON CONFLICT (workspace_id, note) DO UPDATE SET unit_id = excluded.unit_id`,
            [reached.workspace, id, unit],
          );
          return true;
        });
        if (!placed) return [409, unitGone] as const;
      }
      await sync.edit(reached.workspace, id, caller.userId, (document) => {
        markdown.writeNote(document, note);
      });
      // An app may have listed a note at the path since: the list decides.
      const listed = await sync.edit(
        reached.workspace,
        vaultDocument(unit),
        caller.userId,
        (document) => {
          const notes = document.getMap<string>("notes");
          for (const other of notes.values()) {
            if (other.toLowerCase() === path.toLowerCase()) return false;
          }
          notes.set(id, path);
          return true;
        },
      );
      if (listed) return id;
      await discard(reached.workspace, id);
      return [409, pathTaken] as const;
    });
  }

  /**
   * Takes back a note made for a path an app listed first: its document, as
   * stored once, its row in the index and its unit's record, so nothing of
   * it stays where no list names it.
   */
  async function discard(workspace: string, id: string): Promise<void> {
    await db.transaction(async (tx) => {
      for (const table of ["documents", "document_versions"]) {
        await tx.query(`DELETE FROM ${table} WHERE workspace_id = $1 AND name = $2`, [
          workspace,
          id,
        ]);
      }
      for (const table of ["note_search", "note_units"]) {
        await tx.query(`DELETE FROM ${table} WHERE workspace_id = $1 AND note = $2`, [
          workspace,
          id,
        ]);
      }
    });
  }

  /**
   * The answer to a write that made or changed a note: the note, as reading
   * gives it. Where the workspace's data policy keeps its text (ADR 0088),
   * only where the note is and when it changed.
   */
  async function written(reached: Reached, id: string, userId: string) {
    const row = await listedNote(db, reached, id);
    if (row === undefined) throw new Error(`The note ${id} is not listed after its write.`);
    const answer = await noteAnswer(sync, reached, row);
    if (await checks.exported(reached.workspace, userId)) return answer;
    const { workspace, path, title, updatedAt } = answer.body;
    return { tag: answer.tag, body: { id: answer.body.id, workspace, path, title, updatedAt } };
  }

  app.post<{ Params: WorkspaceParams; Body: NewNote }>(
    "/api/v1/workspaces/:workspace/notes",
    { schema: { params: workspaceParams, body: newNoteBody }, preHandler, bodyLimit },
    async (request, reply) => {
      const caller = callerOf(request);
      const reached = await writable(caller, request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const note = (await markdownReader()).parseNote(request.body.markdown ?? "");
      if ("error" in note) return fail(reply, 400, note.error);
      const made = await make(caller, reached, request.body.path, note);
      if (typeof made !== "string") return fail(reply, made[0], made[1]);
      const answer = await written(reached, made, caller.userId);
      return reply
        .code(201)
        .header("location", `/api/v1/workspaces/${reached.workspace}/notes/${made}`)
        .header("etag", answer.tag)
        .send(answer.body);
    },
  );

  app.put<{ Params: NoteParams; Body: unknown }>(
    "/api/v1/workspaces/:workspace/notes/:note",
    { schema: { params: noteParams }, preHandler, bodyLimit },
    async (request, reply) => {
      const caller = callerOf(request);
      const reached = await writable(caller, request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const row = await listedNote(db, reached, request.params.note);
      if (row === undefined) return fail(reply, 404, noNote);
      if (!writesAt(reached.levels.get(readText(row, "unit")))) return fail(reply, 403, noWrite);
      const text = sentMarkdown(request.body);
      if (text === undefined) return fail(reply, 400, noText);
      if (Buffer.byteLength(text) > noteBytes) {
        return fail(reply, 413, "A note is at most 5 MB of Markdown.");
      }
      const markdown = await markdownReader();
      const note = markdown.parseNote(text);
      if ("error" in note) return fail(reply, 400, note.error);
      const id = readText(row, "note");
      const ifMatch = request.headers["if-match"];
      // The check and the change are one transaction, so no edit comes between.
      const changed = await sync.edit(reached.workspace, id, caller.userId, (document) => {
        if (ifMatch !== undefined && !matchesTag(ifMatch, markdown.documentNote(document).tag)) {
          return false;
        }
        markdown.writeNote(document, note);
        return true;
      });
      if (!changed) return fail(reply, 412, changedSince);
      const answer = await written(reached, id, caller.userId);
      return reply.header("etag", answer.tag).send(answer.body);
    },
  );

  // A note deleted goes to the trash on every device, where it can be
  // restored, as when it is deleted in the app.
  app.delete<{ Params: NoteParams }>(
    "/api/v1/workspaces/:workspace/notes/:note",
    { schema: { params: noteParams }, preHandler },
    async (request, reply) => {
      const caller = callerOf(request);
      const reached = await writable(caller, request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const row = await listedNote(db, reached, request.params.note);
      if (row === undefined) return fail(reply, 404, noNote);
      const unit = readText(row, "unit");
      if (!writesAt(reached.levels.get(unit))) return fail(reply, 403, noWrite);
      const id = readText(row, "note");
      const ifMatch = request.headers["if-match"];
      if (ifMatch !== undefined) {
        const now = (await markdownReader()).readNote(await sync.state(reached.workspace, id));
        if (!matchesTag(ifMatch, now.tag)) return fail(reply, 412, changedSince);
      }
      const removed = await sync.edit(
        reached.workspace,
        vaultDocument(unit),
        caller.userId,
        (document) => {
          const notes = document.getMap<string>("notes");
          const key = [...notes.keys()].find((listed) => listed.toLowerCase() === id);
          if (key === undefined) return false;
          notes.delete(key);
          return true;
        },
        // Told of as the vault document is stored (ADR 0081), with the token it came with.
        {
          ...originOf(request),
          token: caller.token === null ? null : { id: caller.token.id, name: caller.token.name },
        },
      );
      if (!removed) return fail(reply, 404, noNote);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: NoteParams; Body: NewRow }>(
    "/api/v1/workspaces/:workspace/databases/:note/rows",
    { schema: { params: noteParams, body: newRowBody }, preHandler, bodyLimit },
    async (request, reply) => {
      const caller = callerOf(request);
      const reached = await writable(caller, request.params.workspace);
      if (!("workspace" in reached)) return fail(reply, reached[0], reached[1]);
      const found = await findDatabase(db, sync, reached, request.params.note);
      if (found === undefined) return fail(reply, 404, noDatabase);
      const title = request.body.title;
      if (title.includes("/") || !isName(title) || hasControl(title)) {
        return fail(reply, 400, `A row's title is its file's name: ${badPath}`);
      }
      // JSON as the request's body held it: a frontmatter can hold any of it.
      const properties = (request.body.properties ?? {}) as Readonly<Record<string, JsonValue>>;
      if (Object.keys(properties).some((key) => key.trim() === "" || hasControl(key))) {
        return fail(reply, 400, "A property's name has some text, and no control characters.");
      }
      const note = (await markdownReader()).parseNote(request.body.markdown ?? "", properties);
      if ("error" in note) return fail(reply, 400, note.error);
      const path = `${rowsFolder(readText(found.row, "path"))}${title}.md`;
      const made = await make(caller, reached, path, note);
      if (typeof made !== "string") return fail(reply, made[0], made[1]);
      const answer = await written(reached, made, caller.userId);
      return reply
        .code(201)
        .header("location", `/api/v1/workspaces/${reached.workspace}/notes/${made}`)
        .header("etag", answer.tag)
        .send(answer.body);
    },
  );
}
