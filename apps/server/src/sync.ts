// Sync (ADR 0035). Each note's Yjs document, and each workspace's vault
// document, which lists its notes, syncs over one WebSocket per client at
// /api/sync, through Hocuspocus. A client signs each document in with its
// session's token: a workspace's members sync its documents, and its guests
// only read them. A document is kept in PostgreSQL as its state, numbered
// from one sequence each time it is stored, so a client that was away asks
// which documents changed since the last number it saw and syncs those
// alone; the numbers are drawn in the order stores commit (ADR 0082), so
// it never reads past one; a client syncing the vault document hears of
// each note as it is stored. Storing a note keeps the state it replaces as a version, now and
// then (ADR 0041). Each sync unit (ADR 0042) has a vault document of its own;
// a document opens at its unit's level for the account, read-only below edit,
// and the list of stored documents names only those of the account's units.
import websocket from "@fastify/websocket";
import { Hocuspocus, type LocalTransactionOrigin } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import type { Closable } from "./cluster.ts";
import { type Database, type Queryable, readBytes, readCount, readText } from "./db.ts";
import { socketCookieToken } from "./cookies.ts";
import { fail, uuidField } from "./http.ts";
import { lockNumbers } from "./numbers.ts";
import { hasWebhooks, keepListChanges, keepNoteChange } from "./outbox.ts";
import { indexNote, indexPaths, pathsOf, titleOf } from "./search.ts";
import { sessionAccount, signedIn, accountOf } from "./sessions.ts";
import {
  type VaultEditor,
  accessible,
  general,
  unitOfDocument,
  vaultDocument,
  writesAt,
} from "./units.ts";
import { type LinkPolicies, socketVisitToken, visitOf, visitPrefix, visitor } from "./links.ts";
import { membership } from "./workspaces.ts";
import {
  type EventActor,
  type EventOrigin,
  type ServerEvents,
  accountActor,
  fromServer,
  originOf,
} from "./events.ts";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const namePattern = new RegExp(`^(${uuid})/(vault|vault\\.${uuid}|${uuid}(?:\\.comments)?)$`);

/**
 * The origin of what a store merged in from the database, applied to the
 * open document: stored already, so it starts no store of its own.
 */
const fromStore: LocalTransactionOrigin = { source: "local", skipStoreHooks: true };

/**
 * A document's name: its workspace's ID, then `vault`, `vault.` and a unit's
 * ID, a note's ID, or a note's ID and `.comments` for its comments (ADR 0044).
 */
export interface DocumentName {
  readonly workspaceId: string;
  readonly document: string;
}

export function parseDocumentName(name: string): DocumentName | undefined {
  const match = namePattern.exec(name);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { workspaceId: match[1], document: match[2] };
}

/** Whether a document is a note's comments, beside it (ADR 0044). */
export function isComments(document: string): boolean {
  return document.endsWith(".comments");
}

/** What a sync connection knows of who opened it. */
interface SyncContext {
  readonly userId: string;
  /** Where its connection came from, for what it changes to be told of (ADR 0081). */
  readonly address?: string | null;
  readonly userAgent?: string | null;
  /** How it changes documents: an app syncing, the public API, or the server itself. */
  readonly via?: "sync" | "api" | "server";
  /** The API token a change through the API came with. */
  readonly token?: { readonly id: string; readonly name: string } | null;
}

/** Where a change through the API came from: its request, and the token it came with. */
export type EditOrigin = EventOrigin & {
  readonly token?: { readonly id: string; readonly name: string } | null;
};

/** Who changed a vault document since it was last stored, and from where. */
export interface Changer {
  readonly userId: string;
  readonly via: "sync" | "api" | "server";
  readonly origin: EventOrigin;
  readonly token?: { readonly id: string; readonly name: string } | null;
}

/** What storing a document tells of: the server's events, and who changed it. */
export interface StoreTold {
  readonly events: ServerEvents;
  readonly changedBy: readonly Changer[];
}

/** Who did what a document's changers did: one of them, or the server when none. */
function changedActor(changers: readonly Changer[]): {
  readonly actor: EventActor;
  readonly origin: EventOrigin;
} {
  const first = changers[0];
  if (first === undefined || first.userId === "")
    return { actor: { kind: "system" }, origin: fromServer };
  const actor: EventActor = first.userId.startsWith("visit:")
    ? { kind: "visitor", link: first.userId.slice("visit:".length), name: null }
    : accountActor(first.userId, first.token);
  return { actor, origin: first.origin };
}

/**
 * Tells of the notes a unit's vault document no longer lists, as webhooks'
 * outbox has them: gone from the unit the server's record puts them in,
 * not moved to another (ADR 0081).
 */
async function tellRemoved(
  tx: Queryable,
  workspaceId: string,
  unit: string,
  listed: ReadonlyMap<string, string>,
  listedBefore: ReadonlyMap<string, string>,
  told: StoreTold,
): Promise<void> {
  const now = new Set([...listed.keys()].map((id) => id.toLowerCase()));
  const was = new Map([...listedBefore].map(([id, path]) => [id.toLowerCase(), path]));
  const gone = [...was.keys()].filter((id) => !now.has(id));
  if (gone.length === 0) return;
  const { rows } = await tx.query(
    `SELECT n.id, COALESCE(u.unit_id::text, $3) AS unit
       FROM unnest($2::text[]) AS n(id)
       LEFT JOIN note_units u ON u.workspace_id = $1 AND u.note = n.id`,
    [workspaceId, gone, general],
  );
  const { actor, origin } = changedActor(told.changedBy);
  const by = [...new Set(told.changedBy.map((changer) => changer.userId))].filter(
    (id) => id !== "",
  );
  for (const row of rows) {
    if (readText(row, "unit") !== unit) continue;
    const id = readText(row, "id");
    const path = was.get(id) ?? "";
    await told.events.emit(
      tx,
      {
        action: "note.deleted",
        actor,
        workspace: workspaceId,
        target: { type: "note", id, name: titleOf(path) },
        details: {
          path,
          via: told.changedBy[0]?.via ?? "server",
          ...(by.length > 1 ? { changedBy: by } : {}),
        },
      },
      origin,
    );
  }
}

/** What the vault document's clients hear when a note's document is stored. */
export interface Stored {
  readonly type: "stored";
  readonly document: string;
  readonly seq: number;
}

/** The most documents one answer lists; a client asks again from the last. */
const pageSize = 1000;

interface Changes {
  readonly since?: number;
}

/** A document's state, to store under its name in its workspace. */
export interface DocumentStore {
  readonly document: string;
  readonly state: Uint8Array;
  /** What storing it tells of, and who changed it, when a module listens (ADR 0081). */
  readonly told?: StoreTold | undefined;
  /**
   * The number the storing node last read or stored the document at, when
   * it keeps one. Stored since by another node or process, the state is
   * merged with what is stored (ADR 0082). Without one, the state replaces
   * what is stored.
   */
  readonly known?: number;
}

/** What a store did: its number, and the stored state it merged in, which the state given lacked. */
export interface StoreResult {
  readonly seq: number;
  readonly lacked?: Uint8Array;
}

/**
 * Stores a document's state under a new number, and gives the number. For a
 * note, the state it replaces is first kept as a version when the note's
 * last version is ten minutes old, so its history has it as it was before
 * each spell of editing. In a workspace with webhooks, the notes it makes,
 * changes and removes go to their outbox in the same transaction (ADR 0060).
 */
export async function storeDocument(
  db: Database,
  workspaceId: string,
  document: string,
  state: Uint8Array,
  told?: StoreTold,
): Promise<number> {
  const [stored] = await storeDocuments(db, workspaceId, [{ document, state, told }]);
  if (stored === undefined) throw new Error(`${document} was not numbered.`);
  return stored.seq;
}

/**
 * Stores documents of one workspace in one transaction, and gives what
 * each store did, in the order given. Each is written as `storeDocument`
 * writes it, in the order of their names, so two transactions storing the
 * same documents lock their rows in one order; then the workspace's lock is
 * taken, once, and every number is drawn under it (ADR 0082).
 */
export async function storeDocuments(
  db: Database,
  workspaceId: string,
  stores: readonly DocumentStore[],
): Promise<StoreResult[]> {
  if (new Set(stores.map((store) => store.document)).size !== stores.length) {
    throw new Error("A transaction stores each document once.");
  }
  const sorted = [...stores].sort((a, b) =>
    a.document < b.document ? -1 : a.document > b.document ? 1 : 0,
  );
  return db.transaction(async (tx) => {
    const lacked = new Map<string, Uint8Array | undefined>();
    for (const store of sorted) lacked.set(store.document, await keep(tx, workspaceId, store));
    // Last, so its numbers are in the order the stores commit, and no row
    // lock comes after the workspace's.
    await lockNumbers(tx, workspaceId);
    const numbers = new Map<string, number>();
    for (const store of sorted) {
      const { rows } = await tx.query(
        `UPDATE documents SET seq = nextval('document_seq')
          WHERE workspace_id = $1 AND name = $2 RETURNING seq`,
        [workspaceId, store.document],
      );
      numbers.set(store.document, readCount(rows[0], "seq"));
    }
    return stores.map((store) => {
      const merged = lacked.get(store.document);
      return {
        seq: numbers.get(store.document) ?? 0,
        ...(merged === undefined ? {} : { lacked: merged }),
      };
    });
  });
}

/** Two states of a document as one: everything either has. */
function mergeStates(stored: Uint8Array, state: Uint8Array): Uint8Array {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, stored);
    Y.applyUpdate(document, state);
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}

/** A document's stored state, its row locked already. */
async function storedState(
  tx: Queryable,
  workspaceId: string,
  document: string,
): Promise<Uint8Array> {
  const { rows } = await tx.query(
    "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
    [workspaceId, document],
  );
  return readBytes(rows[0], "state");
}

/**
 * Writes a document's state, its version, its outbox and its index, in a
 * transaction, unnumbered; gives the stored state it merged in, if any.
 */
async function keep(
  tx: Queryable,
  workspaceId: string,
  store: DocumentStore,
): Promise<Uint8Array | undefined> {
  const { document, known, told } = store;
  // The row, locked reading its number alone, which leaves its state where
  // PostgreSQL keeps it: a store of an unchanged row costs what it did.
  const { rows: found } = await tx.query(
    "SELECT seq FROM documents WHERE workspace_id = $1 AND name = $2 FOR UPDATE",
    [workspaceId, document],
  );
  const exists = found[0] !== undefined;
  const changed = exists && known !== undefined && readCount(found[0], "seq") !== known;
  // A vault document's paths are compared with the state it replaces (ADR 0050).
  let before =
    changed || (exists && document.startsWith("vault"))
      ? await storedState(tx, workspaceId, document)
      : undefined;
  // Stored by another node or process since this one read it: merged with that.
  let state = changed && before !== undefined ? mergeStates(before, store.state) : store.state;
  let lacked = changed ? before : undefined;
  const watched = !isComments(document) && (await hasWebhooks(tx, workspaceId));
  // What compares the state replaced compares it with the state written, merged or not.
  if (watched && !document.startsWith("vault")) {
    await keepNoteChange(tx, workspaceId, document, state);
  }
  if (!document.startsWith("vault") && !isComments(document)) {
    await tx.query(
      `INSERT INTO document_versions (workspace_id, name, state)
         SELECT workspace_id, name, state FROM documents
         WHERE workspace_id = $1 AND name = $2 AND state <> $3
           AND NOT EXISTS (
             SELECT 1 FROM document_versions
             WHERE workspace_id = $1 AND name = $2
               AND created_at > now() - interval '10 minutes'
           )`,
      [workspaceId, document, state],
    );
  }
  // Numbered once everything else in the transaction is written.
  if (exists) {
    await tx.query(
      "UPDATE documents SET state = $3, updated_at = now() WHERE workspace_id = $1 AND name = $2",
      [workspaceId, document, state],
    );
  } else {
    const { rows: made } = await tx.query(
      `INSERT INTO documents (workspace_id, name, state, seq) VALUES ($1, $2, $3, 0)
         ON CONFLICT (workspace_id, name) DO NOTHING RETURNING name`,
      [workspaceId, document, state],
    );
    if (made.length === 0) {
      // Made by another node meanwhile, which committed first: locked, then
      // merged with when this node keeps a number, else replaced, as an
      // existing row is. A vault document's paths are compared with it.
      await tx.query("SELECT seq FROM documents WHERE workspace_id = $1 AND name = $2 FOR UPDATE", [
        workspaceId,
        document,
      ]);
      const stored = await storedState(tx, workspaceId, document);
      if (document.startsWith("vault")) before = stored;
      if (known !== undefined) {
        lacked = stored;
        state = mergeStates(stored, store.state);
      }
      await tx.query(
        "UPDATE documents SET state = $3, updated_at = now() WHERE workspace_id = $1 AND name = $2",
        [workspaceId, document, state],
      );
    }
  }
  // What search reads, kept with the state, so the two never disagree.
  if (document.startsWith("vault")) {
    const unit = document === "vault" ? general : document.slice("vault.".length);
    // Each side's paths, parsed once for everything that reads them: a
    // vault document lists every note of its unit. The state is the one
    // written, merged or not, and `before` the one it replaces.
    const now = pathsOf(state);
    const was = pathsOf(before);
    // Read against the index's paths before it takes the new ones.
    if (watched) await keepListChanges(tx, workspaceId, unit, now, was);
    // Only while a module wants them, as audit logs do when on (ADR 0081),
    // here in the row work, before the workspace's lock is taken.
    if (told !== undefined && (await told.events.wanted(tx))) {
      await tellRemoved(tx, workspaceId, unit, now, was, told);
    }
    await indexPaths(tx, workspaceId, unit, now, was);
  } else if (!isComments(document)) {
    await indexNote(tx, workspaceId, document, state);
  }
  return lacked;
}

/** The headers of a Node request, as a fetch Request has them. */
function headersOf(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, item);
    }
  }
  return headers;
}

/** What the rest of the server asks of sync. */
export interface SyncControl extends VaultEditor {
  /** Closes an account's connections, so its apps connect again and are checked anew. */
  disconnect(userId: string): void;
  /** Every socket syncing a document here, once each. */
  sockets(): Iterable<Closable>;
  /**
   * A document's state as it is now: Hocuspocus's copy while it is open,
   * with the edits not stored yet, or else as last stored; none for one
   * never stored.
   */
  state(workspaceId: string, document: string): Promise<Uint8Array | undefined>;
  /**
   * Changes a document as a member's app would, through Hocuspocus: apps
   * with it open see the change at once, and it is stored, and so listed
   * as changed, before this resolves. `change` runs in one transaction,
   * and what it gives is given back.
   */
  edit<T>(
    workspaceId: string,
    document: string,
    userId: string,
    change: (document: Y.Doc) => T,
    /** Where the request that asks came from, for what it changes to be told of. */
    origin?: EditOrigin,
  ): Promise<T>;
}

/** Whether a path is under a folder, `folder` ending with a slash, in any case. */
function under(path: string, folder: string): boolean {
  return path.toLowerCase().startsWith(folder.toLowerCase());
}

export async function registerSync(
  app: FastifyInstance,
  db: Database,
  events: ServerEvents,
  policies: LinkPolicies,
): Promise<SyncControl> {
  /** Who changed each vault document since it was last stored, by its name. */
  const changers = new Map<string, Changer[]>();
  await app.register(websocket, {
    // A note's update may be large, as a pasted image's data is; 16 MiB at most.
    options: { maxPayload: 16 * 1024 * 1024 },
    // As the server stops, every socket, sync's and the relay's, hears that
    // it restarts (1012), and its app connects again, through the load
    // balancer to another node (ADR 0082). New upgrades are refused.
    preClose(done) {
      const server = this.websocketServer;
      for (const client of server.clients) client.close(1012, "Service restart");
      server.close();
      done();
    },
  });

  async function role(userId: string, workspaceId: string): Promise<string | undefined> {
    const { rows } = await db.query(
      "SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    return rows.length === 0 ? undefined : readText(rows[0], "role");
  }

  /** The number this node last read or stored each open document at (ADR 0082). */
  const known = new Map<string, number>();
  const hocuspocus = new Hocuspocus<SyncContext>({
    quiet: true,
    // Stored after two seconds without a change, and at least every ten.
    debounce: 2000,
    maxDebounce: 10_000,

    async onAuthenticate({ token, documentName, connectionConfig, requestHeaders }) {
      const name = parseDocumentName(documentName);
      // The web app's page signs in with its cookie, from this server's own pages alone (ADR 0053).
      const session = token === "" ? socketCookieToken(requestHeaders) : token;
      const account = session === undefined ? undefined : await sessionAccount(db, session);
      const member =
        name === undefined || account === undefined
          ? undefined
          : await membership(db, account.id, name.workspaceId);
      // One answer for each, so a refusal tells nothing of the workspace. An
      // encrypted workspace syncs through the relay, never here, so its
      // notes are never stored in plain text.
      const refused = "Sign in, as a member of this document's workspace.";
      if (name === undefined) throw new Error(refused);
      const unit = await unitOfDocument(db, name.workspaceId, name.document);
      if (account !== undefined && member?.encryption === "none") {
        const level = (await accessible(db, account.id, name.workspaceId)).levels.get(unit);
        if (level !== undefined) {
          // A note's comments take comments from those who may comment, and edit or more.
          const writes = isComments(name.document) ? level !== "view" : writesAt(level);
          if (!writes) connectionConfig.readOnly = true;
          return { userId: account.id, via: "sync" };
        }
      }
      // A share link's visit opens its page's unit alone (ADR 0071): a view
      // link reads its notes but not their comments; a comment link writes
      // only comments; an edit link writes notes and comments. No visit
      // writes the unit's vault document, which says what notes it has.
      const visit = await visitOf(
        db,
        policies,
        token === ""
          ? socketVisitToken(requestHeaders)
          : token.startsWith(visitPrefix)
            ? token
            : undefined,
      );
      if (
        visit?.workspace === name.workspaceId &&
        visit.unit === unit &&
        !(isComments(name.document) && visit.level === "view")
      ) {
        const writes =
          !name.document.startsWith("vault") &&
          (visit.level === "edit" || (visit.level === "comment" && isComments(name.document)));
        if (!writes) connectionConfig.readOnly = true;
        return { userId: visitor(visit.link), via: "sync" };
      }
      // A document of a unit the account may not open is refused as one not there.
      throw new Error(refused);
    },

    async onLoadDocument({ documentName, document }) {
      const name = parseDocumentName(documentName);
      if (name === undefined) return document;
      const { rows } = await db.query(
        "SELECT state, seq FROM documents WHERE workspace_id = $1 AND name = $2",
        [name.workspaceId, name.document],
      );
      if (rows[0] !== undefined) Y.applyUpdate(document, readBytes(rows[0], "state"));
      // What this node read it at: a store finds whether another stored it since.
      known.set(documentName, rows[0] === undefined ? 0 : readCount(rows[0], "seq"));
      return document;
    },

    // A vault document's changers, for the notes it no longer lists to be told of.
    onChange({ documentName, context }) {
      if (!/\/vault(\.|$)/.test(documentName)) return Promise.resolve();
      const known = context as Partial<SyncContext> | undefined;
      const changer: Changer = {
        userId: known?.userId ?? "",
        via: known?.via ?? "server",
        origin: { address: known?.address ?? null, userAgent: known?.userAgent ?? null },
        token: known?.token ?? null,
      };
      const list = changers.get(documentName) ?? [];
      if (!list.some((each) => each.userId === changer.userId)) list.push(changer);
      changers.set(documentName, list);
      return Promise.resolve();
    },

    async onStoreDocument({ documentName, document }) {
      const name = parseDocumentName(documentName);
      if (name === undefined) return;
      const changedBy = changers.get(documentName) ?? [];
      changers.delete(documentName);
      const [result] = await storeDocuments(db, name.workspaceId, [
        {
          document: name.document,
          state: Y.encodeStateAsUpdate(document),
          known: known.get(documentName) ?? 0,
          told: { events, changedBy },
        },
      ]);
      if (result === undefined) return;
      const { seq, lacked } = result;
      known.set(documentName, seq);
      // What another node or process stored, which this one lacked, reaches
      // its own clients too.
      if (lacked !== undefined) Y.applyUpdate(document, lacked, fromStore);
      if (name.document.startsWith("vault")) return;
      const stored: Stored = { type: "stored", document: name.document, seq };
      // Told only to those syncing the note's own unit.
      const unit = await unitOfDocument(db, name.workspaceId, name.document);
      hocuspocus.documents
        .get(`${name.workspaceId}/${vaultDocument(unit)}`)
        ?.broadcastStateless(JSON.stringify(stored));
    },

    async afterUnloadDocument({ documentName }) {
      known.delete(documentName);
      return Promise.resolve();
    },
  });

  app.get("/api/sync", { websocket: true }, (socket, request) => {
    const origin = originOf(request);
    const connection = hocuspocus.handleConnection(
      socket,
      new Request(new URL(request.url, "http://nether"), { headers: headersOf(request.headers) }),
      // Where it came from, beside who it is once it signs in.
      { userId: "", address: origin.address, userAgent: origin.userAgent },
    );
    socket.on("message", (data: Buffer) => {
      connection.handleMessage(new Uint8Array(data));
    });
    socket.on("close", (code: number, reason: Buffer) => {
      connection.handleClose({ code, reason: reason.toString("utf8") });
    });
  });

  // Which of a workspace's documents changed since a number, in order.
  app.get<{ Params: { workspace: string }; Querystring: Changes }>(
    "/api/workspaces/:workspace/documents",
    {
      schema: {
        params: {
          type: "object",
          required: ["workspace"],
          properties: { workspace: uuidField },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { since: { type: "integer", minimum: 0 } },
        },
      },
      preHandler: signedIn(db),
    },
    async (request, reply) => {
      const workspace = request.params.workspace.toLowerCase();
      if ((await role(accountOf(request).id, workspace)) === undefined) {
        return fail(reply, 404, "This account is in no such workspace.");
      }
      // Only the documents of the units the account opens: the others' names stay hidden.
      const opens = [...(await accessible(db, accountOf(request).id, workspace)).levels.keys()];
      const { rows } = await db.query(
        `SELECT name, seq FROM (
           SELECT name, seq FROM documents WHERE workspace_id = $1 AND seq > $2
           UNION ALL
           SELECT name, max(seq) AS seq FROM encrypted_updates
            WHERE workspace_id = $1 AND seq > $2 GROUP BY name
         ) stored
         WHERE CASE
                 WHEN name = 'vault' THEN $4
                 WHEN name LIKE 'vault.%' THEN substr(name, 7)
                 ELSE coalesce(
                   (SELECT unit_id::text FROM note_units n
                     WHERE n.workspace_id = $1
                       AND n.note = regexp_replace(stored.name, '[.]comments$', '')),
                   $4)
               END = ANY($5::text[])
         ORDER BY seq LIMIT $3`,
        [workspace, request.query.since ?? 0, pageSize + 1, general, opens],
      );
      const page = rows.slice(0, pageSize);
      return {
        documents: page.map((row) => ({
          name: readText(row, "name"),
          seq: readCount(row, "seq"),
        })),
        more: rows.length > pageSize,
      };
    },
  );

  // Closing the server stores every document first, as Hocuspocus's own does.
  // A few seconds at most: a server stopping does not wait on a document
  // that will not unload, and says so.
  app.addHook("onClose", async () => {
    if (hocuspocus.getDocumentsCount() === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unloaded = await Promise.race([
      new Promise<boolean>((resolve) => {
        hocuspocus.configuration.extensions.push({
          async afterUnloadDocument({ instance }) {
            if (instance.getDocumentsCount() === 0) resolve(true);
            return Promise.resolve();
          },
        });
        hocuspocus.closeConnections();
        hocuspocus.flushPendingStores();
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!unloaded) {
      app.log.warn(
        { documents: hocuspocus.getDocumentsCount() },
        "Stopped after five seconds of waiting for open documents to be stored and closed",
      );
    }
  });

  /** Changes a document as a member's app would: those syncing it hear at once. */
  async function edit<T>(
    name: string,
    userId: string,
    change: (document: Y.Doc) => T,
    origin?: EditOrigin,
  ): Promise<T> {
    const connection = await hocuspocus.openDirectConnection(name, {
      userId,
      // The server's own moves, or an account's through the API.
      via: userId === "" ? "server" : "api",
      address: origin?.address ?? null,
      userAgent: origin?.userAgent ?? null,
      token: origin?.token ?? null,
    });
    try {
      let result: { readonly value: T } | undefined;
      await connection.transact((document) => {
        result = { value: change(document) };
      });
      if (result === undefined) throw new Error(`The change to ${name} did not run.`);
      return result.value;
    } finally {
      // Let go, it is stored.
      await connection.disconnect();
    }
  }

  /** Changes a vault document as a member's app would: those syncing it hear at once. */
  async function editVault(
    workspaceId: string,
    unit: string,
    change: (document: Y.Doc) => void,
  ): Promise<void> {
    await edit(`${workspaceId}/${vaultDocument(unit)}`, "", change);
  }

  return {
    async merge(workspaceId, from, into) {
      let notes: [string, unknown][] = [];
      let files: [string, unknown][] = [];
      await editVault(workspaceId, from, (document) => {
        notes = [...document.getMap("notes").entries()];
        files = [...document.getMap("files").entries()];
      });
      await editVault(workspaceId, into, (document) => {
        const listed = document.getMap("notes");
        for (const [id, path] of notes) if (!listed.has(id)) listed.set(id, path);
        const kept = document.getMap("files");
        for (const [path, file] of files) if (!kept.has(path)) kept.set(path, file);
      });
    },

    async rename(workspaceId, unit, from, to) {
      await editVault(workspaceId, unit, (document) => {
        const notes = document.getMap<string>("notes");
        for (const [id, path] of [...notes.entries()]) {
          if (under(path, from)) notes.set(id, to + path.slice(from.length));
        }
        const files = document.getMap("files");
        for (const [path, file] of [...files.entries()]) {
          if (!under(path, from)) continue;
          files.delete(path);
          files.set(to + path.slice(from.length), file);
        }
      });
    },

    disconnect(userId) {
      for (const document of hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) {
          const context = connection.context as Partial<SyncContext> | undefined;
          // The socket, with every document on it: the app connects again.
          if (context?.userId === userId) connection.webSocket.close(4403, "Access changed");
        }
      }
    },

    sockets() {
      const open = new Set<Closable>();
      for (const document of hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) open.add(connection.webSocket);
      }
      return open;
    },

    async state(workspaceId, document) {
      const open = hocuspocus.documents.get(`${workspaceId}/${document}`);
      if (open !== undefined) return Y.encodeStateAsUpdate(open);
      const { rows } = await db.query(
        "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, document],
      );
      return rows.length === 0 ? undefined : readBytes(rows[0], "state");
    },

    edit(workspaceId, document, userId, change, origin) {
      return edit(`${workspaceId}/${document}`, userId, change, origin);
    },
  };
}
