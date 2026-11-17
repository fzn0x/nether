// Attachments (ADR 0039): the images, PDFs and other files notes embed,
// kept by the SHA-256 of their bytes in the workspace's blob store, so a
// file is kept once however many notes or devices send it. A client asks
// whether the server has a file before sending it; the server checks the
// bytes it gets are the ones their name says. For an encrypted workspace
// the bytes are ciphertext, and so is their hash. A share link's visit
// reads its workspace's files too, by their hash, as a member does (ADR 0071).
// Whoever edits somewhere in a workspace sends its files: in General, or in
// any teamspace or page it opens at edit or more, as a guest who edits a
// page adds its images (ADR 0089).
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BlobStore } from "./blobs.ts";
import { type Database, readText } from "./db.ts";
import { fail, uuidField } from "./http.ts";
import { type LinkPolicies, visitOf, visitToken } from "./links.ts";
import { accountOf, requestToken, sessionAccount, signedIn } from "./sessions.ts";
import { type Permissions, placeOf } from "./places.ts";
import { accessible, writesAt } from "./units.ts";
import { membership } from "./workspaces.ts";

interface Params {
  readonly workspace: string;
  readonly hash: string;
}

const params = {
  type: "object",
  required: ["workspace", "hash"],
  properties: { workspace: uuidField, hash: { type: "string", pattern: "^[0-9a-f]{64}$" } },
} as const;

/** A media type as a client gives it: `type/subtype`, nothing more. */
const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function registerAttachments(
  app: FastifyInstance,
  db: Database,
  blobs: BlobStore,
  limit: number,
  policies: LinkPolicies,
  permissions: Permissions,
): void {
  const account = signedIn(db);
  /** The workspace each reading request may read: a member's, or a visit's. */
  const readable = new WeakMap<FastifyRequest, (workspace: string) => Promise<boolean>>();
  const reader = async (request: FastifyRequest, reply: FastifyReply) => {
    const found = requestToken(request);
    const signed =
      found === undefined || found === "csrf" ? undefined : await sessionAccount(db, found.token);
    if (signed !== undefined) {
      readable.set(
        request,
        async (workspace) => (await membership(db, signed.id, workspace)) !== undefined,
      );
      return undefined;
    }
    const visit = await visitOf(db, policies, visitToken(request.headers.cookie));
    if (visit !== undefined) {
      readable.set(request, (workspace) => Promise.resolve(workspace === visit.workspace));
      return undefined;
    }
    return fail(reply.header("www-authenticate", "Bearer"), 401, "Sign in first.");
  };

  // A file's bytes come as they are; other routes keep their JSON.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: limit },
    (_request, body, done) => {
      done(null, body);
    },
  );

  async function place(userId: string, workspace: string) {
    return placeOf(db, permissions, userId, workspace);
  }

  app.head<{ Params: Params }>(
    "/api/workspaces/:workspace/attachments/:hash",
    { schema: { params }, preHandler: account },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      if ((await place(accountOf(request).id, workspace)) === undefined)
        return reply.code(404).send();
      const { rows } = await db.query(
        "SELECT 1 FROM attachments WHERE workspace_id = $1 AND hash = $2",
        [workspace, request.params.hash],
      );
      return reply.code(rows.length === 0 ? 404 : 200).send();
    },
  );

  app.put<{ Params: Params; Body: Buffer }>(
    "/api/workspaces/:workspace/attachments/:hash",
    { schema: { params }, preHandler: account },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const { levels, place: found } = await accessible(
        db,
        permissions,
        accountOf(request).id,
        workspace,
      );
      if (found === undefined) return fail(reply, 404, "This account is in no such workspace.");
      if (![...levels.values()].some(writesAt)) {
        return fail(
          reply,
          403,
          "Sending files here takes edit access somewhere in this workspace.",
        );
      }
      const body = request.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(reply, 400, "Send the file's bytes, as application/octet-stream.");
      }
      const { hash } = request.params;
      if (createHash("sha256").update(body).digest("hex") !== hash) {
        return fail(reply, 400, "The bytes sent are not the ones their hash names.");
      }
      const given = request.headers["x-content-type"];
      const type = typeof given === "string" && mediaType.test(given) ? given.toLowerCase() : null;
      // Kept once: a file the workspace has is not written again.
      await blobs.put(`${workspace}/${hash}`, new Uint8Array(body));
      const { rows } = await db.query(
        `INSERT INTO attachments (workspace_id, hash, size, content_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING hash`,
        [workspace, hash, body.length, type],
      );
      return reply.code(rows.length === 0 ? 200 : 201).send({ hash, size: body.length });
    },
  );

  app.get<{ Params: Params }>(
    "/api/workspaces/:workspace/attachments/:hash",
    { schema: { params }, preHandler: reader },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      if (!(await (readable.get(request) ?? (() => Promise.resolve(false)))(workspace))) {
        return fail(reply, 404, "This account is in no such workspace.");
      }
      const { rows } = await db.query(
        "SELECT content_type FROM attachments WHERE workspace_id = $1 AND hash = $2",
        [workspace, request.params.hash],
      );
      const data =
        rows.length === 0 ? undefined : await blobs.get(`${workspace}/${request.params.hash}`);
      if (data === undefined) return fail(reply, 404, "This workspace has no such file.");
      const type =
        rows[0]?.content_type === null
          ? "application/octet-stream"
          : readText(rows[0], "content_type");
      return (
        reply
          .header("content-type", type)
          .header("x-content-type-options", "nosniff")
          // A file a member sent runs nothing and loads nothing, whatever it is.
          .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          )
          // Named by its bytes, it never changes.
          .header("cache-control", "private, max-age=31536000, immutable")
          .send(Buffer.from(data))
      );
    },
  );
}
