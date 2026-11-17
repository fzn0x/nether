// Share links (ADR 0071): those with full access to a page shared on its
// own make, list and revoke its links; anyone with one opens a visit, with
// its password when it has one, until it expires or is revoked; and a
// visit syncs that page's unit alone, read-only, and reads its workspace's
// files by their hash.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DiskBlobs } from "../src/blobs.ts";
import { maxLinks, needsPassword, noPage, wrongLinkPassword } from "../src/links.ts";
import { storeDocument } from "../src/sync.ts";
import { type SetUp, type TestServer, admin, bearer, setUp, startServer } from "./app.ts";
import { freePort } from "./ports.ts";

let running: TestServer | undefined;
const providers: HocuspocusProvider[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await running?.close();
  running = undefined;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

type Test = TestServer & SetUp;

/** A server with a web app, which is what opens links, and a place for files. */
async function start(): Promise<Test> {
  const root = await mkdtemp(join(tmpdir(), "nether-links-"));
  folders.push(root);
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Nether</title>");
  running = await startServer({
    blobs: new DiskBlobs(join(root, "blobs")),
    env: { NETHER_WEB_APP: web },
  });
  return { ...running, ...(await setUp(running)) };
}

function call(
  test: Test,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: object,
) {
  return test.server.inject({
    method: method as "GET",
    url: path.startsWith("/api/") ? path : `/api/workspaces/${test.workspaceId}${path}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Shares a page on its own, and gives its unit's ID. */
async function sharePage(test: Test, note = randomUUID()): Promise<{ unit: string; note: string }> {
  const made = await call(test, "POST", "/pages", bearer(test.token), { note });
  expect(made.statusCode).toBe(201);
  return { unit: made.json<{ id: string }>().id, note };
}

async function makeLink(test: Test, unit: string, body: object = { level: "view" }) {
  return call(test, "POST", `/units/${unit}/links`, bearer(test.token), body);
}

/** The token a link's address carries after its `#`. */
function tokenOf(url: string): string {
  return url.slice(url.indexOf("#") + 1);
}

/** Opens a link, and gives the answer with the visit's cookie, as a browser would send it back. */
async function open(test: Test, token: string, password?: string) {
  const answer = await call(
    test,
    "POST",
    "/api/links/open",
    {},
    {
      token,
      ...(password === undefined ? {} : { password }),
    },
  );
  const set = answer.headers["set-cookie"];
  const cookie = (Array.isArray(set) ? set[0] : set)?.split(";")[0] ?? "";
  return { answer, cookie };
}

/** A unit's vault document listing notes by path. */
function listing(notes: Record<string, string>): Uint8Array {
  const document = new Y.Doc();
  const map = document.getMap<string>("notes");
  for (const [id, path] of Object.entries(notes)) map.set(id, path);
  return Y.encodeStateAsUpdate(document);
}

function note(text: string): Uint8Array {
  const document = new Y.Doc();
  document.getText("text").insert(0, text);
  return Y.encodeStateAsUpdate(document);
}

describe("share links", () => {
  it("are made, listed and revoked by those with full access to the page", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    const made = await makeLink(test, unit, {
      level: "view",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      password: "a long password",
    });
    expect(made.statusCode).toBe(201);
    const link = made.json<{
      id: string;
      url: string;
      password: boolean;
      expiresAt: string;
      createdBy: string;
    }>();
    expect(link.url).toMatch(/\/s#nether_link_[A-Za-z0-9_-]{43}$/);
    expect(link.password).toBe(true);
    expect(link.createdBy).toBe(admin.name);
    const listed = await call(test, "GET", `/units/${unit}/links`, bearer(test.token));
    expect(listed.json<{ links: { id: string; url: string }[] }>().links).toEqual([
      expect.objectContaining({ id: link.id, url: link.url }),
    ]);
    // The same link, copied again.
    const gone = await call(test, "DELETE", `/units/${unit}/links/${link.id}`, bearer(test.token));
    expect(gone.statusCode).toBe(204);
    expect((await call(test, "GET", `/units/${unit}/links`, bearer(test.token))).json()).toEqual({
      links: [],
    });
  });

  it("are refused where there is no page shared on its own, or no full access", async () => {
    const test = await start();
    expect((await makeLink(test, randomUUID())).statusCode).toBe(404);
    const { unit } = await sharePage(test);
    const past = await makeLink(test, unit, {
      level: "view",
      expiresAt: "2001-01-01T00:00:00.000Z",
    });
    expect(past.json<{ message: string }>().message).toBe("A link's expiry is in the future.");
    expect((await makeLink(test, unit, { level: "full" })).statusCode).toBe(400);
    const stranger = await call(test, "GET", `/units/${unit}/links`, {});
    expect(stranger.statusCode).toBe(401);
  });

  it("are at most so many to a page", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    for (let at = 0; at < maxLinks; at++) expect((await makeLink(test, unit)).statusCode).toBe(201);
    const over = await makeLink(test, unit);
    expect(over.statusCode).toBe(409);
  });
});

describe("opening a share link", () => {
  it("starts a visit of its page, with its password when it has one", async () => {
    const test = await start();
    const { unit, note: page } = await sharePage(test);
    const plain = tokenOf((await makeLink(test, unit)).json<{ url: string }>().url);
    const { answer, cookie } = await open(test, plain);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      workspace: test.workspaceId,
      unit,
      document: `vault.${unit}`,
      level: "view",
      page,
    });
    expect(cookie).toMatch(/^nether_visit=nether_visit_/);
    expect(String(answer.headers["set-cookie"])).toContain("HttpOnly");
    const visit = await call(test, "GET", "/api/links/visit", { cookie });
    expect(visit.json()).toMatchObject({ unit, page, level: "view" });

    const locked = tokenOf(
      (await makeLink(test, unit, { level: "view", password: "a long password" })).json<{
        url: string;
      }>().url,
    );
    expect((await open(test, locked)).answer.json<{ message: string }>().message).toBe(
      needsPassword,
    );
    expect(
      (await open(test, locked, "a wrong one")).answer.json<{ message: string }>().message,
    ).toBe(wrongLinkPassword);
    expect((await open(test, locked, "a long password")).answer.statusCode).toBe(200);
    expect(
      (await open(test, "nether_link_nothing")).answer.json<{ message: string }>().message,
    ).toBe(noPage);
  });

  it("ends with its link, expired or revoked", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    const link = (await makeLink(test, unit)).json<{ id: string; url: string }>();
    const { cookie } = await open(test, tokenOf(link.url));
    await test.db.query(
      "UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [link.id],
    );
    expect((await open(test, tokenOf(link.url))).answer.statusCode).toBe(404);
    expect((await call(test, "GET", "/api/links/visit", { cookie })).statusCode).toBe(401);

    const other = (await makeLink(test, unit)).json<{ id: string; url: string }>();
    const { cookie: again } = await open(test, tokenOf(other.url));
    expect((await call(test, "GET", "/api/links/visit", { cookie: again })).statusCode).toBe(200);
    await call(test, "DELETE", `/units/${unit}/links/${other.id}`, bearer(test.token));
    expect((await call(test, "GET", "/api/links/visit", { cookie: again })).statusCode).toBe(401);
  });

  it("reads the workspace's files by their hash, and nothing of another workspace", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const sent = await test.server.inject({
      method: "PUT",
      url: `/api/workspaces/${test.workspaceId}/attachments/${hash}`,
      headers: { ...bearer(test.token), "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });
    expect(sent.statusCode).toBe(201);
    const { cookie } = await open(
      test,
      tokenOf((await makeLink(test, unit)).json<{ url: string }>().url),
    );
    const read = await call(test, "GET", `/attachments/${hash}`, { cookie });
    expect(read.statusCode).toBe(200);
    expect(new Uint8Array(read.rawPayload)).toEqual(bytes);
    const elsewhere = await call(
      test,
      "GET",
      `/api/workspaces/${randomUUID()}/attachments/${hash}`,
      { cookie },
    );
    expect(elsewhere.statusCode).toBe(404);
    expect((await call(test, "GET", `/attachments/${hash}`, {})).statusCode).toBe(401);
  });
});

describe("a visit's sync", () => {
  function connect(url: string, name: string, token: string): Promise<HocuspocusProvider> {
    return new Promise((resolve, reject) => {
      const provider = new HocuspocusProvider({
        url,
        name,
        token,
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

  it("opens its page's unit alone, read-only", async () => {
    const test = await start();
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const url = `ws://127.0.0.1:${String((test.server.server.address() as AddressInfo).port)}/api/sync`;
    const { unit, note: page } = await sharePage(test);
    await storeDocument(test.db, test.workspaceId, `vault.${unit}`, listing({ [page]: "Plan.md" }));
    await storeDocument(test.db, test.workspaceId, page, note("The plan."));
    const other = randomUUID();
    await storeDocument(test.db, test.workspaceId, other, note("Not shared."));
    const { answer } = await open(
      test,
      tokenOf((await makeLink(test, unit)).json<{ url: string }>().url),
    );
    // The cookie a browser sends the socket stands in for a token here.
    const set = String(answer.headers["set-cookie"]);
    const visit = decodeURIComponent(/nether_visit=([^;]+)/.exec(set)?.[1] ?? "");

    const listed = await connect(url, `${test.workspaceId}/vault.${unit}`, visit);
    expect(listed.document.getMap<string>("notes").get(page)).toBe("Plan.md");
    const shown = await connect(url, `${test.workspaceId}/${page}`, visit);
    expect(shown.document.getText("text").toJSON()).toBe("The plan.");
    // What it changes is refused, and stays its own.
    shown.document.getText("text").insert(0, "Changed. ");
    const reader = await connect(url, `${test.workspaceId}/${page}`, test.token);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reader.document.getText("text").toJSON()).toBe("The plan.");

    await expect(connect(url, `${test.workspaceId}/${other}`, visit)).rejects.toThrow();
    await expect(connect(url, `${test.workspaceId}/vault`, visit)).rejects.toThrow();
    await expect(connect(url, `${test.workspaceId}/${page}.comments`, visit)).rejects.toThrow();
  });

  /** Waits until a document's text is `expected`, a few seconds at most. */
  async function until(read: () => string, expected: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (read() !== expected) {
      if (Date.now() > deadline) throw new Error(`Still ${JSON.stringify(read())}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("writes what its link's level lets it, and never the unit's list", async () => {
    const test = await start();
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const url = `ws://127.0.0.1:${String((test.server.server.address() as AddressInfo).port)}/api/sync`;
    const { unit, note: page } = await sharePage(test);
    await storeDocument(test.db, test.workspaceId, `vault.${unit}`, listing({ [page]: "Plan.md" }));
    await storeDocument(test.db, test.workspaceId, page, note("The plan."));
    await storeDocument(test.db, test.workspaceId, `${page}.comments`, note("A thread."));
    const visitOf = async (level: string) => {
      const made = await makeLink(test, unit, { level });
      const { answer } = await open(test, tokenOf(made.json<{ url: string }>().url));
      return decodeURIComponent(
        /nether_visit=([^;]+)/.exec(String(answer.headers["set-cookie"]))?.[1] ?? "",
      );
    };
    const commenter = await visitOf("comment");
    const editor = await visitOf("edit");
    const owner = await connect(url, `${test.workspaceId}/${page}`, test.token);
    const ownerComments = await connect(url, `${test.workspaceId}/${page}.comments`, test.token);
    const ownerList = await connect(url, `${test.workspaceId}/vault.${unit}`, test.token);

    // A comment link writes comments, and not the note.
    const commented = await connect(url, `${test.workspaceId}/${page}.comments`, commenter);
    commented.document.getText("text").insert(0, "Visitor: ");
    await until(() => ownerComments.document.getText("text").toJSON(), "Visitor: A thread.");
    const read = await connect(url, `${test.workspaceId}/${page}`, commenter);
    read.document.getText("text").insert(0, "Changed. ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(owner.document.getText("text").toJSON()).toBe("The plan.");

    // An edit link writes the note, and still not the unit's list of notes.
    const edited = await connect(url, `${test.workspaceId}/${page}`, editor);
    await until(() => edited.document.getText("text").toJSON(), "The plan.");
    edited.document.getText("text").insert(9, " Edited.");
    await until(() => owner.document.getText("text").toJSON(), "The plan. Edited.");
    const list = await connect(url, `${test.workspaceId}/vault.${unit}`, editor);
    list.document.getMap<string>("notes").set(randomUUID(), "Planted.md");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([...ownerList.document.getMap<string>("notes").values()]).toEqual(["Plan.md"]);
  });
});
