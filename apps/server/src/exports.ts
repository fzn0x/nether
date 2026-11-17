// Exports made in the apps (ADR 0081): the desktop and web apps make
// Markdown, HTML, PDF and CSV from the vault they hold, which the server
// never sees, and tell the server of each export from a vault linked to a
// workspace, so audit logs record it as `export.made`. What was exported,
// in which format and how many notes: never a note's text. The server can
// vouch only for what it serves; a changed app could stay silent.
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.ts";
import { type ServerEvents, accountActor, originOf } from "./events.ts";
import { fail, uuidField } from "./http.ts";
import { accountOf, signedIn } from "./sessions.ts";
import { membership } from "./workspaces.ts";

export const exportScopes = ["note", "folder", "vault", "view"] as const;
export const exportFormats = ["markdown", "html", "pdf", "csv"] as const;

interface ExportMade {
  readonly scope: (typeof exportScopes)[number];
  readonly format: (typeof exportFormats)[number];
  readonly notes: number;
}

const exportBody = {
  type: "object",
  required: ["scope", "format", "notes"],
  additionalProperties: false,
  properties: {
    scope: { type: "string", enum: exportScopes },
    format: { type: "string", enum: exportFormats },
    notes: { type: "integer", minimum: 0, maximum: 10_000_000 },
  },
} as const;

/** `POST /api/workspaces/:workspace/exports`: an app tells of an export it made, for a member. */
export function registerExports(app: FastifyInstance, db: Database, events: ServerEvents): void {
  app.post<{ Params: { workspace: string }; Body: ExportMade }>(
    "/api/workspaces/:workspace/exports",
    {
      schema: {
        params: { type: "object", required: ["workspace"], properties: { workspace: uuidField } },
        body: exportBody,
      },
      preHandler: signedIn(db),
    },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      const me = accountOf(request).id;
      if ((await membership(db, me, workspace)) === undefined) {
        return fail(reply, 404, "This account is in no such workspace.");
      }
      const { scope, format, notes } = request.body;
      // Nothing is kept unless audit logs are on.
      if (await events.wanted(db)) {
        await db.transaction((tx) =>
          events.emit(
            tx,
            {
              action: "export.made",
              actor: accountActor(me),
              workspace,
              details: { scope, format, notes, reported: true },
            },
            originOf(request),
          ),
        );
      }
      return reply.code(204).send();
    },
  );
}
