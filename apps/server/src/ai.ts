// AI for the web app, through its server (ADR 0070). The server keeps AI
// providers: each account's own, and the instance's, which its admins set
// for everyone; each key sealed with NETHER_SECRET_KEY and never given back.
// The web app's requests come to the relay, which sends only a provider's
// chat and embedding calls, with the provider's model and key, and streams
// the answer back. It refuses an encrypted workspace, whose text must never
// pass through the server, and a workspace whose owners turned AI off. An
// account's own provider reaches public addresses alone, over https; only
// the admin's may reach the server's own network, as NETHER_AI_PRIVATE
// allows. Nothing of what is sent or answered is logged or kept.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Transform, type TransformCallback } from "node:stream";
import { type ProviderKind, apiBase, callOf, callPath, requestHeaders } from "@nether/ai";
import type { FastifyInstance } from "fastify";
import type { AiMode } from "./config.ts";
import { type Database, type Row, readText, readTextOrNull } from "./db.ts";
import { fail, limitBy, nameField, uuidField } from "./http.ts";
import { type PrivatePolicy, type Resolver, open, reachable } from "./outbound.ts";
import { type Seal, SealedElsewhere, sealWith } from "./secrets.ts";
import { type Account, accountOf, signedIn } from "./sessions.ts";

export interface AiOptions {
  readonly mode: AiMode;
  /** Which addresses that are not public the instance's providers may reach. */
  readonly privatePolicy: PrivatePolicy;
  /** The key that seals providers' keys; without one the server keeps none. */
  readonly secretKey: Buffer | null;
  /** What resolves providers' hosts; the system's resolver unless a test gives another. */
  readonly resolve?: Resolver;
  /** How long a provider has to begin its answer, in milliseconds. */
  readonly firstAnswer?: number;
  /** How long an answer may take in all, in milliseconds. */
  readonly wholeAnswer?: number;
}

/** The most providers an account keeps, and the instance. */
export const maxProviders = 20;
/** The most bytes of a provider's answer the relay passes on. */
export const answerLimit = 8 * 1024 * 1024;
/** The most bytes of a request the relay takes. */
const requestLimit = 1024 * 1024;

const off = "AI is off on this server.";
const adminOnly = "Only this server's admins set AI providers here.";
const noProvider = "There is no such AI provider here.";
const noKeys =
  "This server keeps no keys: its admin sets NETHER_SECRET_KEY first. A provider that needs no key still works.";

type Scope = "own" | "instance";

interface NewProvider {
  readonly scope?: Scope;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly url: string;
  readonly model: string;
  readonly key?: string;
}

interface ProviderChange {
  readonly name?: string;
  readonly kind?: ProviderKind;
  readonly url?: string;
  readonly model?: string;
  readonly key?: string | null;
}

const kindField = { type: "string", enum: ["openai", "anthropic"] } as const;
const urlField = { type: "string", minLength: 1, maxLength: 2000 } as const;
const modelField = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;
const keyField = { type: "string", maxLength: 2000 } as const;

const providerParams = {
  type: "object",
  required: ["provider"],
  properties: { provider: uuidField },
} as const;

const relayParams = {
  type: "object",
  required: ["workspace", "provider", "*"],
  properties: { workspace: uuidField, provider: uuidField, "*": { type: "string" } },
} as const;

/**
 * Why a provider's address cannot be kept, or undefined when it can. An
 * account's own is https:// and, when its host is an address, a public one;
 * the instance's may be http:// and a private address the admin allows.
 */
export function urlProblem(text: string, scope: Scope, policy: PrivatePolicy): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "This is not an address.";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return "A provider's address has no user, password, query or fragment in it.";
  }
  const http = url.protocol === "http:";
  if (url.protocol !== "https:" && !(http && scope === "instance" && policy !== false)) {
    return scope === "own"
      ? "An account's provider is reached over https://."
      : "A provider is reached over https://, or http:// on a network NETHER_AI_PRIVATE allows.";
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") return "This address has no host.";
  if (isIP(host) !== 0 && !reachable(scope === "own" ? false : policy, host)) {
    return scope === "own"
      ? "An account's provider is at a public address."
      : "This address is not a public one, and NETHER_AI_PRIVATE allows no other.";
  }
  return undefined;
}

/** A provider as its account, or every account for the instance's, sees it: never its key. */
function shown(row: Row) {
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    kind: readText(row, "kind"),
    url: readText(row, "url"),
    model: readText(row, "model"),
    hasKey: row.key_box instanceof Uint8Array,
    scope: readTextOrNull(row, "user_id") === null ? "instance" : "own",
  };
}

/** Counts the bytes of an answer it passes on, and stops past the limit. */
function limited(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      seen += chunk.length;
      if (seen > limit) {
        done(new Error("The provider's answer is longer than the server passes on."));
        return;
      }
      done(null, chunk);
    },
  });
}

export function registerAi(app: FastifyInstance, db: Database, options: AiOptions): void {
  const account = signedIn(db);
  const seal: Seal | undefined =
    options.secretKey === null ? undefined : sealWith(options.secretKey);
  const { mode } = options;

  /** The providers an account may use, the instance's first. */
  async function visible(me: Account): Promise<Row[]> {
    if (mode === "off") return [];
    const { rows } = await db.query(
      `SELECT id, user_id, name, kind, url, model, key_box FROM ai_providers
        WHERE user_id IS NULL OR (user_id = $1 AND $2::boolean)
        ORDER BY user_id IS NOT NULL, created_at, id`,
      [me.id, mode === "on"],
    );
    return rows;
  }

  /** One provider an account may use, or undefined. */
  async function usable(me: Account, id: string): Promise<Row | undefined> {
    return (await visible(me)).find((row) => readText(row, "id") === id.toLowerCase());
  }

  /** One provider an account may change: its own, or as an admin the instance's. */
  async function changeable(me: Account, id: string): Promise<Row | undefined> {
    const row = await usable(me, id);
    if (row === undefined) return undefined;
    const instance = readTextOrNull(row, "user_id") === null;
    return (instance ? me.instanceAdmin : true) ? row : undefined;
  }

  const sealed = (key: string, id: string): Uint8Array | undefined =>
    key === "" ? undefined : seal?.seal(key, id);

  app.get("/api/ai", { preHandler: account }, async (request) => {
    const me = accountOf(request);
    const rows = await visible(me);
    const { rows: chosen } = await db.query(
      "SELECT provider_id FROM ai_defaults WHERE user_id = $1",
      [me.id],
    );
    const ids = rows.map((row) => readText(row, "id"));
    const wanted = chosen[0] === undefined ? null : readText(chosen[0], "provider_id");
    return {
      mode,
      keepsKeys: seal !== undefined,
      manage: { own: mode === "on", instance: mode !== "off" && me.instanceAdmin },
      providers: rows.map(shown),
      default: wanted !== null && ids.includes(wanted) ? wanted : (ids[0] ?? ""),
    };
  });

  app.post<{ Body: NewProvider }>(
    "/api/ai/providers",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "kind", "url", "model"],
          additionalProperties: false,
          properties: {
            scope: { type: "string", enum: ["own", "instance"] },
            name: nameField,
            kind: kindField,
            url: urlField,
            model: modelField,
            key: keyField,
          },
        },
      },
      preHandler: account,
    },
    async (request, reply) => {
      const me = accountOf(request);
      const scope = request.body.scope ?? "own";
      if (mode === "off") return fail(reply, 403, off);
      if (scope === "instance" ? !me.instanceAdmin : mode !== "on") {
        return fail(reply, 403, adminOnly);
      }
      const url = request.body.url.trim().replace(/\/+$/, "");
      const problem = urlProblem(url, scope, options.privatePolicy);
      if (problem !== undefined) return fail(reply, 400, problem);
      const key = request.body.key ?? "";
      if (key !== "" && seal === undefined) return fail(reply, 409, noKeys);
      const { rows: counted } = await db.query(
        "SELECT count(*) AS count FROM ai_providers WHERE user_id IS NOT DISTINCT FROM $1",
        [scope === "own" ? me.id : null],
      );
      if (Number(counted[0]?.count ?? 0) >= maxProviders) {
        return fail(
          reply,
          409,
          `An account, and the instance, keep ${String(maxProviders)} providers at most.`,
        );
      }
      const id = randomUUID();
      const { rows } = await db.query(
        `INSERT INTO ai_providers (id, user_id, name, kind, url, model, key_box)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, name, kind, url, model, key_box`,
        [
          id,
          scope === "own" ? me.id : null,
          request.body.name.trim(),
          request.body.kind,
          url,
          request.body.model.trim(),
          sealed(key, id) ?? null,
        ],
      );
      return reply.code(201).send(shown(rows[0] ?? {}));
    },
  );

  app.patch<{ Params: { provider: string }; Body: ProviderChange }>(
    "/api/ai/providers/:provider",
    {
      schema: {
        params: providerParams,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            name: nameField,
            kind: kindField,
            url: urlField,
            model: modelField,
            key: { anyOf: [keyField, { type: "null" }] },
          },
        },
      },
      preHandler: account,
    },
    async (request, reply) => {
      const me = accountOf(request);
      const row = await changeable(me, request.params.provider);
      if (row === undefined) return fail(reply, 404, noProvider);
      const id = readText(row, "id");
      const scope: Scope = readTextOrNull(row, "user_id") === null ? "instance" : "own";
      const change = request.body;
      const url = change.url?.trim().replace(/\/+$/, "") ?? readText(row, "url");
      const problem = urlProblem(url, scope, options.privatePolicy);
      if (problem !== undefined) return fail(reply, 400, problem);
      if (typeof change.key === "string" && change.key !== "" && seal === undefined) {
        return fail(reply, 409, noKeys);
      }
      const box =
        change.key === undefined
          ? row.key_box
          : change.key === null
            ? null
            : (sealed(change.key, id) ?? null);
      const { rows } = await db.query(
        `UPDATE ai_providers SET name = $2, kind = $3, url = $4, model = $5, key_box = $6
          WHERE id = $1 RETURNING id, user_id, name, kind, url, model, key_box`,
        [
          id,
          change.name?.trim() ?? readText(row, "name"),
          change.kind ?? readText(row, "kind"),
          url,
          change.model?.trim() ?? readText(row, "model"),
          box,
        ],
      );
      return shown(rows[0] ?? {});
    },
  );

  app.delete<{ Params: { provider: string } }>(
    "/api/ai/providers/:provider",
    { schema: { params: providerParams }, preHandler: account },
    async (request, reply) => {
      const row = await changeable(accountOf(request), request.params.provider);
      if (row === undefined) return fail(reply, 404, noProvider);
      await db.query("DELETE FROM ai_providers WHERE id = $1", [readText(row, "id")]);
      return reply.code(204).send();
    },
  );

  app.put<{ Body: { readonly provider: string } }>(
    "/api/ai/default",
    {
      schema: {
        body: {
          type: "object",
          required: ["provider"],
          additionalProperties: false,
          properties: { provider: uuidField },
        },
      },
      preHandler: account,
    },
    async (request, reply) => {
      const me = accountOf(request);
      const row = await usable(me, request.body.provider);
      if (row === undefined) return fail(reply, 404, noProvider);
      await db.query(
        `INSERT INTO ai_defaults (user_id, provider_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET provider_id = EXCLUDED.provider_id`,
        [me.id, readText(row, "id")],
      );
      return reply.code(204).send();
    },
  );

  // The relay: a provider's chat or embedding call, sent as the web app's
  // adapter wrote it, with the provider's model and key, its answer streamed back.
  app.post<{
    Params: { workspace: string; provider: string; "*": string };
    Body: Record<string, unknown>;
  }>(
    "/api/workspaces/:workspace/ai/:provider/*",
    {
      schema: { params: relayParams, body: { type: "object" } },
      bodyLimit: requestLimit,
      preHandler: [
        account,
        limitBy(app, "ai-relay", 60, "1 minute", (request) => accountOf(request).id),
      ],
    },
    async (request, reply) => {
      const me = accountOf(request);
      if (mode === "off") return fail(reply, 403, off);
      const workspace = request.params.workspace.toLowerCase();
      const { rows: places } = await db.query(
        `SELECT w.encryption, w.ai FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.workspace_id = $1 AND m.user_id = $2`,
        [workspace, me.id],
      );
      const place = places[0];
      if (place === undefined) return fail(reply, 404, "This account is in no such workspace.");
      if (readText(place, "encryption") === "end-to-end") {
        return fail(
          reply,
          403,
          "An end-to-end encrypted workspace's text never goes through its server: the desktop app offers AI for it.",
        );
      }
      if (place.ai !== true) {
        return fail(reply, 403, "This workspace's owners or admins have turned AI off for it.");
      }
      const row = await usable(me, request.params.provider);
      if (row === undefined) return fail(reply, 404, noProvider);
      const kind: ProviderKind = readText(row, "kind") === "anthropic" ? "anthropic" : "openai";
      const call = callOf(kind, `/${request.params["*"]}`);
      const path = call === undefined ? undefined : callPath(kind, call);
      if (path === undefined)
        return fail(reply, 404, "A provider is asked only to chat or to embed.");
      const id = readText(row, "id");
      let key: string | undefined;
      if (row.key_box instanceof Uint8Array) {
        if (seal === undefined) {
          return fail(
            reply,
            409,
            "This provider's key was kept with a NETHER_SECRET_KEY this server no longer has.",
          );
        }
        try {
          key = seal.open(row.key_box, id);
        } catch (error) {
          if (error instanceof SealedElsewhere) return fail(reply, 409, error.message);
          throw error;
        }
      }
      const instance = readTextOrNull(row, "user_id") === null;
      // The provider's model, whatever the page asked for.
      const body = JSON.stringify({ ...request.body, model: readText(row, "model") });
      const opened = await open(
        `${apiBase(kind, readText(row, "url"))}${path}`,
        requestHeaders(kind, key),
        body,
        {
          policy: instance ? options.privatePolicy : false,
          allowedBy: "NETHER_AI_PRIVATE",
          timeout: options.firstAnswer ?? 120_000,
          ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
        },
      );
      if (!opened.ok) return fail(reply, 502, opened.error);
      const { answer, close } = opened;
      // The page gone, or the answer too long in coming, ends the provider's request.
      const whole = setTimeout(close, options.wholeAnswer ?? 600_000);
      reply.raw.on("close", () => {
        clearTimeout(whole);
        close();
      });
      const type = answer.headers["content-type"] ?? "";
      const stream = answer.pipe(limited(answerLimit));
      answer.on("error", (error) => stream.destroy(error));
      return reply
        .code(answer.statusCode ?? 502)
        .header(
          "content-type",
          /^(text\/event-stream|application\/json)/i.test(type)
            ? type
            : "text/plain; charset=utf-8",
        )
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .send(stream);
    },
  );
}
