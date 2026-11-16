// The public API (ADR 0059), reading: workspaces, notes listed by path a
// page at a time and given as the Markdown a vault has, databases and their
// rows, and search; for tokens and sessions, through the units the account
// opens, never an encrypted workspace's notes.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { setDocumentBlocks, setDocumentProperties } from "@nether/editor/document";
import { parseMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBytes } from "../src/db.ts";
import { readNote } from "../src/markdown.ts";
import { storeDocument } from "../src/sync.ts";
import { type SetUp, type TestServer, admin, bearer, setUp, startServer } from "./app.ts";
import { freePort } from "./ports.ts";

let running: TestServer | undefined;
const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await running?.close();
  running = undefined;
});

type Test = TestServer & SetUp;

async function start(): Promise<Test> {
  running = await startServer();
  return { ...running, ...(await setUp(running)) };
}

/** A note's document as the editor keeps it, made from Markdown. */
function noteState(markdown: string): Uint8Array {
  const document = new Y.Doc();
  const parsed = parseMarkdown(markdown);
  setDocumentBlocks(document, parsed.content);
  setDocumentProperties(document, parsed.properties);
  return Y.encodeStateAsUpdate(document);
}

/** A vault document listing notes by ID and path. */
function vaultState(paths: Record<string, string>): Uint8Array {
  const document = new Y.Doc();
  const notes = document.getMap<string>("notes");
  for (const [id, path] of Object.entries(paths)) notes.set(id, path);
  return Y.encodeStateAsUpdate(document);
}

/** Stores notes, each by its path and Markdown, and the vault document of a unit listing them. */
async function store(
  test: Test,
  notes: Record<string, string>,
  vault = "vault",
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [path, markdown] of Object.entries(notes)) {
    const id = randomUUID();
    ids[path] = id;
    await storeDocument(test.db, test.workspaceId, id, noteState(markdown));
  }
  const listed = Object.fromEntries(Object.entries(ids).map(([path, id]) => [id, path]));
  await storeDocument(test.db, test.workspaceId, vault, vaultState(listed));
  return ids;
}

async function token(
  test: Test,
  payload: object = {},
  session = test.token,
  password: string = admin.password,
): Promise<string> {
  const response = await test.server.inject({
    method: "POST",
    url: "/api/tokens",
    headers: bearer(session),
    payload: { name: "Script", access: "read", password, ...payload },
  });
  if (response.statusCode !== 201) throw new Error(`No token: ${response.body}`);
  return response.json<{ token: string }>().token;
}

function get(test: Test, url: string, secret: string, headers: Record<string, string> = {}) {
  return test.server.inject({ method: "GET", url, headers: { ...bearer(secret), ...headers } });
}

/** Another member of the admin's workspace, signed in. */
async function join(test: Test, name: string) {
  const invited = await test.server.inject({
    method: "POST",
    url: `/api/workspaces/${test.workspaceId}/invitations`,
    headers: bearer(test.token),
    payload: { role: "member" },
  });
  const password = `${name}'s long password`;
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: invited.json<{ token: string }>().token,
      name,
      email: `${name.toLowerCase()}@example.org`,
      password,
    },
  });
  return { session: accepted.json<{ token: string }>().token, password };
}

interface Listed {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly updatedAt: string | null;
}

describe("the public API", () => {
  it("lists the notes the vault documents list, by path, a page at a time", async () => {
    const test = await start();
    const ids = await store(test, {
      "Zebra.md": "Stripes\n",
      "Projects/Launch.md": "# Launch\n\nShip it #release\n",
      "Inbox.md": "Things to sort\n",
      "Projects/Launch/Tasks.md": "- [ ] Write\n",
    });
    // A note stored and listed nowhere, as one in the trash.
    await storeDocument(test.db, test.workspaceId, randomUUID(), noteState("Gone\n"));
    const secret = await token(test);
    const base = `/api/v1/workspaces/${test.workspaceId}/notes`;

    const all = await get(test, base, secret);
    expect(all.statusCode).toBe(200);
    const body = all.json<{ notes: Listed[]; next: string | null }>();
    expect(body.notes.map((note) => note.path)).toEqual([
      "Inbox.md",
      "Projects/Launch.md",
      "Projects/Launch/Tasks.md",
      "Zebra.md",
    ]);
    expect(body.next).toBeNull();
    const launch = body.notes[1];
    expect(launch).toMatchObject({
      id: ids["Projects/Launch.md"],
      title: "Launch",
      tags: ["release"],
    });
    expect(Date.parse(launch?.updatedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);

    const first = (await get(test, `${base}?limit=3`, secret)).json<{
      notes: Listed[];
      next: string | null;
    }>();
    expect(first.notes).toHaveLength(3);
    expect(first.next).not.toBeNull();
    const rest = (await get(test, `${base}?limit=3&after=${first.next ?? ""}`, secret)).json<{
      notes: Listed[];
      next: string | null;
    }>();
    expect(rest.notes.map((note) => note.path)).toEqual(["Zebra.md"]);
    expect(rest.next).toBeNull();

    for (const folder of ["Projects", "/Projects/"]) {
      const inFolder = await get(test, `${base}?folder=${encodeURIComponent(folder)}`, secret);
      expect(inFolder.json<{ notes: Listed[] }>().notes.map((note) => note.path)).toEqual([
        "Projects/Launch.md",
        "Projects/Launch/Tasks.md",
      ]);
    }
    expect((await get(test, `${base}?after=nonsense`, secret)).statusCode).toBe(400);
  });

  it("gives a note as the Markdown a vault has, or the Markdown alone", async () => {
    const test = await start();
    const markdown = [
      "---",
      "status: Doing",
      "tags:",
      "  - plan",
      "---",
      "# Launch",
      "",
      "Ship it with [[Inbox]] and **care** #release",
      "",
      "- [ ] Write the notes",
      "- [x] Book the room",
      "",
    ].join("\n");
    const ids = await store(test, { "Projects/Launch.md": markdown, "Inbox.md": "Sort me\n" });
    const id = ids["Projects/Launch.md"] ?? "";
    const secret = await token(test);
    const url = `/api/v1/workspaces/${test.workspaceId}/notes/${id}`;

    const answer = await get(test, url, secret);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      id,
      workspace: test.workspaceId,
      path: "Projects/Launch.md",
      title: "Launch",
      tags: ["plan", "release"],
      properties: { status: "Doing", tags: ["plan"] },
      markdown,
    });

    const raw = await get(test, url, secret, { accept: "text/markdown" });
    expect(raw.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(raw.body).toBe(markdown);

    const unknown = `/api/v1/workspaces/${test.workspaceId}/notes/${randomUUID()}`;
    expect((await get(test, unknown, secret)).statusCode).toBe(404);
  });

  it("opens only the units the account opens", async () => {
    const test = await start();
    const general = await store(test, { "Inbox.md": "Plans for the board\n" });
    const made = await test.server.inject({
      method: "POST",
      url: `/api/workspaces/${test.workspaceId}/teamspaces`,
      headers: bearer(test.token),
      payload: { name: "Board" },
    });
    const unit = made.json<{ id: string }>().id;
    const board = randomUUID();
    await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/notes/${board}/unit`,
      headers: bearer(test.token),
      payload: { unit },
    });
    await storeDocument(test.db, test.workspaceId, board, noteState("Plans for the merger\n"));
    await storeDocument(
      test.db,
      test.workspaceId,
      `vault.${unit}`,
      vaultState({ [board]: "Board/Merger.md" }),
    );

    const bea = await join(test, "Bea");
    const hers = await token(test, {}, bea.session, bea.password);
    const mine = await token(test);
    const list = `/api/v1/workspaces/${test.workspaceId}/notes`;
    const paths = async (secret: string) =>
      (await get(test, list, secret)).json<{ notes: Listed[] }>().notes.map((note) => note.path);
    expect(await paths(mine)).toEqual(["Board/Merger.md", "Inbox.md"]);
    expect(await paths(hers)).toEqual(["Inbox.md"]);

    const note = (id: string) => `${list}/${id}`;
    expect((await get(test, note(board), mine)).statusCode).toBe(200);
    expect((await get(test, note(board), hers)).statusCode).toBe(404);
    expect((await get(test, note(general["Inbox.md"] ?? ""), hers)).statusCode).toBe(200);

    const found = async (secret: string) =>
      (await get(test, "/api/v1/search?q=plans", secret))
        .json<{ results: { path: string }[] }>()
        .results.map((result) => result.path)
        .sort();
    expect(await found(mine)).toEqual(["Board/Merger.md", "Inbox.md"]);
    expect(await found(hers)).toEqual(["Inbox.md"]);
  });

  it("reaches only a token's workspace, and never an encrypted workspace's notes", async () => {
    const test = await start();
    await store(test, { "Inbox.md": "Plans\n" });
    const secret = randomUUID();
    await test.db.query(
      "INSERT INTO workspaces (id, name, encryption) VALUES ($1, 'Secret', 'end-to-end')",
      [secret],
    );
    await test.db.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [secret, test.userId],
    );

    const every = await token(test);
    const workspaces = await get(test, "/api/v1/workspaces", every);
    expect(workspaces.json()).toEqual({
      workspaces: [
        { id: test.workspaceId, name: admin.workspace, role: "owner", encryption: "none" },
        { id: secret, name: "Secret", role: "owner", encryption: "end-to-end" },
      ],
    });
    for (const url of [
      `/api/v1/workspaces/${secret}/notes`,
      `/api/v1/workspaces/${secret}/databases`,
      `/api/v1/workspaces/${secret}/notes/${randomUUID()}`,
    ]) {
      const answer = await get(test, url, every);
      expect(answer.statusCode, url).toBe(409);
      expect(answer.json<{ message: string }>().message).toContain("end-to-end encrypted");
    }
    const searched = await get(test, "/api/v1/search?q=plans", every);
    expect(searched.json()).toMatchObject({ encrypted: ["Secret"] });

    const one = await token(test, { workspace: test.workspaceId });
    expect((await get(test, "/api/v1/workspaces", one)).json()).toEqual({
      workspaces: [
        { id: test.workspaceId, name: admin.workspace, role: "owner", encryption: "none" },
      ],
    });
    expect((await get(test, `/api/v1/workspaces/${secret}/notes`, one)).statusCode).toBe(404);
    expect((await get(test, `/api/v1/search?q=plans&workspace=${secret}`, one)).statusCode).toBe(
      404,
    );
    const narrowed = await get(test, "/api/v1/search?q=plans", one);
    expect(narrowed.json()).toMatchObject({ encrypted: [] });
    expect(narrowed.json<{ results: unknown[] }>().results).toHaveLength(1);

    // Another account's workspace, or none at all, is not there.
    const nowhere = `/api/v1/workspaces/${randomUUID()}/notes`;
    expect((await get(test, nowhere, every)).statusCode).toBe(404);
    // A session works as a token of every workspace.
    expect((await get(test, `/api/v1/workspaces/${secret}/notes`, test.token)).statusCode).toBe(
      409,
    );
    expect((await test.server.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  });

  it("gives databases with their schemas, and their rows from the folder beside them", async () => {
    const test = await start();
    const schema = [
      "---",
      "database:",
      "  properties:",
      "    - key: status",
      "      type: select",
      "  views:",
      "    - name: All",
      "      layout: table",
      "---",
      "The team's projects.",
      "",
    ].join("\n");
    const ids = await store(test, {
      "Projects.md": schema,
      "Projects/Launch.md": "---\nstatus: Doing\n---\nShip it\n",
      "Projects/Site.md": "---\nstatus: Done\n---\nLive\n",
      "Projects/Launch/Notes.md": "---\nstatus: Doing\n---\nA page of a row\n",
      "Inbox.md": "Sort me\n",
    });
    const secret = await token(test);
    const base = `/api/v1/workspaces/${test.workspaceId}/databases`;
    const expected = {
      properties: [{ key: "status", type: "select" }],
      views: [{ name: "All", layout: "table" }],
    };

    const listed = await get(test, base, secret);
    expect(listed.json()).toMatchObject({
      databases: [{ id: ids["Projects.md"], path: "Projects.md", title: "Projects" }],
      next: null,
    });
    expect(listed.json<{ databases: { schema: unknown }[] }>().databases[0]?.schema).toEqual(
      expected,
    );

    const one = await get(test, `${base}/${ids["Projects.md"] ?? ""}`, secret);
    expect(one.json()).toMatchObject({ id: ids["Projects.md"], schema: expected });
    expect((await get(test, `${base}/${ids["Inbox.md"] ?? ""}`, secret)).statusCode).toBe(404);

    const rows = await get(test, `${base}/${ids["Projects.md"] ?? ""}/rows?limit=1`, secret);
    const page = rows.json<{ rows: { path: string; properties: object }[]; next: string }>();
    expect(page.rows).toEqual([
      expect.objectContaining({ path: "Projects/Launch.md", properties: { status: "Doing" } }),
    ]);
    const rest = await get(
      test,
      `${base}/${ids["Projects.md"] ?? ""}/rows?after=${page.next}`,
      secret,
    );
    expect(rest.json()).toMatchObject({
      rows: [{ path: "Projects/Site.md", title: "Site", properties: { status: "Done" } }],
      next: null,
    });
  });

  it("reads a note open in an editor, with the edits not stored yet", async () => {
    const test = await start();
    const ids = await store(test, { "Draft.md": "First words\n" });
    const id = ids["Draft.md"] ?? "";
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const port = (test.server.server.address() as AddressInfo).port;
    const provider = await new Promise<HocuspocusProvider>((resolve, reject) => {
      const made: HocuspocusProvider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${String(port)}/api/sync`,
        name: `${test.workspaceId}/${id}`,
        token: test.token,
        document: new Y.Doc(),
        onSynced: () => {
          resolve(made);
        },
        onAuthenticationFailed: ({ reason }) => {
          reject(new Error(reason));
        },
      });
      providers.push(made);
    });
    setDocumentBlocks(provider.document, parseMarkdown("First words, then more\n").content);
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!provider.hasUnsyncedChanges) {
          provider.off("unsyncedChanges", check);
          resolve();
        }
      };
      provider.on("unsyncedChanges", check);
      check();
    });

    const secret = await token(test);
    const raw = await get(test, `/api/v1/workspaces/${test.workspaceId}/notes/${id}`, secret, {
      accept: "text/markdown",
    });
    expect(raw.body).toBe("First words, then more\n");
    // The server stores it seconds later: what it has stored is still the first words.
    const { rows } = await test.db.query(
      "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
      [test.workspaceId, id],
    );
    expect(readNote(readBytes(rows[0], "state")).markdown).toBe("First words\n");
  });

  it("limits each account's requests", async () => {
    const test = await start();
    const secret = await token(test);
    let last = 0;
    for (let tries = 0; tries < 301; tries++) {
      last = (await get(test, "/api/v1/me", secret)).statusCode;
    }
    expect(last).toBe(429);
    // Another token of the account counts with it.
    const other = await token(test);
    const answer = await get(test, "/api/v1/me", other);
    expect(answer.statusCode).toBe(429);
    expect(Number(answer.headers["retry-after"])).toBeGreaterThan(0);
  });
});
