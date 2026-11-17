// Data policies (ADR 0088), as the server enforces them while the `policies`
// feature is on: share links that only view or open nothing, published
// sites not served, and the public API keeping a workspace's text; each
// workspace's policy its own where an instance admin set it apart, and what
// its members' apps keep to in /api/me. A stub module stands in for
// enterprise/policies, whose own tests cover the console's routes.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { setDocumentBlocks, setDocumentProperties } from "@nether/editor/document";
import { parseMarkdown } from "@nether/markdown";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type DataPolicies,
  type DataPolicy,
  exportOff,
  linksOff,
  linksViewOnly,
  openPolicy,
  sitesOff,
} from "../src/dataPolicies.ts";
import type { EnterpriseModule } from "../src/enterprise.ts";
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

type Test = TestServer & SetUp & { readonly policies: DataPolicies };

/** A server with a web app, which opens links, and the `policies` feature on unless told. */
async function start(on = true): Promise<Test> {
  const root = await mkdtemp(join(tmpdir(), "nether-policies-"));
  folders.push(root);
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Nether</title>");
  let policies: DataPolicies | undefined;
  const stub: EnterpriseModule = {
    feature: "policies",
    plugin: (_app, services) => {
      policies = services.dataPolicies;
      return Promise.resolve();
    },
  };
  running = await startServer({
    env: { NETHER_WEB_APP: web, NETHER_ENTERPRISE_POLICIES: on ? "on" : "off" },
    enterpriseModules: [stub],
  });
  const set = await setUp(running);
  if (policies === undefined) throw new Error("The module was not registered.");
  return { ...running, ...set, policies };
}

function call(test: Test, method: string, path: string, token: string, payload?: object) {
  return test.server.inject({
    method: method as "GET",
    url: path.startsWith("/api/") ? path : `/api/workspaces/${test.workspaceId}${path}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

function message(answer: { readonly body: string }): string {
  return (JSON.parse(answer.body) as { message: string }).message;
}

const policy = (narrowed: Partial<DataPolicy>): DataPolicy => ({ ...openPolicy, ...narrowed });

/** A note's document as the editor keeps it, made from Markdown. */
function noteState(markdown: string): Uint8Array {
  const document = new Y.Doc();
  const parsed = parseMarkdown(markdown);
  setDocumentBlocks(document, parsed.content);
  setDocumentProperties(document, parsed.properties);
  return Y.encodeStateAsUpdate(document);
}

/** Stores notes by path, and a vault document listing them. */
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
  const listing = new Y.Doc();
  const listed = listing.getMap<string>("notes");
  for (const [path, id] of Object.entries(ids)) listed.set(id, path);
  await storeDocument(test.db, test.workspaceId, vault, Y.encodeStateAsUpdate(listing));
  return ids;
}

/** Shares a page on its own, with its note listed in it, and gives its unit and note. */
async function sharePage(test: Test): Promise<{ unit: string; page: string }> {
  const page = randomUUID();
  const made = await call(test, "POST", "/pages", test.token, { note: page });
  expect(made.statusCode).toBe(201);
  const unit = made.json<{ id: string }>().id;
  const listing = new Y.Doc();
  listing.getMap<string>("notes").set(page, "Plan.md");
  await storeDocument(test.db, test.workspaceId, `vault.${unit}`, Y.encodeStateAsUpdate(listing));
  const text = new Y.Doc();
  text.getText("text").insert(0, "The plan.");
  await storeDocument(test.db, test.workspaceId, page, Y.encodeStateAsUpdate(text));
  return { unit, page };
}

function makeLink(test: Test, unit: string, level: string) {
  return call(test, "POST", `/units/${unit}/links`, test.token, { level });
}

/** The token a link's address carries after its `#`. */
function tokenOf(url: string): string {
  return url.slice(url.indexOf("#") + 1);
}

/** Opens a link as anyone would, and gives the answer and the visit's token from its cookie. */
async function open(test: Test, token: string) {
  const answer = await test.server.inject({
    method: "POST",
    url: "/api/links/open",
    payload: { token },
  });
  const set = String(answer.headers["set-cookie"] ?? "");
  return { answer, visit: decodeURIComponent(/nether_visit=([^;]+)/.exec(set)?.[1] ?? "") };
}

function visitAgain(test: Test, visit: string) {
  return test.server.inject({
    method: "GET",
    url: "/api/links/visit",
    headers: { cookie: `nether_visit=${encodeURIComponent(visit)}` },
  });
}

async function me(test: Test) {
  return (await call(test, "GET", "/api/me", test.token)).json<{
    workspaces: {
      id: string;
      policies: { export: boolean; trashDays: number | null; legalHold: boolean } | null;
    }[];
  }>().workspaces[0]?.policies;
}

describe("data policies", () => {
  it("narrow nothing while the policies feature is off", async () => {
    const test = await start(false);
    await test.policies.setEvery(policy({ shareLinks: "off", sites: false, export: false }));
    const { unit } = await sharePage(test);
    expect((await makeLink(test, unit, "edit")).statusCode).toBe(201);
    expect(await me(test)).toBeNull();
  });

  it("are told to the apps in /api/me, with each workspace", async () => {
    const test = await start();
    const told = (narrowed: object) => ({
      export: true,
      trashDays: null,
      legalHold: false,
      ...narrowed,
    });
    expect(await me(test)).toEqual(told({}));
    await test.policies.setEvery(policy({ export: false, trashDays: 14, legalHold: true }));
    expect(await me(test)).toEqual(told({ export: false, trashDays: 14, legalHold: true }));
    expect(await test.policies.anyHold()).toBe(true);
    // A workspace set apart has its own.
    await test.policies.setApart(test.workspaceId, openPolicy);
    expect(await me(test)).toEqual(told({}));
    await test.policies.removeApart(test.workspaceId);
    expect(await me(test)).toEqual(told({ export: false, trashDays: 14, legalHold: true }));
    await test.policies.setEvery(openPolicy);
    expect(await test.policies.anyHold()).toBe(false);
  });

  it("give the workspaces on legal hold through a transaction, set a moment before or kept", async () => {
    const test = await start();
    const other = randomUUID();
    await test.db.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Other')", [other]);
    const held = () =>
      test.db.transaction((tx) => test.policies.heldIn(tx, [test.workspaceId, other]));
    // What is kept says no hold; a hold written since is read all the same.
    expect(await test.policies.anyHold()).toBe(false);
    await test.db.query("INSERT INTO workspace_policies (workspace_id, policy) VALUES ($1, $2)", [
      other,
      JSON.stringify({ legalHold: true }),
    ]);
    expect([...(await held())]).toEqual([other]);
    await test.db.query("INSERT INTO instance_settings (key, value) VALUES ('policies.data', $1)", [
      JSON.stringify({ legalHold: true }),
    ]);
    expect([...(await held())].sort()).toEqual([test.workspaceId, other].sort());
    expect(await test.db.transaction((tx) => test.policies.heldIn(tx, []))).toEqual(new Set());

    // While the feature is off, nothing is held.
    await test.close();
    running = undefined;
    const off = await start(false);
    await off.db.query("INSERT INTO instance_settings (key, value) VALUES ('policies.data', $1)", [
      JSON.stringify({ legalHold: true }),
    ]);
    expect(await off.db.transaction((tx) => off.policies.heldIn(tx, [off.workspaceId]))).toEqual(
      new Set(),
    );
  });
});

describe("share links under a policy", () => {
  it("are neither made nor opened while the policy allows none", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    const made = await makeLink(test, unit, "view");
    const { visit } = await open(test, tokenOf(made.json<{ url: string }>().url));
    expect((await visitAgain(test, visit)).statusCode).toBe(200);

    await test.policies.setEvery(policy({ shareLinks: "off" }));
    const refused = await makeLink(test, unit, "view");
    expect(refused.statusCode).toBe(403);
    expect(message(refused)).toBe(linksOff);
    const opened = await open(test, tokenOf(made.json<{ url: string }>().url));
    expect(opened.answer.statusCode).toBe(403);
    expect(message(opened.answer)).toBe(linksOff);
    const again = await visitAgain(test, visit);
    expect(again.statusCode).toBe(403);
    expect(message(again)).toBe(linksOff);
    const listed = await call(test, "GET", `/units/${unit}/links`, test.token);
    // Kept, to open again when the policy allows them.
    expect(listed.json<{ links: unknown[]; policy: string }>()).toMatchObject({ policy: "off" });
    expect(listed.json<{ links: unknown[] }>().links).toHaveLength(1);

    // A workspace set apart keeps its own.
    await test.policies.setApart(test.workspaceId, openPolicy);
    expect((await makeLink(test, unit, "edit")).statusCode).toBe(201);
    expect((await visitAgain(test, visit)).statusCode).toBe(200);
  });

  it("only view while the policy says so, whatever level they were made at", async () => {
    const test = await start();
    const { unit } = await sharePage(test);
    const edit = await makeLink(test, unit, "edit");
    await test.policies.setEvery(policy({ shareLinks: "view" }));

    const refused = await makeLink(test, unit, "comment");
    expect(refused.statusCode).toBe(403);
    expect(message(refused)).toBe(linksViewOnly);
    expect((await makeLink(test, unit, "view")).statusCode).toBe(201);
    const { answer, visit } = await open(test, tokenOf(edit.json<{ url: string }>().url));
    expect(answer.json<{ level: string }>().level).toBe("view");
    expect((await visitAgain(test, visit)).json<{ level: string }>().level).toBe("view");
  });
});

describe("a visit's sync under a policy", () => {
  function connect(
    url: string,
    name: string,
    token: string,
    onClose?: () => void,
  ): Promise<HocuspocusProvider> {
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
        ...(onClose === undefined ? {} : { onClose }),
      });
      providers.push(provider);
    });
  }

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Still not ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("closes when the policy changes, and connects again only as it allows", async () => {
    const test = await start();
    await test.server.listen({ host: "127.0.0.1", port: await freePort() });
    const url = `ws://127.0.0.1:${String((test.server.server.address() as AddressInfo).port)}/api/sync`;
    const { unit, page } = await sharePage(test);
    const made = await makeLink(test, unit, "edit");
    const { visit } = await open(test, tokenOf(made.json<{ url: string }>().url));
    const owner = await connect(url, `${test.workspaceId}/${page}`, test.token);

    let closed = 0;
    const editing = await connect(url, `${test.workspaceId}/${page}`, visit, () => {
      closed += 1;
    });
    editing.document.getText("text").insert(9, " Edited.");
    await until(() => owner.document.getText("text").toJSON() === "The plan. Edited.", "edited");

    await test.policies.setEvery(policy({ shareLinks: "view" }));
    await until(() => closed > 0, "closed");
    // Connected again, it reads and writes nothing.
    const viewing = await connect(url, `${test.workspaceId}/${page}`, visit);
    viewing.document.getText("text").insert(0, "Changed. ");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(owner.document.getText("text").toJSON()).toBe("The plan. Edited.");

    await test.policies.setEvery(policy({ shareLinks: "off" }));
    await expect(connect(url, `${test.workspaceId}/${page}`, visit)).rejects.toThrow();
  });
});

describe("published sites under a policy", () => {
  it("are neither served nor published while the policy stops them", async () => {
    const test = await start();
    const ids = await store(test, { "Guide.md": "# Guide\n\nRead me." });
    const site = await call(test, "POST", "/sites", test.token, {
      note: ids["Guide.md"],
      name: "guide",
    });
    expect(site.statusCode, site.body).toBe(201);
    expect((await test.server.inject({ method: "GET", url: "/p/guide/" })).statusCode).toBe(200);

    await test.policies.setEvery(policy({ sites: false }));
    expect((await test.server.inject({ method: "GET", url: "/p/guide/" })).statusCode).toBe(404);
    const refused = await call(test, "POST", "/sites", test.token, {
      note: ids["Guide.md"],
      name: "guide-two",
    });
    expect(refused.statusCode).toBe(403);
    expect(message(refused)).toBe(sitesOff);
    const listed = await call(test, "GET", "/sites", test.token);
    expect(listed.json<{ policy: string; sites: unknown[] }>()).toMatchObject({ policy: "off" });
    expect(listed.json<{ sites: unknown[] }>().sites).toHaveLength(1);

    await test.policies.setEvery(openPolicy);
    expect((await test.server.inject({ method: "GET", url: "/p/guide/" })).statusCode).toBe(200);
  });
});

describe("the public API under a policy", () => {
  async function token(test: Test, access = "read"): Promise<string> {
    const made = await call(test, "POST", "/api/tokens", test.token, {
      name: "Script",
      access,
      password: admin.password,
    });
    expect(made.statusCode, made.body).toBe(201);
    return made.json<{ token: string }>().token;
  }

  it("gives no text of a workspace whose policy keeps it, and lists its notes", async () => {
    const test = await start();
    const ids = await store(test, {
      "Plan.md": "# Plan\n\nThe secret plan.",
      "Tasks.md": "---\ndatabase:\n  properties:\n    - key: status\n      type: select\n---\n",
      "Tasks/One.md": "---\nstatus: Doing\n---\nOne task.\n",
    });
    const reader = await token(test);
    const workspace = `/api/v1/workspaces/${test.workspaceId}`;
    const get = (url: string) =>
      test.server.inject({ method: "GET", url, headers: bearer(reader) });
    expect((await get(`${workspace}/notes/${String(ids["Plan.md"])}`)).statusCode).toBe(200);

    await test.policies.setEvery(policy({ export: false }));
    const note = await get(`${workspace}/notes/${String(ids["Plan.md"])}`);
    expect(note.statusCode).toBe(403);
    expect(message(note)).toBe(exportOff);
    expect((await get(`${workspace}/databases/${String(ids["Tasks.md"])}/rows`)).statusCode).toBe(
      403,
    );
    const listed = await get(`${workspace}/notes`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ notes: { path: string }[] }>().notes.map((each) => each.path)).toContain(
      "Plan.md",
    );
    const asked = await get(`/api/v1/search?q=secret&workspace=${test.workspaceId}`);
    expect(asked.statusCode).toBe(403);
    const everywhere = await get("/api/v1/search?q=secret");
    expect(everywhere.statusCode).toBe(200);
    expect(everywhere.json<{ results: unknown[] }>().results).toEqual([]);
  });

  it("answers a write with where its note is, not what it says, while the policy keeps text", async () => {
    const test = await start();
    await store(test, {});
    await test.policies.setEvery(policy({ export: false }));
    const writer = await token(test, "write");
    const made = await test.server.inject({
      method: "POST",
      url: `/api/v1/workspaces/${test.workspaceId}/notes`,
      headers: bearer(writer),
      payload: { path: "Inbox/Idea.md", markdown: "An idea." },
    });
    expect(made.statusCode, made.body).toBe(201);
    const body = made.json<Record<string, unknown>>();
    expect(body.path).toBe("Inbox/Idea.md");
    expect(body).not.toHaveProperty("markdown");
  });
});
