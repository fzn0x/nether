// Published sites (ADR 0076): a note with its subpages, or a folder, of a
// workspace the server can read, drawn for anyone at /p/<name>/. A site is
// published as the one who published it: it shows the notes under its root
// that they have full access to. Those with full access where the root is,
// and the workspace's owners and admins, change and unpublish it; owners
// and admins can turn publishing off for the workspace.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Database, type Queryable, type Row, readText, readTime } from "./db.ts";
import { fail, uuidField } from "./http.ts";
import { accountOf, signedIn } from "./sessions.ts";
import { accessible, unitOfDocument } from "./units.ts";
import { membership } from "./workspaces.ts";
import { hasControl, isName, unitForPath } from "./writes.ts";

/** A site's name, its address under /p/: 3 to 63 lowercase letters, digits and hyphens. */
export const siteName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The most sites a workspace has. */
export const maxSites = 100;

export interface Site {
  readonly id: string;
  readonly workspace: string;
  readonly publisher: string;
  readonly name: string;
  readonly title: string;
  /** The note it publishes with its subpages, or null for a folder's site. */
  readonly rootNote: string | null;
  /** The folder it publishes, or null for a note's site. */
  readonly rootFolder: string | null;
}

function siteOf(row: Row): Site {
  return {
    id: readText(row, "id"),
    workspace: readText(row, "workspace_id"),
    publisher: readText(row, "publisher_id"),
    name: readText(row, "name"),
    title: readText(row, "title"),
    rootNote: typeof row.root_note === "string" ? row.root_note : null,
    rootFolder: typeof row.root_folder === "string" ? row.root_folder : null,
  };
}

/**
 * The site at a name, while its workspace may publish and the server can
 * read it; undefined otherwise, as for one not there.
 */
export async function siteNamed(db: Queryable, name: string): Promise<Site | undefined> {
  const { rows } = await db.query(
    `SELECT s.* FROM sites s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.name = $1 AND w.publishing AND w.encryption = 'none'`,
    [name],
  );
  return rows[0] === undefined ? undefined : siteOf(rows[0]);
}

/** Whether a folder's path is one a vault can have: names every system takes, none hidden. */
export function isFolderPath(folder: string): boolean {
  return (
    folder.length > 0 &&
    folder.length <= 1000 &&
    !hasControl(folder) &&
    folder.split("/").every((part) => isName(part))
  );
}

/**
 * Whether a write failed on a unique key: a name another workspace's site
 * took between the check and the write, as only names are unique across
 * workspaces and a workspace's own writes wait on its row.
 */
function nameTaken(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

/** The server's address as people reach it: the configured one, or what the request was sent to. */
function baseOf(request: FastifyRequest, publicUrl: string | null): string {
  return (publicUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, "");
}

const workspaceParams = {
  type: "object",
  required: ["workspace"],
  properties: { workspace: uuidField },
} as const;

const siteParams = {
  type: "object",
  required: ["workspace", "site"],
  properties: { workspace: uuidField, site: uuidField },
} as const;

const nameField = { type: "string", minLength: 3, maxLength: 63 } as const;
const titleField = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

interface NewSite {
  readonly note?: string;
  readonly folder?: string;
  readonly name: string;
  readonly title?: string;
}

interface SiteChange {
  readonly name?: string;
  readonly title?: string;
}

const newSiteBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    note: uuidField,
    folder: { type: "string", minLength: 1, maxLength: 1000 },
    name: nameField,
    title: titleField,
  },
} as const;

const changeBody = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: { name: nameField, title: titleField },
} as const;

const noWorkspace = "This account is in no such workspace.";
const encrypted = "An encrypted workspace publishes nothing: the server cannot read its notes.";
const publishingOff = "Publishing is off in this workspace: its owners and admins turn it on.";
const badName = "A site's name is 3 to 63 lowercase letters, digits and hyphens.";
const badFolder = "That is not a folder's path.";
const noSite = "This workspace has no such site.";
const noFull = "Publishing takes full access to what is published.";

/**
 * The routes of a workspace's sites: listing, publishing, changing and
 * unpublishing them, and the workspace's switch. `changed` hears of each
 * site changed or gone, for what draws them to forget it.
 */
export function registerSites(
  app: FastifyInstance,
  db: Database,
  options: { readonly publicUrl: string | null; readonly changed: (site: string) => void },
): void {
  const account = signedIn(db);

  /** The workspace and what the account may do in it, or why it may do nothing. */
  async function placed(userId: string, workspace: string) {
    const place = await membership(db, userId, workspace);
    if (place === undefined) return [404, noWorkspace] as const;
    if (place.encryption !== "none") return [409, encrypted] as const;
    const { levels, units } = await accessible(db, userId, workspace);
    return {
      workspace,
      admin: place.role === "owner" || place.role === "admin",
      levels,
      reached: { workspace, opens: [...levels.keys()], levels, units },
    };
  }

  type Placed = Exclude<Awaited<ReturnType<typeof placed>>, readonly [number, string]>;

  /** Whether the account has full access where a site's root is. */
  async function fullAt(
    place: Placed,
    userId: string,
    root: { readonly note: string | null; readonly folder: string | null },
  ): Promise<boolean> {
    const unit =
      root.note !== null
        ? await unitOfDocument(db, place.workspace, root.note)
        : await unitForPath(db, place.reached, userId, `${root.folder ?? ""}/Page.md`);
    return unit !== undefined && place.levels.get(unit) === "full";
  }

  const shown = (request: FastifyRequest, row: Row) => ({
    id: readText(row, "id"),
    name: readText(row, "name"),
    title: readText(row, "title"),
    note: typeof row.root_note === "string" ? row.root_note : null,
    folder: typeof row.root_folder === "string" ? row.root_folder : null,
    url: `${baseOf(request, options.publicUrl)}/p/${readText(row, "name")}/`,
    publishedBy: { id: readText(row, "publisher_id"), name: readText(row, "publisher_name") },
    createdAt: readTime(row, "created_at").toISOString(),
  });

  const columns = "s.*, u.name AS publisher_name";

  // The sites the account may change: every one for owners and admins.
  app.get<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace/sites",
    { schema: { params: workspaceParams }, preHandler: account },
    async (request, reply) => {
      const me = accountOf(request).id;
      const place = await placed(me, request.params.workspace.toLowerCase());
      if (!("workspace" in place)) return fail(reply, place[0], place[1]);
      const { rows } = await db.query(
        `SELECT ${columns} FROM sites s JOIN users u ON u.id = s.publisher_id
          WHERE s.workspace_id = $1 ORDER BY s.created_at, s.id`,
        [place.workspace],
      );
      const mine: Row[] = [];
      for (const row of rows) {
        const root = {
          note: typeof row.root_note === "string" ? row.root_note : null,
          folder: typeof row.root_folder === "string" ? row.root_folder : null,
        };
        if (place.admin || (await fullAt(place, me, root))) mine.push(row);
      }
      const { rows: switches } = await db.query("SELECT publishing FROM workspaces WHERE id = $1", [
        place.workspace,
      ]);
      return {
        publishing: switches[0]?.publishing === true,
        // Whether the account turns publishing on and off: an owner's or admin's.
        manages: place.admin,
        sites: mine.map((row) => shown(request, row)),
      };
    },
  );

  app.post<{ Params: { workspace: string }; Body: NewSite }>(
    "/api/workspaces/:workspace/sites",
    { schema: { params: workspaceParams, body: newSiteBody }, preHandler: account },
    async (request, reply) => {
      const me = accountOf(request).id;
      const place = await placed(me, request.params.workspace.toLowerCase());
      if (!("workspace" in place)) return fail(reply, place[0], place[1]);
      const { note: given, folder, name } = request.body;
      if ((given === undefined) === (folder === undefined)) {
        return fail(reply, 400, "A site publishes a note, or a folder.");
      }
      if (!siteName.test(name)) return fail(reply, 400, badName);
      if (folder !== undefined && !isFolderPath(folder)) return fail(reply, 400, badFolder);
      const note = given?.toLowerCase() ?? null;
      let title = request.body.title?.trim();
      if (note !== null) {
        const { rows } = await db.query(
          "SELECT title FROM note_search WHERE workspace_id = $1 AND note = $2 AND path <> ''",
          [place.workspace, note],
        );
        if (rows[0] === undefined) return fail(reply, 404, "This workspace has no such note.");
        title ??= readText(rows[0], "title");
      }
      title ??= folder?.slice(folder.lastIndexOf("/") + 1) ?? name;
      if (!(await fullAt(place, me, { note, folder: folder ?? null }))) {
        return fail(reply, 403, noFull);
      }
      const id = randomUUID();
      const made = await db
        .transaction(async (tx) => {
          const { rows: workspace } = await tx.query(
            "SELECT publishing FROM workspaces WHERE id = $1 FOR UPDATE",
            [place.workspace],
          );
          if (workspace[0]?.publishing !== true) return [409, publishingOff] as const;
          const { rows: taken } = await tx.query(
            `SELECT name FROM sites WHERE name = $1
              OR (workspace_id = $2 AND (root_note = $3 OR root_folder = $4))`,
            [name, place.workspace, note, folder ?? null],
          );
          const clash = taken[0];
          if (clash !== undefined) {
            return readText(clash, "name") === name
              ? ([409, "A site has that name already."] as const)
              : ([409, `This is published already, as ${readText(clash, "name")}.`] as const);
          }
          const { rows: counted } = await tx.query(
            "SELECT count(*)::integer AS count FROM sites WHERE workspace_id = $1",
            [place.workspace],
          );
          if (Number(counted[0]?.count ?? 0) >= maxSites) {
            return [409, `A workspace has at most ${String(maxSites)} sites.`] as const;
          }
          await tx.query(
            `INSERT INTO sites (id, workspace_id, publisher_id, name, title, root_note, root_folder)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, place.workspace, me, name, title, note, folder ?? null],
          );
          return undefined;
        })
        .catch((error: unknown) => {
          if (nameTaken(error)) return [409, "A site has that name already."] as const;
          throw error;
        });
      if (made !== undefined) return fail(reply, made[0], made[1]);
      const { rows } = await db.query(
        `SELECT ${columns} FROM sites s JOIN users u ON u.id = s.publisher_id WHERE s.id = $1`,
        [id],
      );
      return reply.code(201).send(shown(request, rows[0] ?? {}));
    },
  );

  /** A site of the workspace the account may change, or why it may not. */
  async function managed(userId: string, workspace: string, siteId: string) {
    const place = await placed(userId, workspace);
    if (!("workspace" in place)) return place;
    const { rows } = await db.query(
      `SELECT ${columns} FROM sites s JOIN users u ON u.id = s.publisher_id
        WHERE s.workspace_id = $1 AND s.id = $2`,
      [place.workspace, siteId.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined) return [404, noSite] as const;
    const site = siteOf(row);
    const may =
      place.admin ||
      (await fullAt(place, userId, { note: site.rootNote, folder: site.rootFolder }));
    return may ? { place, row, site } : ([403, noFull] as const);
  }

  app.patch<{ Params: { workspace: string; site: string }; Body: SiteChange }>(
    "/api/workspaces/:workspace/sites/:site",
    { schema: { params: siteParams, body: changeBody }, preHandler: account },
    async (request, reply) => {
      const found = await managed(
        accountOf(request).id,
        request.params.workspace.toLowerCase(),
        request.params.site,
      );
      if (!("site" in found)) return fail(reply, found[0], found[1]);
      const { name, title } = request.body;
      if (name !== undefined && !siteName.test(name)) return fail(reply, 400, badName);
      if (name !== undefined && name !== found.site.name) {
        const { rows } = await db.query("SELECT 1 FROM sites WHERE name = $1", [name]);
        if (rows.length > 0) return fail(reply, 409, "A site has that name already.");
      }
      const taken = await db
        .query(
          "UPDATE sites SET name = COALESCE($2, name), title = COALESCE($3, title) WHERE id = $1",
          [found.site.id, name ?? null, title?.trim() ?? null],
        )
        .then(
          () => false,
          (error: unknown) => {
            if (nameTaken(error)) return true;
            throw error;
          },
        );
      if (taken) return fail(reply, 409, "A site has that name already.");
      options.changed(found.site.id);
      const { rows } = await db.query(
        `SELECT ${columns} FROM sites s JOIN users u ON u.id = s.publisher_id WHERE s.id = $1`,
        [found.site.id],
      );
      return shown(request, rows[0] ?? {});
    },
  );

  // Unpublishing deletes the site: its addresses answer as not there at once.
  app.delete<{ Params: { workspace: string; site: string } }>(
    "/api/workspaces/:workspace/sites/:site",
    { schema: { params: siteParams }, preHandler: account },
    async (request, reply) => {
      const found = await managed(
        accountOf(request).id,
        request.params.workspace.toLowerCase(),
        request.params.site,
      );
      if (!("site" in found)) return fail(reply, found[0], found[1]);
      await db.query("DELETE FROM sites WHERE id = $1", [found.site.id]);
      options.changed(found.site.id);
      return reply.code(204).send();
    },
  );

  // The workspace's switch: off, its sites answer as not there, and none is made.
  app.put<{ Params: { workspace: string }; Body: { readonly enabled: boolean } }>(
    "/api/workspaces/:workspace/publishing",
    {
      schema: {
        params: workspaceParams,
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
      preHandler: account,
    },
    async (request, reply) => {
      const place = await placed(accountOf(request).id, request.params.workspace.toLowerCase());
      if (!("workspace" in place)) return fail(reply, place[0], place[1]);
      if (!place.admin) {
        return fail(reply, 403, "Only a workspace's owners and admins turn publishing on or off.");
      }
      await db.query("UPDATE workspaces SET publishing = $2 WHERE id = $1", [
        place.workspace,
        request.body.enabled,
      ]);
      const { rows } = await db.query("SELECT id FROM sites WHERE workspace_id = $1", [
        place.workspace,
      ]);
      for (const row of rows) options.changed(readText(row, "id"));
      return { enabled: request.body.enabled };
    },
  );
}
