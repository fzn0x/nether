// A SCIM directory's server (ADR 0085, RFC 7644): at
// NETHER_PUBLIC_URL/api/scim/<directory>/v2, for the directory's own
// bearer token alone, `/Users` and the discovery endpoints. Requests are
// `application/scim+json` or `application/json`, up to 4 MB; answers are
// SCIM's, errors too. Everything a request changes is one transaction,
// with its events; an account's connections close once it commits.
// Requests with a wrong token are limited by address; a directory's own
// are not, as a first sync sends one or more for each person.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import type { DataPolicies } from "@nether/server/src/dataPolicies.ts";
import type { Database, Queryable } from "@nether/server/src/db.ts";
import { type ServerEvents, originOf } from "@nether/server/src/events.ts";
import { cannotCount, tooManyTries } from "@nether/server/src/http.ts";
import { bearerToken } from "@nether/server/src/sessions.ts";
import { type Directory, directoryByToken, directoryIdPattern } from "./directories.ts";
import {
  listOf,
  mostResults,
  serviceProviderConfig,
  userResourceType,
  userSchema,
} from "./discovery.ts";
import { ScimError, sendError, sendScim } from "./errors.ts";
import { coreUserSchema, parseFilter } from "./paths.ts";
import { applyPatch, docFromResource, operationsOf } from "./userDoc.ts";
import {
  type UserContext,
  type UserRow,
  docOf,
  findUser,
  groupsOf,
  heldMessage,
  listUsers,
  removeUser,
  resourceOf,
  writeUser,
} from "./users.ts";

/** A request's body, as large as a group's whole list of members needs. */
const bodyLimit = 4 * 1024 * 1024;

/** Requests with a wrong token an address may send in the window. */
const wrongTries = 30;

/** Results a page holds unless asked for another number. */
const defaultCount = 100;

export interface ScimContext {
  readonly db: Database;
  readonly config: Config;
  readonly events: ServerEvents;
  readonly disconnect: (userId: string) => void;
  readonly dataPolicies: DataPolicies;
  readonly whenOn: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

interface Params {
  readonly directory: string;
}

interface UserParams extends Params {
  readonly id: string;
}

interface ListQuery {
  readonly filter?: string;
  readonly startIndex?: string;
  readonly count?: string;
  readonly attributes?: string;
  readonly excludedAttributes?: string;
}

const idPattern = new RegExp(directoryIdPattern);

/** A directory's base address, where its token works. */
export function scimBase(config: Config, directory: string): string | null {
  return config.publicUrl === null ? null : `${config.publicUrl}/api/scim/${directory}/v2`;
}

/** A whole number from a query, as SCIM's paging sends it. */
function whole(text: string | undefined, name: string): number | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new ScimError(400, `${name} is a whole number.`, "invalidValue");
  }
  return value;
}

/** The top-level attribute names a query lists, lowercase, after any schema's URN. */
function namesOf(text: string | undefined): Set<string> | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  return new Set(
    text.split(",").map((each) => {
      const name = each.trim();
      const plain = name.toLowerCase().startsWith("urn:") ? (name.split(":").at(-1) ?? "") : name;
      return (plain.split(".")[0] ?? "").toLowerCase();
    }),
  );
}

/** A resource with only the attributes asked for, or without those left out; id and schemas always. */
export function projected(
  resource: Record<string, unknown>,
  attributes: string | undefined,
  excluded: string | undefined,
): Record<string, unknown> {
  const only = namesOf(attributes);
  const without = namesOf(excluded);
  return Object.fromEntries(
    Object.entries(resource).filter(([key]) => {
      const lower = key.toLowerCase();
      if (lower === "id" || lower === "schemas") return true;
      if (only !== undefined) return only.has(lower);
      return without?.has(lower) !== true;
    }),
  );
}

export function registerScim(app: FastifyInstance, context: ScimContext): void {
  const { db, config, events, disconnect, dataPolicies, whenOn } = context;
  const wrongToken = app.createRateLimit({
    max: wrongTries,
    timeWindow: "5 minutes",
    keyGenerator: (request) => `scim-token:${request.ip}`,
  });
  const directories = new WeakMap<FastifyRequest, Directory>();

  void app.register((scim, _options, done) => {
    // SCIM's own media type, read as JSON is.
    scim.addContentTypeParser(
      ["application/scim+json"],
      { parseAs: "string", bodyLimit },
      (_request, body, parsed) => {
        try {
          parsed(null, JSON.parse(String(body)) as unknown);
        } catch {
          parsed(new ScimError(400, "The body is not JSON.", "invalidSyntax"), undefined);
        }
      },
    );
    scim.setErrorHandler((error: FastifyError | ScimError, request, reply) => {
      if (error instanceof ScimError) return sendError(reply, error);
      const status = error.statusCode ?? 500;
      if (status < 500) {
        return sendError(
          reply,
          new ScimError(status, error.message, status === 400 ? "invalidSyntax" : undefined),
        );
      }
      request.log.error({ err: error }, "A SCIM request failed");
      return sendError(reply, new ScimError(500, "The server could not do this: try again."));
    });

    /** The directory a request's token is, at its own address; 401 otherwise. */
    const authorized = async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      const token = bearerToken(request.headers.authorization);
      const id = request.params.directory;
      const directory =
        token === undefined || !idPattern.test(id)
          ? undefined
          : await directoryByToken(db, id, token);
      if (directory !== undefined) {
        directories.set(request, directory);
        return;
      }
      let limit;
      try {
        limit = await wrongToken(request);
      } catch (error) {
        request.log.error({ err: error }, "Could not count a try against a rate limit");
        reply.header("retry-after", "60");
        throw new ScimError(503, cannotCount);
      }
      if (!limit.isAllowed && limit.isExceeded) {
        reply.header("retry-after", String(limit.ttlInSeconds));
        throw new ScimError(429, tooManyTries(limit.ttlInSeconds));
      }
      reply.header("www-authenticate", "Bearer");
      throw new ScimError(
        401,
        "This token is not this directory's, or has ended: make one on the console's Directories page.",
      );
    };
    const guarded = { preHandler: [whenOn, authorized], bodyLimit };
    const directoryOf = (request: FastifyRequest): Directory => {
      const directory = directories.get(request);
      if (directory === undefined) throw new Error("This route has no token check.");
      return directory;
    };
    const contextOf = (request: FastifyRequest): UserContext => {
      const directory = directoryOf(request);
      return {
        directory,
        events,
        by: {
          actor: { kind: "directory", id: directory.id, name: directory.name },
          origin: originOf(request),
        },
      };
    };
    /** A discovery endpoint takes no filter, as RFC 7644 suggests. */
    const noFilter = (request: FastifyRequest) => {
      if ((request.query as { filter?: unknown }).filter !== undefined) {
        throw new ScimError(403, "A discovery endpoint takes no filter.");
      }
    };
    const prefix = "/api/scim/:directory/v2";

    scim.get<{ Params: Params }>(`${prefix}/ServiceProviderConfig`, guarded, (request, reply) => {
      noFilter(request);
      return sendScim(reply, 200, serviceProviderConfig(scimBase(config, directoryOf(request).id)));
    });

    scim.get<{ Params: Params }>(`${prefix}/ResourceTypes`, guarded, (request, reply) => {
      noFilter(request);
      return sendScim(
        reply,
        200,
        listOf([userResourceType(scimBase(config, directoryOf(request).id))]),
      );
    });

    scim.get<{ Params: Params & { name: string } }>(
      `${prefix}/ResourceTypes/:name`,
      guarded,
      (request, reply) => {
        if (request.params.name.toLowerCase() !== "user") {
          throw new ScimError(404, `There is no resource type ${request.params.name}.`);
        }
        return sendScim(reply, 200, userResourceType(scimBase(config, directoryOf(request).id)));
      },
    );

    scim.get<{ Params: Params }>(`${prefix}/Schemas`, guarded, (request, reply) => {
      noFilter(request);
      return sendScim(reply, 200, listOf([userSchema(scimBase(config, directoryOf(request).id))]));
    });

    scim.get<{ Params: Params & { id: string } }>(
      `${prefix}/Schemas/:id`,
      guarded,
      (request, reply) => {
        if (request.params.id.toLowerCase() !== coreUserSchema.toLowerCase()) {
          throw new ScimError(404, `There is no schema ${request.params.id}.`);
        }
        return sendScim(reply, 200, userSchema(scimBase(config, directoryOf(request).id)));
      },
    );

    /** A user as the directory sees it, with its groups. */
    async function shown(directory: Directory, row: UserRow): Promise<Record<string, unknown>> {
      const groups = await groupsOf(db, directory.id, [row.userId]);
      return resourceOf(row, groups.get(row.userId) ?? [], scimBase(config, directory.id));
    }

    async function answerUser(
      reply: FastifyReply,
      directory: Directory,
      userId: string,
      status: number,
    ): Promise<FastifyReply> {
      const row = await findUser(db, directory.id, userId);
      if (row === undefined) throw new ScimError(404, "There is no such user.");
      const resource = await shown(directory, row);
      if (status === 201) {
        const location = (resource.meta as { location?: string }).location;
        if (location !== undefined) reply.header("location", location);
      }
      return sendScim(reply, status, resource);
    }

    /** Runs a change in one transaction, then closes the connections of accounts it deactivated. */
    async function changing<T>(
      work: (tx: Queryable, closing: Set<string>) => Promise<T>,
    ): Promise<T> {
      const closing = new Set<string>();
      const result = await db.transaction((tx) => work(tx, closing));
      for (const userId of closing) disconnect(userId);
      return result;
    }

    scim.get<{ Params: Params; Querystring: ListQuery }>(
      `${prefix}/Users`,
      guarded,
      async (request, reply) => {
        const directory = directoryOf(request);
        const { filter, attributes, excludedAttributes } = request.query;
        const comparisons = filter === undefined || filter.trim() === "" ? [] : parseFilter(filter);
        // Less than 1 is 1, and a count past the most is the most (RFC 7644, 3.4.2.4).
        const startIndex = Math.max(1, whole(request.query.startIndex, "startIndex") ?? 1);
        const count = Math.min(
          mostResults,
          Math.max(0, whole(request.query.count, "count") ?? defaultCount),
        );
        const page = await listUsers(db, directory.id, comparisons, startIndex, count);
        const groups = await groupsOf(
          db,
          directory.id,
          page.rows.map((row) => row.userId),
        );
        const base = scimBase(config, directory.id);
        const resources = page.rows.map((row) =>
          projected(
            resourceOf(row, groups.get(row.userId) ?? [], base),
            attributes,
            excludedAttributes,
          ),
        );
        return sendScim(reply, 200, listOf(resources, page.total, startIndex));
      },
    );

    scim.get<{ Params: UserParams; Querystring: ListQuery }>(
      `${prefix}/Users/:id`,
      guarded,
      async (request, reply) => {
        const directory = directoryOf(request);
        const row = await findUser(db, directory.id, request.params.id);
        if (row === undefined) throw new ScimError(404, "There is no such user.");
        const { attributes, excludedAttributes } = request.query;
        return sendScim(
          reply,
          200,
          projected(await shown(directory, row), attributes, excludedAttributes),
        );
      },
    );

    scim.post<{ Params: Params }>(`${prefix}/Users`, guarded, async (request, reply) => {
      const user = contextOf(request);
      const doc = docFromResource(request.body, true);
      const written = await changing(async (tx, closing) => {
        const done = await writeUser(tx, user, undefined, doc);
        if (done.disconnect) closing.add(done.userId);
        return done;
      });
      return answerUser(reply, user.directory, written.userId, 201);
    });

    scim.put<{ Params: UserParams }>(`${prefix}/Users/:id`, guarded, async (request, reply) => {
      const user = contextOf(request);
      const written = await changing(async (tx, closing) => {
        const row = await findUser(tx, user.directory.id, request.params.id, true);
        if (row === undefined) throw new ScimError(404, "There is no such user.");
        // What it leaves out is replaced, but active: left out, it stays as it is.
        const done = await writeUser(
          tx,
          user,
          row,
          docFromResource(request.body, !row.deactivated),
        );
        if (done.disconnect) closing.add(done.userId);
        return done;
      });
      return answerUser(reply, user.directory, written.userId, 200);
    });

    scim.patch<{ Params: UserParams }>(`${prefix}/Users/:id`, guarded, async (request, reply) => {
      const user = contextOf(request);
      const operations = operationsOf(request.body);
      const written = await changing(async (tx, closing) => {
        const row = await findUser(tx, user.directory.id, request.params.id, true);
        if (row === undefined) throw new ScimError(404, "There is no such user.");
        const done = await writeUser(tx, user, row, applyPatch(docOf(row), operations));
        if (done.disconnect) closing.add(done.userId);
        return done;
      });
      return answerUser(reply, user.directory, written.userId, 200);
    });

    scim.delete<{ Params: UserParams }>(`${prefix}/Users/:id`, guarded, async (request, reply) => {
      const user = contextOf(request);
      // Read before the transaction, as the policies are kept for a few seconds.
      const policies = await dataPolicies.all();
      const removed = await changing(async (tx, closing) => {
        const row = await findUser(tx, user.directory.id, request.params.id, true);
        if (row === undefined) throw new ScimError(404, "There is no such user.");
        const done = await removeUser(tx, user, row, policies);
        if (done.disconnect) closing.add(row.userId);
        return done;
      });
      // Deactivated and kept, the removal waits for the hold to end: the
      // provider tries again in a later cycle.
      if (removed.held) throw new ScimError(403, heldMessage);
      return reply.code(204).send();
    });

    done();
  });
}
