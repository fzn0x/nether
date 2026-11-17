// The calls a clip makes to the person's own Nether server (ADR 0066),
// through its REST API (ADR 0059) with their write token: who it is, the
// workspaces and databases it reaches, finding a note, and saving a clip as
// a new note, added to a note, or a database row. Nothing goes anywhere
// else.

type Fetch = typeof fetch;

/** A server's answer that is not a success, with the message it gave. */
export class Refused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Refused";
    this.status = status;
  }
}

/** Where the person's server is, and the token the clipper signs in with. */
export interface Connection {
  readonly server: string;
  readonly token: string;
  readonly fetch: Fetch;
}

export interface Account {
  readonly name: string;
  readonly email: string;
  readonly access: "read" | "write";
  /** The one workspace the token reaches, if it reaches one alone. */
  readonly workspace: string | null;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly encrypted: boolean;
}

export interface Listed {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A server's address from what someone typed: https:// when they gave no
 * scheme, without a path; undefined when it is not one.
 */
export function serverAddress(typed: string): string | undefined {
  const trimmed = typed.trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
    return undefined;
  }
  return url.origin;
}

/** The origin pattern the browser grants the clipper for a server. */
export function originPattern(server: string): string {
  return `${new URL(server).origin}/*`;
}

async function call(
  connection: Connection,
  path: string,
  options: {
    readonly method?: string;
    readonly json?: unknown;
    readonly markdown?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${connection.token}`,
    ...options.headers,
  };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.markdown !== undefined) {
    headers["content-type"] = "text/markdown; charset=utf-8";
    body = options.markdown;
  }
  let response: Response;
  // Called as itself: a browser's fetch refuses to run as another object's method.
  const send = connection.fetch;
  try {
    response = await send(`${connection.server}${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    throw new Refused(0, `${new URL(connection.server).host} cannot be reached: ${String(error)}`);
  }
  if (response.ok || response.status === 412) return response;
  const answer: unknown = await response.json().catch(() => undefined);
  const message = record(answer).message;
  throw new Refused(
    response.status,
    typeof message === "string"
      ? message
      : `${new URL(connection.server).host} answered ${String(response.status)}.`,
  );
}

async function json(connection: Connection, path: string, options = {}): Promise<unknown> {
  const response = await call(connection, path, options);
  return response.status === 204 ? undefined : ((await response.json()) as unknown);
}

/** Who the token signs in, and how far it reaches. */
export async function account(connection: Connection): Promise<Account> {
  const answer = record(await json(connection, "/api/v1/me"));
  const user = record(answer.user);
  const token = answer.token === null ? null : record(answer.token);
  const workspace = token === null ? null : record(token.workspace);
  return {
    name: text(user.name),
    email: text(user.email),
    access: token === null || token.access === "write" ? "write" : "read",
    workspace: workspace === null || text(workspace.id) === "" ? null : text(workspace.id),
  };
}

/** The workspaces the token reaches. */
export async function workspaces(connection: Connection): Promise<Workspace[]> {
  const list = record(await json(connection, "/api/v1/workspaces")).workspaces;
  return (Array.isArray(list) ? list : []).map((item: unknown) => {
    const workspace = record(item);
    return {
      id: text(workspace.id),
      name: text(workspace.name),
      encrypted: workspace.encryption !== "none",
    };
  });
}

function listed(value: unknown, id = "id"): Listed {
  const item = record(value);
  return { id: text(item[id]), path: text(item.path), title: text(item.title) };
}

/** A workspace's databases, up to a thousand. */
export async function databases(connection: Connection, workspace: string): Promise<Listed[]> {
  const list = record(
    await json(connection, `/api/v1/workspaces/${workspace}/databases?limit=1000`),
  ).databases;
  return (Array.isArray(list) ? list : []).map((item: unknown) => listed(item));
}

/** The notes of a workspace that a search finds, the best first. */
export async function findNotes(
  connection: Connection,
  workspace: string,
  query: string,
): Promise<Listed[]> {
  const search = new URLSearchParams({ q: query, workspace, limit: "20" });
  const results = record(await json(connection, `/api/v1/search?${search.toString()}`)).results;
  return (Array.isArray(results) ? results : []).map((item: unknown) => listed(item, "note"));
}

/** Makes a note at a path from its Markdown. */
export async function makeNote(
  connection: Connection,
  workspace: string,
  path: string,
  markdown: string,
): Promise<Listed> {
  return listed(
    await json(connection, `/api/v1/workspaces/${workspace}/notes`, {
      json: { path, markdown },
    }),
  );
}

/** How many times adding to a note reads it again, when someone changed it meanwhile. */
export const appendTries = 3;

/**
 * Adds to a note: reads its Markdown, then sends `change` of it, only if
 * the note is still as read; someone's edit in between reads it again.
 */
export async function changeNote(
  connection: Connection,
  workspace: string,
  note: string,
  change: (markdown: string) => string,
): Promise<Listed> {
  const path = `/api/v1/workspaces/${workspace}/notes/${note}`;
  for (let tries = 1; ; tries++) {
    const read = await call(connection, path, { headers: { accept: "text/markdown" } });
    const tag = read.headers.get("etag") ?? "*";
    const written = await call(connection, path, {
      method: "PUT",
      markdown: change(await read.text()),
      headers: { "if-match": tag },
    });
    if (written.status !== 412) return listed(await written.json());
    if (tries >= appendTries) {
      throw new Refused(412, "The note kept changing while the clip was added: try again.");
    }
  }
}

/** Adds a row to a database: a note in the folder beside it. */
export async function addRow(
  connection: Connection,
  workspace: string,
  database: string,
  row: {
    readonly title: string;
    readonly properties: Readonly<Record<string, unknown>>;
    readonly markdown: string;
  },
): Promise<Listed> {
  return listed(
    await json(connection, `/api/v1/workspaces/${workspace}/databases/${database}/rows`, {
      json: row,
    }),
  );
}
