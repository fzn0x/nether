// Published sites (ADR 0076): those with full access publish a note with
// its subpages or a folder, under a name; anyone opens its pages, drawn as
// the notes are now with a policy that runs nothing, links leading only
// between the site's pages, and the files they show by hash; and a site
// goes at once when it is unpublished, when publishing is off, or when its
// publisher leaves.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDocumentBlocks, setDocumentProperties } from "@nether/editor/document";
import { parseMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DiskBlobs } from "../src/blobs.ts";
import { pagePolicy, stylesheetPath } from "../src/published.ts";
import { maxSites } from "../src/sites.ts";
import { storeDocument } from "../src/sync.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;
const folders: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

type Test = TestServer & SetUp;

/** A server with a place for files. */
async function start(): Promise<Test> {
  const root = await mkdtemp(join(tmpdir(), "nether-sites-"));
  folders.push(root);
  running = await startServer({ blobs: new DiskBlobs(join(root, "blobs")) });
  return { ...running, ...(await setUp(running)) };
}

function noteState(markdown: string): Uint8Array {
  const document = new Y.Doc();
  const parsed = parseMarkdown(markdown);
  setDocumentBlocks(document, parsed.content);
  setDocumentProperties(document, parsed.properties);
  return Y.encodeStateAsUpdate(document);
}

/** Stores notes by path, and General's vault document listing them and the files given. */
async function store(
  test: Test,
  notes: Record<string, string>,
  files: Record<string, string> = {},
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [path, markdown] of Object.entries(notes)) {
    const id = randomUUID();
    ids[path] = id;
    await storeDocument(test.db, test.workspaceId, id, noteState(markdown));
  }
  const vault = new Y.Doc();
  const listed = vault.getMap<string>("notes");
  for (const [path, id] of Object.entries(ids)) listed.set(id, path);
  const kept = vault.getMap("files");
  for (const [path, hash] of Object.entries(files)) kept.set(path, { hash, blob: hash });
  await storeDocument(test.db, test.workspaceId, "vault", Y.encodeStateAsUpdate(vault));
  return ids;
}

/** Sends a file's bytes as the app does, and gives its hash. */
async function upload(test: Test, bytes: Uint8Array, type: string): Promise<string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sent = await test.server.inject({
    method: "PUT",
    url: `/api/workspaces/${test.workspaceId}/attachments/${hash}`,
    headers: {
      ...bearer(test.token),
      "content-type": "application/octet-stream",
      "x-content-type": type,
    },
    payload: Buffer.from(bytes),
  });
  expect(sent.statusCode).toBe(201);
  return hash;
}

function call(test: Test, method: string, path: string, token: string, payload?: object) {
  return test.server.inject({
    method: method as "GET",
    url: path.startsWith("/api/") ? path : `/api/workspaces/${test.workspaceId}${path}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A page of a site, as anyone opens it: no session, no cookie. */
function visit(test: Test, url: string, headers: Record<string, string> = {}) {
  return test.server.inject({ method: "GET", url, headers });
}

interface Shown {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly note: string | null;
  readonly folder: string | null;
  readonly url: string;
  readonly publishedBy: { readonly id: string; readonly name: string };
}

async function publish(test: Test, body: object, token = test.token): Promise<Shown> {
  const made = await call(test, "POST", "/sites", token, body);
  expect(made.statusCode, made.body).toBe(201);
  return made.json<Shown>();
}

/** Another member of the admin's workspace, signed in. */
async function member(test: Test, name: string, invite: object = { role: "member" }) {
  const invited = await call(test, "POST", "/invitations", test.token, invite);
  const accepted = await test.server.inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: invited.json<{ token: string }>().token,
      name,
      email: `${name.toLowerCase()}@example.org`,
      password: `${name}'s long password`,
    },
  });
  const body = accepted.json<{ token: string; user: { id: string } }>();
  return { session: body.token, id: body.user.id };
}

describe("publishing a site", () => {
  it("publishes a note under a name, and lists it to those who may change it", async () => {
    const test = await start();
    const ids = await store(test, { "Handbook.md": "# Handbook\n\nWelcome.\n" });
    const site = await publish(test, { note: ids["Handbook.md"], name: "handbook" });
    expect(site).toMatchObject({
      name: "handbook",
      title: "Handbook",
      note: ids["Handbook.md"],
      folder: null,
      url: "http://localhost:80/p/handbook/",
      publishedBy: { id: test.userId, name: "Ada" },
    });
    const listed = await call(test, "GET", "/sites", test.token);
    expect(listed.json()).toMatchObject({
      publishing: true,
      manages: true,
      sites: [{ id: site.id }],
    });
    // Another member sees the sites where they have full access, as here in General.
    const bea = await member(test, "Bea");
    expect((await call(test, "GET", "/sites", bea.session)).json()).toMatchObject({
      manages: false,
      sites: [{ id: site.id }],
    });
  });

  it("takes a name of its own, and one site for each note or folder", async () => {
    const test = await start();
    const ids = await store(test, { "A.md": "A\n", "B.md": "B\n" });
    const note = ids["A.md"];
    for (const name of ["ab", "-ab", "ab-", "Ab1", "a_b", "a".repeat(64)]) {
      expect((await call(test, "POST", "/sites", test.token, { note, name })).statusCode).toBe(400);
    }
    expect(
      (await call(test, "POST", "/sites", test.token, { name: "both", note, folder: "Docs" }))
        .statusCode,
    ).toBe(400);
    expect((await call(test, "POST", "/sites", test.token, { name: "none" })).statusCode).toBe(400);
    expect(
      (await call(test, "POST", "/sites", test.token, { name: "dots", folder: "../up" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(test, "POST", "/sites", test.token, { name: "gone", note: randomUUID() }))
        .statusCode,
    ).toBe(404);
    await publish(test, { note, name: "first" });
    const twice = await call(test, "POST", "/sites", test.token, { note, name: "second" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ message: string }>().message).toContain("first");
    const taken = await call(test, "POST", "/sites", test.token, {
      note: ids["B.md"],
      name: "first",
    });
    expect(taken.statusCode).toBe(409);
    await publish(test, { folder: "Docs", name: "docs" });
    expect(
      (await call(test, "POST", "/sites", test.token, { folder: "Docs", name: "docs-2" }))
        .statusCode,
    ).toBe(409);
  });

  it("has at most as many sites as a workspace may", async () => {
    const test = await start();
    for (let at = 0; at < maxSites; at++) {
      await test.db.query(
        `INSERT INTO sites (id, workspace_id, publisher_id, name, title, root_folder)
         VALUES ($1, $2, $3, $4, 'Site', $5)`,
        [randomUUID(), test.workspaceId, test.userId, `site-${String(at)}`, `F${String(at)}`],
      );
    }
    const over = await call(test, "POST", "/sites", test.token, { folder: "More", name: "more" });
    expect(over.statusCode).toBe(409);
  });

  it("takes full access where the root is", async () => {
    const test = await start();
    const ids = await store(test, { "Plans.md": "Plans\n" });
    const shared = await call(test, "POST", "/pages", test.token, {
      note: ids["Plans.md"],
      restricted: true,
    });
    const unit = shared.json<{ id: string }>().id;
    const bea = await member(test, "Bea");
    const note = ids["Plans.md"];
    // Not in it at all, then able to edit it: neither publishes it.
    expect(
      (await call(test, "POST", "/sites", bea.session, { note, name: "plans" })).statusCode,
    ).toBe(403);
    await call(test, "PUT", `/units/${unit}/grants/${bea.id}`, test.token, { level: "edit" });
    expect(
      (await call(test, "POST", "/sites", bea.session, { note, name: "plans" })).statusCode,
    ).toBe(403);
    const site = await publish(test, { note, name: "plans" });
    // Nor do they change it or see it listed; the admin does.
    expect((await call(test, "GET", "/sites", bea.session)).json()).toMatchObject({ sites: [] });
    expect(
      (await call(test, "PATCH", `/sites/${site.id}`, bea.session, { title: "Mine" })).statusCode,
    ).toBe(403);
    expect((await call(test, "DELETE", `/sites/${site.id}`, bea.session)).statusCode).toBe(403);
    // A guest with full access to a page publishes it, and nothing in General.
    const guest = await member(test, "Cy", { role: "guest", unit, level: "full" });
    expect(
      (await call(test, "POST", "/sites", guest.session, { folder: "Docs", name: "docs" }))
        .statusCode,
    ).toBe(403);
    await call(test, "DELETE", `/sites/${site.id}`, test.token);
    await publish(test, { note, name: "plans" }, guest.session);
  });

  it("publishes nothing of an encrypted workspace", async () => {
    const test = await start();
    const b64 = (length: number) => Buffer.alloc(length, 1).toString("base64");
    await call(test, "PUT", "/api/me/keys", test.token, {
      publicKey: b64(32),
      recoveryBox: b64(73),
    });
    const made = await call(test, "POST", "/api/workspaces", test.token, {
      name: "Secret",
      encryption: "end-to-end",
      sealedKey: b64(80),
    });
    const secret = made.json<{ id: string }>().id;
    const sent = await call(test, "POST", `/api/workspaces/${secret}/sites`, test.token, {
      folder: "Docs",
      name: "secret",
    });
    expect(sent.statusCode).toBe(409);
    expect(
      (await call(test, "GET", `/api/workspaces/${secret}/sites`, test.token)).statusCode,
    ).toBe(409);
  });
});

describe("a published page", () => {
  it("is the note drawn as HTML with no script, under a policy that runs nothing", async () => {
    const test = await start();
    const ids = await store(test, {
      "Guide.md": [
        "---",
        "status: secret",
        "---",
        "# Guide",
        "",
        "Some **bold** text and $e^x$ math.",
        "",
        "```js",
        "const answer = 42;",
        "```",
        "",
        "<script>alert(1)</script>",
        "",
        "| A | B |",
        "| :-- | --: |",
        "| 1 | 2 |",
        "",
      ].join("\n"),
    });
    await publish(test, { note: ids["Guide.md"], name: "guide", title: "The guide" });
    const page = await visit(test, "/p/guide/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(pagePolicy);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.headers["set-cookie"]).toBeUndefined();
    const html = page.body;
    expect(html).toContain("<title>Guide</title>");
    expect(html).toContain('<header class="site"><a href="/p/guide/">The guide</a></header>');
    expect(html).toContain(`<link rel="stylesheet" href="${stylesheetPath}">`);
    expect(html).toContain('<h1 id="guide">Guide</h1>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<math");
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('style="text-align: right"');
    // What the note writes as HTML is its text; its properties are not shown.
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("secret");
    // A page asked for again as it is answers that it has not changed.
    const tag = page.headers.etag;
    expect(typeof tag).toBe("string");
    const again = await visit(test, "/p/guide/", { "if-none-match": String(tag) });
    expect(again.statusCode).toBe(304);
  });

  it("follows its note as it is stored", async () => {
    const test = await start();
    const ids = await store(test, { "Live.md": "First words.\n" });
    const site = await publish(test, { note: ids["Live.md"], name: "live" });
    expect((await visit(test, "/p/live/")).body).toContain("First words.");
    await storeDocument(
      test.db,
      test.workspaceId,
      ids["Live.md"] ?? "",
      noteState("Second words.\n"),
    );
    // The page follows a few seconds after; a change to the site forgets what was kept at once.
    await call(test, "PATCH", `/sites/${site.id}`, test.token, { title: "Live" });
    expect((await visit(test, "/p/live/")).body).toContain("Second words.");
  });

  it("redirects a site's address to the one with a slash, and has a stylesheet", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home\n" });
    await publish(test, { note: ids["Home.md"], name: "home" });
    const bare = await visit(test, "/p/home");
    expect(bare.statusCode).toBe(308);
    expect(bare.headers.location).toBe("/p/home/");
    const style = await visit(test, stylesheetPath);
    expect(style.statusCode).toBe(200);
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(style.headers["content-security-policy"]).toBe(pagePolicy);
    expect(style.body).toContain("prefers-color-scheme: dark");
  });

  it("answers as not there for a site no one published, or a page it has not", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home\n" });
    await publish(test, { note: ids["Home.md"], name: "home" });
    for (const url of ["/p/nothing/", "/p/nothing/Page", "/p/home/Other", "/p/x/"]) {
      const answer = await visit(test, url);
      expect(answer.statusCode, url).toBe(404);
      expect(answer.headers["content-security-policy"]).toBe(pagePolicy);
      expect(answer.body).toContain("Not published");
    }
  });
});

describe("a site's links", () => {
  it("lead only between the site's pages, the others left as text", async () => {
    const test = await start();
    const ids = await store(test, {
      "Handbook.md": [
        "# Handbook",
        "",
        "See [[Setup]], [[Setup#Install steps|installing]], [[Setup guide]] and [[#Handbook]].",
        "",
        "Also [[Draft]], [[Hidden]], [[Outside]] and [[Missing]].",
        "",
        "[As Markdown](Handbook/Setup.md#install-steps), [elsewhere](Outside.md) and [the web](https://example.org).",
        "",
        "![[Setup]]",
        "",
      ].join("\n"),
      "Handbook/Setup.md":
        "---\naliases: [Setup guide]\n---\n# Setup\n\n## Install steps\n\nBack to [[Handbook]].\n",
      "Handbook/Draft.md": "Draft\n",
      "Handbook/Hidden.md": "---\npublish: false\n---\nHidden\n",
      "Handbook/Deep/Page.md": "Deep\n",
      "Outside.md": "Outside\n",
    });
    // A restricted page the publisher may only view is not one of their site's.
    const shared = await call(test, "POST", "/pages", test.token, {
      note: ids["Handbook/Draft.md"],
      restricted: true,
    });
    const bea = await member(test, "Bea");
    await call(
      test,
      "PUT",
      `/units/${shared.json<{ id: string }>().id}/grants/${bea.id}`,
      test.token,
      {
        level: "view",
      },
    );
    await publish(test, { note: ids["Handbook.md"], name: "handbook" }, bea.session);

    const html = (await visit(test, "/p/handbook/")).body;
    expect(html).toContain('<a class="internal-link" href="/p/handbook/Setup">Setup</a>');
    expect(html).toContain(
      '<a class="internal-link" href="/p/handbook/Setup#install-steps">installing</a>',
    );
    expect(html).toContain('<a class="internal-link" href="/p/handbook/Setup">Setup guide</a>');
    expect(html).toContain('<a class="internal-link" href="/p/handbook/#handbook">');
    for (const text of ["Draft", "Hidden", "Outside", "Missing"]) {
      expect(html).toContain(`<span class="internal-link unresolved">${text}</span>`);
    }
    expect(html).toContain('<a href="/p/handbook/Setup#install-steps">As Markdown</a>');
    expect(html).not.toContain('href="Outside.md"');
    expect(html).toContain("elsewhere");
    expect(html).toContain('<a href="https://example.org">the web</a>');
    // An embed of a published note shows as a link to it.
    expect(html).toContain('<p class="embed"><a class="internal-link" href="/p/handbook/Setup">');

    const setup = await visit(test, "/p/handbook/Setup");
    expect(setup.statusCode).toBe(200);
    expect(setup.body).toContain("<title>Setup · Handbook</title>");
    expect(setup.body).toContain('<a class="internal-link" href="/p/handbook/">Handbook</a>');
    expect((await visit(test, "/p/handbook/Deep/Page")).statusCode).toBe(200);
    for (const page of ["Draft", "Hidden", "Outside", "../Outside"]) {
      expect((await visit(test, `/p/handbook/${page}`)).statusCode, page).toBe(404);
    }
  });

  it("make a folder's site, its first page a list of its pages", async () => {
    const test = await start();
    await store(test, {
      "Docs/Start.md": "# Start\n\nRead [[Next]].\n",
      "Docs/More/Next.md": "Next\n",
      "Docs/Ünïcode name.md": "Unicode\n",
      "Elsewhere.md": "Not this\n",
    });
    await publish(test, { folder: "Docs", name: "docs", title: "Our docs" });
    const index = await visit(test, "/p/docs/");
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("<title>Our docs</title>");
    expect(index.body).toContain('<a href="/p/docs/Start">Start</a>');
    expect(index.body).toContain('<a href="/p/docs/More/Next">Next</a> <small>More</small>');
    expect(index.body).toContain(`href="/p/docs/${encodeURIComponent("Ünïcode name")}"`);
    expect(index.body).not.toContain("Elsewhere");
    expect((await visit(test, "/p/docs/Start")).body).toContain('href="/p/docs/More/Next"');
    expect((await visit(test, `/p/docs/${encodeURIComponent("Ünïcode name")}`)).body).toContain(
      "Unicode",
    );
  });
});

describe("a site's files", () => {
  it("are served by hash once a page shows them, running nothing", async () => {
    const test = await start();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    const shown = await upload(test, png, "image/png");
    const other = await upload(test, new Uint8Array([1, 2, 3]), "text/html");
    const ids = await store(
      test,
      { "Album.md": "![[photo.png]]\n\n![](Album/missing.png)\n" },
      { "Album/photo.png": shown, "secret.html": other },
    );
    const site = await publish(test, { note: ids["Album.md"], name: "album" });
    const html = (await visit(test, "/p/album/")).body;
    const src = `/p/album/.files/${shown}/photo.png`;
    expect(html).toContain(`<img src="${src}" alt="">`);
    expect(html).toContain('<p class="file missing">');
    const file = await visit(test, src);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
    expect(new Uint8Array(file.rawPayload)).toEqual(png);
    expect((await visit(test, src, { "if-none-match": `"${shown}"` })).statusCode).toBe(304);
    // A file of the workspace no page showed is not served.
    expect((await visit(test, `/p/album/.files/${other}/secret.html`)).statusCode).toBe(404);
    expect((await visit(test, `/p/album/.files/nothash/x`)).statusCode).toBe(404);
    // Unpublished, the site's files go with it.
    await call(test, "DELETE", `/sites/${site.id}`, test.token);
    expect((await visit(test, src)).statusCode).toBe(404);
    const { rows } = await test.db.query("SELECT 1 FROM site_files");
    expect(rows).toHaveLength(0);
  });
});

describe("a site going", () => {
  it("goes at once when unpublished, or moves when renamed", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home\n" });
    const site = await publish(test, { note: ids["Home.md"], name: "home" });
    expect((await visit(test, "/p/home/")).statusCode).toBe(200);
    const renamed = await call(test, "PATCH", `/sites/${site.id}`, test.token, { name: "house" });
    expect(renamed.json()).toMatchObject({ name: "house", url: "http://localhost:80/p/house/" });
    expect((await visit(test, "/p/home/")).statusCode).toBe(404);
    expect((await visit(test, "/p/house/")).statusCode).toBe(200);
    expect((await call(test, "DELETE", `/sites/${site.id}`, test.token)).statusCode).toBe(204);
    expect((await visit(test, "/p/house/")).statusCode).toBe(404);
    expect((await call(test, "GET", "/sites", test.token)).json()).toMatchObject({ sites: [] });
  });

  it("goes while publishing is off, which only owners and admins switch", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home\n" });
    await publish(test, { note: ids["Home.md"], name: "home" });
    const bea = await member(test, "Bea");
    const off = { enabled: false };
    expect((await call(test, "PUT", "/publishing", bea.session, off)).statusCode).toBe(403);
    expect((await call(test, "PUT", "/publishing", test.token, off)).json()).toEqual(off);
    expect((await visit(test, "/p/home/")).statusCode).toBe(404);
    expect((await call(test, "GET", "/sites", test.token)).json()).toMatchObject({
      publishing: false,
    });
    const refused = await call(test, "POST", "/sites", test.token, {
      folder: "Docs",
      name: "docs",
    });
    expect(refused.statusCode).toBe(409);
    await call(test, "PUT", "/publishing", test.token, { enabled: true });
    expect((await visit(test, "/p/home/")).statusCode).toBe(200);
  });

  it("goes with its publisher when they leave the workspace", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home\n" });
    const bea = await member(test, "Bea");
    await publish(test, { note: ids["Home.md"], name: "home" }, bea.session);
    expect((await visit(test, "/p/home/")).statusCode).toBe(200);
    expect((await call(test, "DELETE", `/members/${bea.id}`, test.token)).statusCode).toBe(204);
    expect((await visit(test, "/p/home/")).statusCode).toBe(404);
  });

  it("loses the pages its publisher can no longer open", async () => {
    const test = await start();
    const ids = await store(test, {
      "Home.md": "Home, see [[Home/Plans]]\n",
      "Home/Plans.md": "Plans\n",
    });
    const bea = await member(test, "Bea");
    const site = await publish(test, { note: ids["Home.md"], name: "home" }, bea.session);
    expect((await visit(test, "/p/home/Plans")).statusCode).toBe(200);
    await call(test, "POST", "/pages", test.token, {
      note: ids["Home/Plans.md"],
      restricted: true,
    });
    // Forgotten at once for the test; otherwise within a few seconds.
    await call(test, "PATCH", `/sites/${site.id}`, test.token, { title: "Home" });
    expect((await visit(test, "/p/home/Plans")).statusCode).toBe(404);
    expect((await visit(test, "/p/home/")).body).toContain(
      '<span class="internal-link unresolved">Home/Plans</span>',
    );
  });
});
