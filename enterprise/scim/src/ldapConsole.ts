// An LDAP directory on the console's Directories page (ADR 0085): its
// settings, its bind password sealed with NETHER_SECRET_KEY and bound to
// the directory, its address and its DN, so changing either asks for the
// password again; Test the connection, which binds and reads a few people
// and groups; and Sync now, confirming the first run's preview, or Run
// anyway, after a run held back. Each run's result is shown.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "@nether/server/src/config.ts";
import {
  type Database,
  type Queryable,
  readBoolean,
  readTextOrNull,
} from "@nether/server/src/db.ts";
import {
  type EventActor,
  type ServerEvents,
  accountActor,
  originOf,
} from "@nether/server/src/events.ts";
import { instanceAdmin } from "@nether/server/src/features.ts";
import { fail } from "@nether/server/src/http.ts";
import { SealedElsewhere, sealWith } from "@nether/server/src/secrets.ts";
import { accountOf, signedIn } from "@nether/server/src/sessions.ts";
import { findDirectory } from "./directories.ts";
import { LdapFailure, openLdap, searchSome } from "./ldapConnect.ts";
import { attributesRead, stableId, textsOf } from "./ldapRead.ts";
import { type LdapRuns, type RunResult, syncStateOf } from "./ldapRuns.ts";
import {
  type LdapInput,
  type LdapSettings,
  type Membership,
  SettingRefused,
  keptSettings,
  passwordOwner,
  presets,
  settingsOf,
} from "./ldapSettings.ts";

/** What the console sends of an LDAP directory: its settings, and the bind password when it changes. */
export interface LdapBody extends LdapInput {
  readonly password?: string;
}

/** An LDAP directory's settings as the page shows them, never its password. */
export interface LdapView {
  readonly url: string;
  readonly ca: string | null;
  readonly fingerprint: string | null;
  readonly bindDn: string;
  readonly peopleBase: string;
  readonly peopleFilter: string;
  readonly groupsBase: string;
  readonly groupsFilter: string;
  readonly idAttribute: string;
  readonly idIsGuid: boolean;
  readonly userNameAttribute: string;
  readonly emailAttribute: string;
  readonly nameAttributes: readonly string[];
  readonly groupNameAttribute: string;
  readonly membership: Membership;
  readonly everyMinutes: number;
  readonly holdPercent: number;
  readonly passwordSet: boolean;
  /** Whether a run is on now, on any node. */
  readonly running: boolean;
  /** Whether an instance admin confirmed the first run's preview. */
  readonly confirmed: boolean;
  /** When the next run is due, once confirmed. */
  readonly nextAt: string | null;
  readonly last: RunResult | null;
}

/** Settings as the form reads and sends them. */
export function inputOf(settings: LdapSettings): Required<LdapInput> {
  return {
    url: settings.url,
    ca: settings.ca,
    fingerprint: settings.fingerprint,
    bindDn: settings.bindDn,
    peopleBase: settings.people.base,
    peopleFilter: settings.people.filter,
    groupsBase: settings.groups.base,
    groupsFilter: settings.groups.filter,
    idAttribute: settings.attributes.id,
    idIsGuid: settings.attributes.idIsGuid,
    userNameAttribute: settings.attributes.userName,
    emailAttribute: settings.attributes.email,
    nameAttributes: settings.attributes.name,
    groupNameAttribute: settings.attributes.groupName,
    membership: settings.membership,
    everyMinutes: settings.everyMinutes,
    holdPercent: settings.holdPercent,
  };
}

/** The presets the form starts from, as it reads them. */
export function presetInputs(): Record<string, Partial<LdapInput>> {
  return Object.fromEntries(
    Object.entries(presets).map(([name, preset]) => [
      name,
      {
        peopleFilter: preset.people.filter,
        groupsFilter: preset.groups.filter,
        idAttribute: preset.attributes.id,
        idIsGuid: preset.attributes.idIsGuid,
        userNameAttribute: preset.attributes.userName,
        emailAttribute: preset.attributes.email,
        nameAttributes: preset.attributes.name,
        groupNameAttribute: preset.attributes.groupName,
        membership: preset.membership,
      },
    ]),
  );
}

/** An LDAP directory's settings and runs, as the page shows them. */
export async function ldapView(db: Queryable, id: string): Promise<LdapView | null> {
  const { rows } = await db.query(
    `SELECT settings, secrets IS NOT NULL AS password_set, sync_state,
            coalesce(syncing_until > now(), false) AS running,
            CASE WHEN (sync_state->>'confirmed')::boolean IS TRUE
                 THEN coalesce((sync_state->>'startedAt')::timestamptz, now())
                      + make_interval(mins => coalesce((settings->>'everyMinutes')::int, 60))
            END AS next_at
       FROM directories WHERE id = $1 AND kind = 'ldap'`,
    [id],
  );
  const row = rows[0];
  const settings = keptSettings(row?.settings);
  if (row === undefined || settings === undefined) return null;
  const state = syncStateOf(row.sync_state);
  const next = row.next_at;
  return {
    ...inputOf(settings),
    passwordSet: readBoolean(row, "password_set"),
    running: readBoolean(row, "running"),
    confirmed: state.confirmed,
    nextAt: next instanceof Date ? next.toISOString() : readTextOrNull(row, "next_at"),
    last: state.last,
  };
}

/** A setting refused, with the status to answer it with. */
export class LdapRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const noSecretKey =
  "LDAP needs NETHER_SECRET_KEY on the server, which keeps the bind password sealed.";

/**
 * The settings and the sealed password a directory keeps, from what the
 * console sent and what it kept: a new directory needs the password, and
 * a new address or bind DN asks for it again, so a kept password never
 * goes to an address it was not given for.
 */
export function ldapWrite(
  config: Config,
  id: string,
  body: LdapBody,
  kept: LdapSettings | undefined,
): { readonly settings: LdapSettings; readonly secrets: Buffer | undefined } {
  if (config.secretKey === null) throw new LdapRefused(400, noSecretKey);
  let settings: LdapSettings;
  try {
    settings = settingsOf(body, kept);
  } catch (error) {
    if (error instanceof SettingRefused) throw new LdapRefused(400, error.message);
    throw error;
  }
  const password = body.password;
  if (password === undefined) {
    if (kept === undefined) throw new LdapRefused(400, "Give the bind password.");
    if (settings.url !== kept.url || settings.bindDn !== kept.bindDn) {
      throw new LdapRefused(
        400,
        "A new address or bind DN asks for the bind password again, so it never goes where it was not given for.",
      );
    }
    return { settings, secrets: undefined };
  }
  const box = sealWith(config.secretKey).seal(password, passwordOwner(id, settings));
  return { settings, secrets: Buffer.from(box) };
}

export interface LdapConsoleContext {
  readonly db: Database;
  readonly config: Config;
  readonly events: ServerEvents;
  readonly runs: LdapRuns;
  readonly whenOn: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<FastifyReply | undefined>;
}

interface Params {
  readonly id: string;
}

const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 32 } },
} as const;

const syncBody = {
  type: "object",
  additionalProperties: false,
  properties: { confirm: { type: "boolean" }, anyway: { type: "boolean" } },
} as const;

/** How many people and groups testing a connection reads. */
const sampleSize = 5;

/** The routes that test an LDAP directory's connection and run it. */
export function registerLdapConsole(app: FastifyInstance, context: LdapConsoleContext): void {
  const { db, config, events, runs, whenOn } = context;
  const account = signedIn(db);
  const admins = (what: string) => ({ preHandler: [whenOn, account, instanceAdmin(what)] });
  const actorOf = (request: FastifyRequest): EventActor => accountActor(accountOf(request).id);

  /** An LDAP directory's settings and bind password, or the answer that says why there are none. */
  async function loaded(
    id: string,
  ): Promise<{ settings: LdapSettings; password: string } | LdapRefused> {
    const directory = await findDirectory(db, id);
    if (directory === undefined) return new LdapRefused(404, "There is no such directory.");
    if (directory.kind !== "ldap") {
      return new LdapRefused(400, "Only an LDAP directory is read by the server.");
    }
    const { rows } = await db.query("SELECT settings, secrets FROM directories WHERE id = $1", [
      id,
    ]);
    const settings = keptSettings(rows[0]?.settings);
    const box = rows[0]?.secrets;
    if (settings === undefined) {
      return new LdapRefused(400, "This directory's settings are not complete: change them first.");
    }
    if (config.secretKey === null) return new LdapRefused(400, noSecretKey);
    if (!(box instanceof Uint8Array)) {
      return new LdapRefused(400, "This directory has no bind password: set it first.");
    }
    try {
      return {
        settings,
        password: sealWith(config.secretKey).open(box, passwordOwner(id, settings)),
      };
    } catch (error) {
      if (error instanceof SealedElsewhere) return new LdapRefused(400, error.message);
      throw error;
    }
  }

  // Binds and reads a few people and groups, so the admin sees the
  // settings read what they meant; changes nothing.
  app.post<{ Params: Params }>(
    "/api/admin/directories/:id/test",
    { ...admins("test directories"), schema: { params } },
    async (request, reply) => {
      const found = await loaded(request.params.id);
      if (found instanceof LdapRefused) return fail(reply, found.status, found.message);
      const { settings, password } = found;
      const read = attributesRead(settings);
      try {
        const connection = await openLdap(settings, password, runs.reach());
        try {
          const people = await searchSome(
            connection.client,
            {
              base: settings.people.base,
              filter: settings.people.filter,
              attributes: read.people,
              binary: read.binary,
              what: "people",
            },
            sampleSize,
          );
          const groups = await searchSome(
            connection.client,
            {
              base: settings.groups.base,
              filter: settings.groups.filter,
              attributes: read.groups,
              binary: read.binary,
              what: "groups",
            },
            sampleSize,
          );
          const { attributes } = settings;
          return {
            people: people.map((entry) => ({
              dn: entry.dn,
              id: stableId(entry, settings) ?? null,
              userName: textsOf(entry, attributes.userName)[0] ?? null,
              email: textsOf(entry, attributes.email)[0] ?? null,
              name:
                attributes.name
                  .map((each) => textsOf(entry, each)[0])
                  .find((each) => each !== undefined) ?? null,
            })),
            groups: groups.map((entry) => ({
              dn: entry.dn,
              id: stableId(entry, settings) ?? null,
              name: textsOf(entry, attributes.groupName)[0] ?? null,
            })),
          };
        } finally {
          await connection.close();
        }
      } catch (error) {
        if (error instanceof LdapFailure) return fail(reply, 400, error.message);
        throw error;
      }
    },
  );

  // Starts a run at once: a preview until the first is confirmed, and,
  // after a run held back, Run anyway applies it once.
  app.post<{ Params: Params; Body: { confirm?: boolean; anyway?: boolean } | undefined }>(
    "/api/admin/directories/:id/sync",
    { ...admins("run directories"), schema: { params, body: syncBody } },
    async (request, reply) => {
      const { id } = request.params;
      const confirm = request.body?.confirm === true;
      const anyway = request.body?.anyway === true;
      const directory = await findDirectory(db, id);
      if (directory === undefined) return fail(reply, 404, "There is no such directory.");
      if (directory.kind !== "ldap") {
        return fail(reply, 400, "Only an LDAP directory is read by the server.");
      }
      const { rows } = await db.query("SELECT sync_state FROM directories WHERE id = $1", [id]);
      const state = syncStateOf(rows[0]?.sync_state);
      if (anyway && state.last?.outcome !== "held") {
        return fail(reply, 409, "No run of this directory is held back.");
      }
      if (confirm && state.last?.outcome !== "preview" && !state.confirmed) {
        return fail(reply, 409, "Look at a preview first: Sync now makes one.");
      }
      // Confirming a preview and running anyway are an admin's changes, told of as theirs.
      const tell =
        confirm || anyway
          ? (tx: Queryable) =>
              events.emit(
                tx,
                {
                  action: "directory.changed",
                  actor: actorOf(request),
                  target: { type: "directory", id, name: directory.name },
                  details: { run: confirm ? "preview confirmed" : "run anyway" },
                },
                originOf(request),
              )
          : undefined;
      const started = await runs.start(id, { confirm, anyway }, tell);
      if (!started) return fail(reply, 409, "A run of this directory is on now.");
      return reply.code(202).send({ running: true });
    },
  );
}
