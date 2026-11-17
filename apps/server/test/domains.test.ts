// Custom domains and search engines for published sites (ADR 0077): a site
// claims a domain and holds it once a TXT record proves the claim, taking
// it from any site that held it; requests to the domain are the site's
// alone, and a proxy asks the server before it gets a certificate. Each
// page has its description, canonical address and card, and a site its
// sitemap and robots.txt, or asks not to be indexed.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDocumentBlocks, setDocumentProperties } from "@nether/editor/document";
import { parseMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DiskBlobs } from "../src/blobs.ts";
import { domainName } from "../src/domains.ts";
import { storeDocument } from "../src/sync.ts";
import { type SetUp, type TestServer, bearer, setUp, startServer } from "./app.ts";

let running: TestServer | undefined;
const folders: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

type Test = TestServer & SetUp & { readonly txt: Map<string, string[][]> };

/** A server with a place for files, and DNS whose TXT records the test writes. */
async function start(env: Record<string, string> = {}): Promise<Test> {
  const root = await mkdtemp(join(tmpdir(), "nether-domains-"));
  folders.push(root);
  const txt = new Map<string, string[][]>();
  running = await startServer({
    blobs: new DiskBlobs(join(root, "blobs")),
    env,
    resolveTxt: (name) => {
      if (name === "_nether-site.broken.example.org") {
        return Promise.reject(
          Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" }),
        );
      }
      const found = txt.get(name);
      return found === undefined
        ? Promise.reject(Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" }))
        : Promise.resolve(found);
    },
  });
  return { ...running, ...(await setUp(running)), txt };
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

/** A request as a browser sends it to a host, with no session. */
function visit(test: Test, url: string, host = "localhost:80", method = "GET") {
  return test.server.inject({ method: method as "GET", url, headers: { host } });
}

interface Shown {
  readonly id: string;
  readonly url: string;
  readonly pathUrl: string;
  readonly indexed: boolean;
  readonly domain: {
    readonly name: string;
    readonly verified: boolean;
    readonly record: { readonly type: string; readonly name: string; readonly value: string };
  } | null;
}

async function publish(test: Test, body: object, token = test.token): Promise<Shown> {
  const made = await call(test, "POST", "/sites", token, body);
  expect(made.statusCode, made.body).toBe(201);
  return made.json<Shown>();
}

/** Claims a domain for a site, writes its record, and checks it. */
async function hold(test: Test, site: string, domain: string): Promise<Shown> {
  const claimed = await call(test, "PUT", `/sites/${site}/domain`, test.token, { domain });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const { record } = claimed.json<Shown>().domain ?? { record: undefined };
  if (record === undefined) throw new Error("No record to write.");
  test.txt.set(record.name, [[record.value]]);
  const checked = await call(test, "POST", `/sites/${site}/domain/check`, test.token);
  expect(checked.statusCode, checked.body).toBe(200);
  return checked.json<Shown>();
}

async function member(test: Test, name: string) {
  const invited = await call(test, "POST", "/invitations", test.token, { role: "member" });
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

describe("domainName", () => {
  it("takes a domain as a site may hold it, lowercased, in ASCII, without its last dot", () => {
    expect(domainName(" Docs.Example.ORG. ")).toBe("docs.example.org");
    expect(domainName("bücher.example")).toBe("xn--bcher-kva.example");
    expect(domainName("a-b.c-d.example.org")).toBe("a-b.c-d.example.org");
  });

  it("refuses addresses, single names, local names, odd labels and the server's own host", () => {
    for (const text of [
      "",
      "localhost",
      "docs.localhost",
      "example",
      "127.0.0.1",
      "1.2.3.4",
      "::1",
      "[::1]",
      "a..example.org",
      "-docs.example.org",
      "docs-.example.org",
      "_nether-site.example.org",
      "docs.example.org/path",
      "docs.example.123",
      `${"a".repeat(64)}.example.org`,
    ]) {
      expect(domainName(text), text).toBeUndefined();
    }
    expect(domainName("nether.example.org", "nether.example.org")).toBeUndefined();
  });
});

describe("a site's custom domain", () => {
  it("is held once its TXT record has the claim's value, and the proxy may ask for it", async () => {
    const test = await start();
    const ids = await store(test, { "Handbook.md": "# Handbook\n\nWelcome.\n" });
    const site = await publish(test, { note: ids["Handbook.md"], name: "handbook" });
    expect(site.domain).toBeNull();

    const claimed = await call(test, "PUT", `/sites/${site.id}/domain`, test.token, {
      domain: "Docs.Example.org",
    });
    const pending = claimed.json<Shown>();
    expect(pending).toMatchObject({
      url: "http://localhost:80/p/handbook/",
      domain: {
        name: "docs.example.org",
        verified: false,
        record: { type: "TXT", name: "_nether-site.docs.example.org" },
      },
    });
    const value = pending.domain?.record.value ?? "";
    expect(value).toMatch(/^nether-site=[A-Za-z0-9_-]{24}$/);
    // The same domain again keeps the claim and its value.
    const again = await call(test, "PUT", `/sites/${site.id}/domain`, test.token, {
      domain: "docs.example.org",
    });
    expect(again.json<Shown>().domain?.record.value).toBe(value);

    // Not held, the domain is not the site's, and the proxy gets no certificate for it.
    const ask = (domain: string) => visit(test, `/api/sites/domain?domain=${domain}`);
    expect((await ask("docs.example.org")).statusCode).toBe(404);
    expect((await visit(test, "/", "docs.example.org")).statusCode).toBe(404);
    expect((await visit(test, "/", "docs.example.org")).headers["content-type"]).toContain("json");

    const early = await call(test, "POST", `/sites/${site.id}/domain/check`, test.token);
    expect(early.statusCode).toBe(409);
    expect(early.json<{ message: string }>().message).toContain("_nether-site.docs.example.org");
    test.txt.set("_nether-site.docs.example.org", [["nether-site=someone-else"]]);
    expect(
      (await call(test, "POST", `/sites/${site.id}/domain/check`, test.token)).statusCode,
    ).toBe(409);
    // A record split into strings, as long ones are, is read whole.
    test.txt.set("_nether-site.docs.example.org", [
      ["v=spf1 -all"],
      [value.slice(0, 10), value.slice(10)],
    ]);
    const held = await call(test, "POST", `/sites/${site.id}/domain/check`, test.token);
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json<Shown>()).toMatchObject({
      url: "https://docs.example.org/",
      pathUrl: "http://localhost:80/p/handbook/",
      domain: { name: "docs.example.org", verified: true },
    });
    expect((await ask("docs.example.org")).json()).toEqual({ domain: "docs.example.org" });
    expect((await ask("DOCS.example.org.")).statusCode).toBe(200);
    expect((await ask("other.example.org")).statusCode).toBe(404);
    expect((await ask("127.0.0.1")).statusCode).toBe(404);
    expect((await visit(test, "/api/sites/domain")).statusCode).toBe(400);
  });

  it("refuses a domain no site can have, a lookup that fails, and those without full access", async () => {
    const test = await start({ NETHER_PUBLIC_URL: "https://nether.example.org" });
    const ids = await store(test, { "Home.md": "Home\n" });
    const site = await publish(test, { note: ids["Home.md"], name: "home" });
    for (const domain of ["nether.example.org", "localhost", "10.0.0.1", "home"]) {
      const refused = await call(test, "PUT", `/sites/${site.id}/domain`, test.token, { domain });
      expect(refused.statusCode, domain).toBe(400);
    }
    await call(test, "PUT", `/sites/${site.id}/domain`, test.token, {
      domain: "broken.example.org",
    });
    const failed = await call(test, "POST", `/sites/${site.id}/domain/check`, test.token);
    expect(failed.statusCode).toBe(502);
    expect(failed.json<{ message: string }>().message).toContain("ESERVFAIL");

    const shared = await call(test, "POST", "/pages", test.token, {
      note: ids["Home.md"],
      restricted: true,
    });
    expect(shared.statusCode).toBe(201);
    const bea = await member(test, "Bea");
    const theirs = await call(test, "PUT", `/sites/${site.id}/domain`, bea.session, {
      domain: "bea.example.org",
    });
    expect(theirs.statusCode).toBe(403);
    expect(
      (await call(test, "POST", `/sites/${site.id}/domain/check`, bea.session)).statusCode,
    ).toBe(403);
    const none = await publish(test, { folder: "Docs", name: "docs" });
    expect(
      (await call(test, "POST", `/sites/${none.id}/domain/check`, test.token)).statusCode,
    ).toBe(409);
  });

  it("goes to whoever proves it last, taken from the site that held it", async () => {
    const test = await start();
    const ids = await store(test, { "A.md": "Site A\n", "B.md": "Site B\n" });
    const a = await publish(test, { note: ids["A.md"], name: "site-a" });
    const b = await publish(test, { note: ids["B.md"], name: "site-b" });
    await hold(test, a.id, "docs.example.org");
    expect((await visit(test, "/", "docs.example.org")).body).toContain("Site A");
    // Another claim waits beside it until its own record is there.
    await call(test, "PUT", `/sites/${b.id}/domain`, test.token, { domain: "docs.example.org" });
    expect((await visit(test, "/", "docs.example.org")).body).toContain("Site A");
    await hold(test, b.id, "docs.example.org");
    expect((await visit(test, "/", "docs.example.org")).body).toContain("Site B");
    const listed = await call(test, "GET", "/sites", test.token);
    const sites = listed.json<{ sites: Shown[] }>().sites;
    expect(sites.find((site) => site.id === a.id)?.domain).toBeNull();
    expect(sites.find((site) => site.id === b.id)?.domain?.verified).toBe(true);
  });

  it("stops being the site's at once when given up, unpublished or publishing is off", async () => {
    const test = await start();
    const ids = await store(test, { "Home.md": "Home page\n" });
    const site = await publish(test, { note: ids["Home.md"], name: "home" });
    await hold(test, site.id, "home.example.org");
    expect((await visit(test, "/", "home.example.org")).statusCode).toBe(200);

    await call(test, "PUT", "/publishing", test.token, { enabled: false });
    expect((await visit(test, "/", "home.example.org")).statusCode).toBe(404);
    expect((await visit(test, "/api/sites/domain?domain=home.example.org")).statusCode).toBe(404);
    await call(test, "PUT", "/publishing", test.token, { enabled: true });
    expect((await visit(test, "/", "home.example.org")).statusCode).toBe(200);

    const given = await call(test, "DELETE", `/sites/${site.id}/domain`, test.token);
    expect(given.json<Shown>()).toMatchObject({ domain: null, url: "http://localhost:80/p/home/" });
    expect((await visit(test, "/", "home.example.org")).headers["content-type"]).toContain("json");

    await hold(test, site.id, "home.example.org");
    await call(test, "DELETE", `/sites/${site.id}`, test.token);
    expect((await visit(test, "/", "home.example.org")).headers["content-type"]).toContain("json");
  });
});

describe("a site on its domain", () => {
  it("answers every path there, and nothing of the API or the web app", async () => {
    const test = await start();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
    const hash = await upload(test, png, "image/png");
    const ids = await store(
      test,
      {
        "Guide.md": "# Guide\n\nRead [[Setup]].\n\n![[cover.png]]\n",
        "Guide/Setup.md": "# Setup\n\nBack to [[Guide]].\n",
      },
      { "cover.png": hash },
    );
    const site = await publish(test, { note: ids["Guide.md"], name: "guide" });
    await hold(test, site.id, "docs.example.org");

    const root = await visit(test, "/", "docs.example.org:8443");
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(root.body).toContain('<header class="site"><a href="/">Guide</a></header>');
    expect(root.body).toContain('<link rel="stylesheet" href="/.nether/site.css">');
    expect(root.body).toContain('<a class="internal-link" href="/Setup">Setup</a>');
    expect(root.body).toContain(`<img src="/.files/${hash}/cover.png" alt="">`);
    expect((await visit(test, "/Setup", "docs.example.org")).body).toContain(
      '<a class="internal-link" href="/">Guide</a>',
    );
    const style = await visit(test, "/.nether/site.css", "docs.example.org");
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
    const image = await visit(test, `/.files/${hash}/cover.png`, "docs.example.org");
    expect(image.statusCode).toBe(200);
    expect(new Uint8Array(image.rawPayload)).toEqual(png);

    for (const [method, url] of [
      ["GET", "/api/me"],
      ["GET", "/api/sites/domain?domain=docs.example.org"],
      ["POST", "/api/sessions"],
      ["GET", "/p/guide/"],
      ["GET", "/Missing"],
    ] as const) {
      const answer = await visit(test, url, "docs.example.org", method);
      expect(answer.statusCode, url).toBe(404);
      expect(answer.headers["content-type"], url).toBe("text/html; charset=utf-8");
      expect(answer.body, url).toContain("Not published");
    }
    // The server's own host is still the server's.
    expect((await call(test, "GET", "/api/me", test.token)).statusCode).toBe(200);
    expect((await visit(test, "/p/guide/")).statusCode).toBe(200);
  });
});

describe("what a page tells search engines", () => {
  it("has its description, its canonical address on the domain, and its card", async () => {
    const test = await start();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9]);
    const hash = await upload(test, png, "image/png");
    const long = `${"word ".repeat(60)}end`;
    const ids = await store(
      test,
      {
        "Guide.md": `# Guide\n\nThe guide's first words, with a [[Setup|link]] and #tag.\n\nMore.\n\n![[cover.png]]\n`,
        "Guide/Setup.md": `---\ndescription: How to set it up.\nimage: https://example.org/card.png\n---\nSetup text.\n`,
        "Guide/Long.md": `${long}\n`,
        "Guide/Bare.md": "## Only a heading\n",
      },
      { "cover.png": hash },
    );
    const site = await publish(test, { note: ids["Guide.md"], name: "guide" });

    const before = (await visit(test, "/p/guide/")).body;
    expect(before).toContain('<link rel="canonical" href="http://localhost:80/p/guide/">');

    await hold(test, site.id, "docs.example.org");
    for (const host of ["docs.example.org", "localhost:80"]) {
      const url = host === "localhost:80" ? "/p/guide/" : "/";
      const html = (await visit(test, url, host)).body;
      expect(html).toContain('<link rel="canonical" href="https://docs.example.org/">');
      expect(html).toContain(
        `<meta name="description" content="The guide&#39;s first words, with a link and #tag.">`,
      );
      expect(html).toContain('<meta property="og:type" content="website">');
      expect(html).toContain('<meta property="og:site_name" content="Guide">');
      expect(html).toContain('<meta property="og:title" content="Guide">');
      expect(html).toContain('<meta property="og:url" content="https://docs.example.org/">');
      expect(html).toContain(
        `<meta property="og:image" content="https://docs.example.org/.files/${hash}/cover.png">`,
      );
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).not.toContain('name="robots"');
    }
    const setup = (await visit(test, "/Setup", "docs.example.org")).body;
    expect(setup).toContain('<meta name="description" content="How to set it up.">');
    expect(setup).toContain('<meta property="og:type" content="article">');
    expect(setup).toContain('<meta property="og:title" content="Setup">');
    expect(setup).toContain('<link rel="canonical" href="https://docs.example.org/Setup">');
    expect(setup).toContain('<meta property="og:image" content="https://example.org/card.png">');
    const cut = /<meta name="description" content="([^"]*)">/.exec(
      (await visit(test, "/Long", "docs.example.org")).body,
    )?.[1];
    expect(cut?.length).toBeLessThanOrEqual(160);
    expect(cut?.endsWith("word…")).toBe(true);
    const bare = (await visit(test, "/Bare", "docs.example.org")).body;
    expect(bare).not.toContain('name="description"');
    expect(bare).toContain('<meta name="twitter:card" content="summary">');
  });

  it("lists the pages in the sitemap, with robots.txt on the domain, leaving out those with noindex", async () => {
    const test = await start();
    const ids = await store(test, {
      "Docs/Start.md": "Start\n",
      "Docs/Más/Next.md": "Next\n",
      "Docs/Draft.md": "---\nnoindex: true\n---\nDraft\n",
    });
    const site = await publish(test, { folder: "Docs", name: "docs" });
    expect(ids["Docs/Start.md"]).toBeDefined();

    const path = await visit(test, "/p/docs/sitemap.xml");
    expect(path.headers["content-type"]).toBe("application/xml; charset=utf-8");
    expect(path.body).toContain("<loc>http://localhost:80/p/docs/</loc>");
    expect(path.body).toMatch(/<loc>http:\/\/localhost:80\/p\/docs\/Start<\/loc><lastmod>20\d\d-/);
    expect(path.body).toContain(
      `<loc>http://localhost:80/p/docs/${encodeURIComponent("Más")}/Next</loc>`,
    );
    expect(path.body).not.toContain("Draft");
    // robots.txt is a host's, read at its root alone.
    expect((await visit(test, "/p/docs/robots.txt")).statusCode).toBe(404);

    const draft = await visit(test, "/p/docs/Draft");
    expect(draft.statusCode).toBe(200);
    expect(draft.headers["x-robots-tag"]).toBe("noindex");
    expect(draft.body).toContain('<meta name="robots" content="noindex">');
    expect((await visit(test, "/p/docs/Start")).headers["x-robots-tag"]).toBeUndefined();

    await hold(test, site.id, "docs.example.org");
    const robots = await visit(test, "/robots.txt", "docs.example.org");
    expect(robots.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(robots.body).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://docs.example.org/sitemap.xml\n",
    );
    expect((await visit(test, "/sitemap.xml", "docs.example.org")).body).toContain(
      "<loc>https://docs.example.org/Start</loc>",
    );
  });

  it("asks search engines to index nothing of a site its publisher keeps out", async () => {
    const test = await start();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 3]);
    const hash = await upload(test, png, "image/png");
    const ids = await store(test, { "Home.md": "Home\n\n![[logo.png]]\n" }, { "logo.png": hash });
    const site = await publish(test, { note: ids["Home.md"], name: "home" });
    const changed = await call(test, "PATCH", `/sites/${site.id}`, test.token, { indexed: false });
    expect(changed.json<Shown>().indexed).toBe(false);
    await hold(test, site.id, "home.example.org");

    const page = await visit(test, "/", "home.example.org");
    expect(page.headers["x-robots-tag"]).toBe("noindex");
    expect(page.body).toContain('<meta name="robots" content="noindex">');
    expect(
      (await visit(test, `/.files/${hash}/logo.png`, "home.example.org")).headers["x-robots-tag"],
    ).toBe("noindex");
    expect((await visit(test, "/robots.txt", "home.example.org")).body).toBe(
      "User-agent: *\nDisallow: /\n",
    );
    const map = await visit(test, "/sitemap.xml", "home.example.org");
    expect(map.headers["x-robots-tag"]).toBe("noindex");
    expect(map.body).not.toContain("<url>");
  });
});
