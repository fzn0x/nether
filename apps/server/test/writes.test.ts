// Writing through the public API (ADR 0059): notes made, replaced and sent
// to the trash, and database rows added, each through Hocuspocus, so the
// apps syncing a note or its vault document see the change as it is made;
// only with a write token and edit access where the note is.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { newBlockId } from "@nether/core";
import { documentBlocks, setDocumentBlocks, setDocumentProperties } from "@nether/editor/document";
import { parseMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readBytes, readText } from "../src/db.ts";
import { documentNote } from "../src/markdown.ts";
import { storeDocument } from "../src/sync.ts";
import { isNotePath, matchesTag } from "../src/writes.ts";
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

/** Stores notes, each by its path and Markdown, and General's vault document listing them. */
async function store(test: Test, notes: Record<string, string>): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const vault = new Y.Doc();
  for (const [path, markdown] of Object.entries(notes)) {
    const id = randomUUID();
    ids[path] = id;
    await storeDocument(test.db, test.workspaceId, id, noteState(markdown));
    vault.getMap<string>("notes").set(id, path);
  }
  await storeDocument(test.db, test.workspaceId, "vault", Y.encodeStateAsUpdate(vault));
  return ids;
}

async function token(
  test: Test,
  access: "read" | "write" = "write",
  session = test.token,
  password: string = admin.password,
): Promise<string> {
  const response = await test.server.inject({
    method: "POST",
    url: "/api/tokens",
    headers: bearer(session),
    payload: { name: "Script", access, password },
  });
  if (response.statusCode !== 201) throw new Error(`No token: ${response.body}`);
  return response.json<{ token: string }>().token;
}

function call(
  test: Test,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  secret: string,
  options: { payload?: string | object; headers?: Record<string, string> } = {},
) {
  return test.server.inject({
    method,
    url: url.startsWith("/") ? url : `/api/v1/workspaces/${test.workspaceId}/${url}`,
    headers: { ...bearer(secret), ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
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
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { session: body.token, id: body.user.id, password };
}

/** A provider of a document of the test's workspace, synced, on a server now listening. */
async function open(test: Test, document: string): Promise<HocuspocusProvider> {
  if (!test.server.server.listening) {
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
  }
  const port = (test.server.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const provider: HocuspocusProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${String(port)}/api/sync`,
      name: `${test.workspaceId}/${document}`,
      token: test.token,
      document: new Y.Doc(),
      onSynced: () => {
        resolve(provider);
      },
      onAuthenticationFailed: ({ reason }) => {
        reject(new Error(reason));
      },
    });
    providers.push(provider);
  });
}

/** Resolves once a document passes a check, as its updates arrive. */
function until(document: Y.Doc, check: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const test = () => {
      if (check()) {
        document.off("update", test);
        resolve();
      }
    };
    document.on("update", test);
    test();
  });
}

interface Answer {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly properties: Record<string, unknown>;
  readonly markdown: string;
}

describe("writing through the public API", () => {
  it("makes a note from Markdown, listed where the apps hear of it", async () => {
    const test = await start();
    await store(test, { "Inbox.md": "Sort me\n" });
    const vault = await open(test, "vault");
    const secret = await token(test);
    const markdown = "---\nstatus: Doing\n---\n# Launch\n\nShip it #release\n";

    const made = await call(test, "POST", "notes", secret, {
      payload: { path: "Ideas/Launch.md", markdown },
    });
    expect(made.statusCode).toBe(201);
    const note = made.json<Answer>();
    expect(note).toMatchObject({
      path: "Ideas/Launch.md",
      title: "Launch",
      properties: { status: "Doing" },
      markdown,
      tags: ["release"],
    });
    expect(made.headers.location).toBe(`/api/v1/workspaces/${test.workspaceId}/notes/${note.id}`);
    const read = await call(test, "GET", `notes/${note.id}`, secret);
    expect(read.json()).toEqual(made.json());
    expect(read.headers.etag).toBe(made.headers.etag);

    // An app syncing the vault document hears of it, and finds it stored.
    await until(vault.document, () => vault.document.getMap("notes").has(note.id));
    expect(vault.document.getMap("notes").get(note.id)).toBe("Ideas/Launch.md");
    const { rows } = await test.db.query(
      "SELECT state FROM documents WHERE workspace_id = $1 AND name = $2",
      [test.workspaceId, note.id],
    );
    const stored = new Y.Doc();
    Y.applyUpdate(stored, readBytes(rows[0], "state"));
    expect(documentNote(stored).markdown).toBe(markdown);
    const found = await call(test, "GET", "/api/v1/search?q=ship", secret);
    expect(found.json<{ results: { note: string }[] }>().results.map((r) => r.note)).toEqual([
      note.id,
    ]);
  });

  it("replaces a note's Markdown, live in an open editor, keeping the blocks that stay", async () => {
    const test = await start();
    const ids = await store(test, { "Plan.md": "First part\n\nSecond part\n" });
    const id = ids["Plan.md"] ?? "";
    const editor = await open(test, id);
    const [first] = documentBlocks(editor.document, newBlockId);
    const secret = await token(test);

    const replaced = await call(test, "PUT", `notes/${id}`, secret, {
      payload: { markdown: "---\nstatus: Done\n---\nFirst part\n\nSecond part, changed\n" },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ id, path: "Plan.md", properties: { status: "Done" } });
    await until(editor.document, () =>
      documentNote(editor.document).markdown.includes("Second part, changed"),
    );
    const blocks = documentBlocks(editor.document, newBlockId);
    expect(blocks[0]?.id).toBe(first?.id);
    expect(documentNote(editor.document).properties).toEqual({ status: "Done" });

    // As text, the way a file is sent.
    const raw = await call(test, "PUT", `notes/${id}`, secret, {
      payload: "First part\n",
      headers: { "content-type": "text/markdown" },
    });
    expect(raw.statusCode).toBe(200);
    await until(editor.document, () => documentNote(editor.document).markdown === "First part\n");
    expect(documentBlocks(editor.document, newBlockId)[0]?.id).toBe(first?.id);
  });

  it("changes a note only as it was read, when asked to", async () => {
    const test = await start();
    const ids = await store(test, { "Plan.md": "First\n" });
    const id = ids["Plan.md"] ?? "";
    const secret = await token(test);
    const read = await call(test, "GET", `notes/${id}`, secret, {
      headers: { accept: "text/markdown" },
    });
    const tag = String(read.headers.etag);
    expect(tag).toMatch(/^"[\w-]+"$/);

    const changed = await call(test, "PUT", `notes/${id}`, secret, {
      payload: { markdown: "Second\n" },
      headers: { "if-match": tag },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
    const stale = await call(test, "PUT", `notes/${id}`, secret, {
      payload: { markdown: "Third\n" },
      headers: { "if-match": tag },
    });
    expect(stale.statusCode).toBe(412);
    const any = await call(test, "PUT", `notes/${id}`, secret, {
      payload: { markdown: "Third\n" },
      headers: { "if-match": "*" },
    });
    expect(any.json<Answer>().markdown).toBe("Third\n");
    const staleDelete = await call(test, "DELETE", `notes/${id}`, secret, {
      headers: { "if-match": tag },
    });
    expect(staleDelete.statusCode).toBe(412);
    expect(matchesTag(`"a", ${String(any.headers.etag)}`, String(any.headers.etag))).toBe(true);
    expect(matchesTag(`W/${String(any.headers.etag)}`, String(any.headers.etag))).toBe(false);
  });

  it("sends a deleted note to the trash on every device", async () => {
    const test = await start();
    const ids = await store(test, { "Old.md": "Gone soon\n", "Kept.md": "Stays\n" });
    const id = ids["Old.md"] ?? "";
    const vault = await open(test, "vault");
    const secret = await token(test);

    const deleted = await call(test, "DELETE", `notes/${id}`, secret);
    expect(deleted.statusCode).toBe(204);
    await until(vault.document, () => !vault.document.getMap("notes").has(id));
    expect([...vault.document.getMap("notes").values()]).toEqual(["Kept.md"]);
    expect((await call(test, "GET", `notes/${id}`, secret)).statusCode).toBe(404);
    expect((await call(test, "DELETE", `notes/${id}`, secret)).statusCode).toBe(404);
    // Its document stays, for a device's trash to restore it.
    const { rows } = await test.db.query(
      "SELECT 1 FROM documents WHERE workspace_id = $1 AND name = $2",
      [test.workspaceId, id],
    );
    expect(rows).toHaveLength(1);
  });

  it("adds a row to a database, in the folder beside it", async () => {
    const test = await start();
    const schema = "---\ndatabase:\n  properties:\n    - key: status\n      type: select\n---\n";
    const ids = await store(test, {
      "Projects.md": schema,
      "Projects/Launch.md": "---\nstatus: Doing\n---\n",
      "Inbox.md": "Sort me\n",
    });
    const database = ids["Projects.md"] ?? "";
    const secret = await token(test);
    const rows = `databases/${database}/rows`;

    const made = await call(test, "POST", rows, secret, {
      payload: {
        title: "Site",
        properties: { status: "Done", due: "2026-12-01" },
        markdown: "---\nstatus: Doing\nowner: Ada\n---\nLive soon\n",
      },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      path: "Projects/Site.md",
      title: "Site",
      properties: { status: "Done", owner: "Ada", due: "2026-12-01" },
      markdown: "---\nstatus: Done\nowner: Ada\ndue: 2026-12-01\n---\nLive soon\n",
    });
    const listed = await call(test, "GET", rows, secret);
    expect(listed.json<{ rows: { title: string }[] }>().rows.map((row) => row.title)).toEqual([
      "Launch",
      "Site",
    ]);

    const again = await call(test, "POST", rows, secret, { payload: { title: "launch" } });
    expect(again.statusCode).toBe(409);
    for (const title of ["a/b", ".hidden", "Name.", "con", "what?"]) {
      const bad = await call(test, "POST", rows, secret, { payload: { title } });
      expect(bad.statusCode, title).toBe(400);
    }
    const notDatabase = `databases/${ids["Inbox.md"] ?? ""}/rows`;
    expect(
      (await call(test, "POST", notDatabase, secret, { payload: { title: "X" } })).statusCode,
    ).toBe(404);
  });

  it("refuses read tokens, encrypted workspaces, and notes the account may not change", async () => {
    const test = await start();
    const ids = await store(test, { "Inbox.md": "Sort me\n" });
    const inbox = ids["Inbox.md"] ?? "";
    const reader = await token(test, "read");
    for (const [method, url] of [
      ["POST", "notes"],
      ["PUT", `notes/${inbox}`],
      ["DELETE", `notes/${inbox}`],
    ] as const) {
      const answer = await call(test, method, url, reader, {
        ...(method === "DELETE" ? {} : { payload: { path: "New.md", markdown: "x" } }),
      });
      expect(answer.statusCode, `${method} ${url}`).toBe(403);
    }

    const secret = randomUUID();
    await test.db.query(
      "INSERT INTO workspaces (id, name, encryption) VALUES ($1, 'Secret', 'end-to-end')",
      [secret],
    );
    await test.db.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [secret, test.userId],
    );
    const writer = await token(test);
    const encrypted = await call(test, "POST", `/api/v1/workspaces/${secret}/notes`, writer, {
      payload: { path: "Plain.md", markdown: "Never stored in plain text\n" },
    });
    expect(encrypted.statusCode).toBe(409);
    const { rows: plain } = await test.db.query("SELECT 1 FROM documents WHERE workspace_id = $1", [
      secret,
    ]);
    expect(plain).toHaveLength(0);

    // A teamspace Bea is not in, then one she only views.
    const board = (
      await test.server.inject({
        method: "POST",
        url: `/api/workspaces/${test.workspaceId}/teamspaces`,
        headers: bearer(test.token),
        payload: { name: "Board" },
      })
    ).json<{ id: string }>().id;
    const plan = await call(test, "POST", "notes", writer, {
      payload: { path: "board/Plan.md", markdown: "The board's plan\n" },
    });
    expect(plan.statusCode).toBe(201);
    const planId = plan.json<Answer>().id;
    const { rows: placed } = await test.db.query(
      "SELECT unit_id FROM note_units WHERE workspace_id = $1 AND note = $2",
      [test.workspaceId, planId],
    );
    expect(readText(placed[0], "unit_id")).toBe(board);

    const bea = await join(test, "Bea");
    const hers = await token(test, "write", bea.session, bea.password);
    const refused = await call(test, "POST", "notes", hers, {
      payload: { path: "Board/Mine.md", markdown: "x\n" },
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (await call(test, "PUT", `notes/${planId}`, hers, { payload: { markdown: "x" } })).statusCode,
    ).toBe(404);
    await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/units/${board}/grants/${bea.id}`,
      headers: bearer(test.token),
      payload: { level: "view" },
    });
    expect(
      (await call(test, "PUT", `notes/${planId}`, hers, { payload: { markdown: "x" } })).statusCode,
    ).toBe(403);
    expect((await call(test, "DELETE", `notes/${planId}`, hers)).statusCode).toBe(403);
    const general = await call(test, "POST", "notes", hers, {
      payload: { path: "Bea.md", markdown: "Hers\n" },
    });
    expect(general.statusCode).toBe(201);
  });

  it("puts a note in Private in the account's own private space, once it has one", async () => {
    const test = await start();
    const secret = await token(test);
    const before = await call(test, "POST", "notes", secret, {
      payload: { path: "Private/Diary.md", markdown: "Dear diary\n" },
    });
    expect(before.statusCode).toBe(409);
    const space = await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/private`,
      headers: bearer(test.token),
    });
    const unit = space.json<{ id: string }>().id;
    const made = await call(test, "POST", "notes", secret, {
      payload: { path: "Private/Diary.md", markdown: "Dear diary\n" },
    });
    expect(made.statusCode).toBe(201);
    const { rows } = await test.db.query("SELECT state FROM documents WHERE name = $1", [
      `vault.${unit}`,
    ]);
    const vault = new Y.Doc();
    Y.applyUpdate(vault, readBytes(rows[0], "state"));
    expect([...vault.getMap("notes").values()]).toEqual(["Private/Diary.md"]);
  });

  it("refuses paths that are not a note's, or taken, and frontmatter that does not read", async () => {
    const test = await start();
    await store(test, { "Inbox.md": "Sort me\n" });
    const secret = await token(test);
    const taken = await call(test, "POST", "notes", secret, {
      payload: { path: "inbox.md", markdown: "Another\n" },
    });
    expect(taken.statusCode).toBe(409);
    const broken = await call(test, "POST", "notes", secret, {
      payload: { path: "Broken.md", markdown: "---\ntags: [one\n---\nText\n" },
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json<{ message: string }>().message).toContain("frontmatter");
    const bad = await call(test, "POST", "notes", secret, {
      payload: { path: ".nether/plugins/x.md", markdown: "x\n" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("leaves nothing of a note whose path an app listed first", async () => {
    const test = await start();
    const board = (
      await test.server.inject({
        method: "POST",
        url: `/api/workspaces/${test.workspaceId}/teamspaces`,
        headers: bearer(test.token),
        payload: { name: "Board" },
      })
    ).json<{ id: string }>().id;
    const count = async () =>
      (
        await test.db.query(
          "SELECT name FROM documents WHERE workspace_id = $1 AND name NOT LIKE 'vault%'",
          [test.workspaceId],
        )
      ).rows.length;
    const before = await count();
    // An app lists the path; the server holds it, and has not stored it yet.
    const vault = await open(test, `vault.${board}`);
    const theirs = randomUUID();
    vault.document.getMap<string>("notes").set(theirs, "Board/Race.md");
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!vault.hasUnsyncedChanges) {
          vault.off("unsyncedChanges", check);
          resolve();
        }
      };
      vault.on("unsyncedChanges", check);
      check();
    });
    const secret = await token(test);

    const lost = await call(test, "POST", "notes", secret, {
      payload: { path: "Board/Race.md", markdown: "Mine\n" },
    });
    expect(lost.statusCode).toBe(409);
    expect(await count()).toBe(before);
    const { rows: placed } = await test.db.query(
      "SELECT note FROM note_units WHERE workspace_id = $1",
      [test.workspaceId],
    );
    expect(placed).toHaveLength(0);
    // The app's note is indexed at its path, as the list was stored; no other is.
    const { rows: indexed } = await test.db.query(
      "SELECT note FROM note_search WHERE workspace_id = $1",
      [test.workspaceId],
    );
    expect(indexed.map((row) => row.note)).toEqual([theirs]);
  });
});

describe("isNotePath", () => {
  it("takes folders and a name ending in .md that every system can make", () => {
    for (const path of ["Note.md", "Projects/Launch plan.md", "a/b/c.MD", "Été/Ça.md"]) {
      expect(isNotePath(path), path).toBe(true);
    }
    for (const path of [
      "Note.txt",
      ".md",
      "/Note.md",
      "a//b.md",
      "a/ b.md",
      "a /b.md",
      ".obsidian/x.md",
      "a/.md",
      "folder./x.md",
      "con.md",
      "Lpt1/x.md",
      "a:b.md",
      "a\\b.md",
      "what?.md",
      "tab\there.md",
      `${"a".repeat(1000)}.md`,
    ]) {
      expect(isNotePath(path), path).toBe(false);
    }
  });
});
