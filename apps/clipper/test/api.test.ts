// The clipper's calls to the person's server (ADR 0066), against a fetch
// that answers as the server's REST API does: who the token is, the
// workspaces and databases it reaches, finding a note, and saving a clip
// as a new note, added to a note, read again on 412, or a database row.
import { describe, expect, it } from "vitest";
import {
  Refused,
  account,
  addRow,
  appendTries,
  changeNote,
  databases,
  findNotes,
  makeNote,
  originPattern,
  serverAddress,
  workspaces,
} from "../src/api.ts";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

type Answer = readonly [number, unknown?, Record<string, string>?];

/** A fetch answering each request by `answer`, keeping what was sent. */
function fakeFetch(answer: (sent: Sent) => Answer) {
  const sent: Sent[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Sent = {
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    sent.push(request);
    const [status, body, headers = {}] = answer(request);
    const text = typeof body === "string" ? body : body === undefined ? null : JSON.stringify(body);
    return Promise.resolve(new Response(status === 204 ? null : text, { status, headers }));
  }) as typeof fetch;
  return {
    sent,
    connection: { server: "https://nether.example.org", token: "nether_abc", fetch: fetcher },
  };
}

const workspace = "8d0f5c3e-2b7a-4c1e-9f6d-0a1b2c3d4e5f";
const note = "3b9a7e21-6c4d-4f0a-8b2e-5d6c7e8f9a0b";

describe("addresses", () => {
  it("read a server's address as typed, https:// unless given", () => {
    expect(serverAddress(" nether.example.org ")).toBe("https://nether.example.org");
    expect(serverAddress("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(serverAddress("ftp://nether.example.org")).toBeUndefined();
    expect(serverAddress("https://user:pass@nether.example.org")).toBeUndefined();
    expect(serverAddress("")).toBeUndefined();
    expect(originPattern("https://nether.example.org")).toBe("https://nether.example.org/*");
  });
});

describe("the clipper's calls", () => {
  it("send the token, and read who it is and the workspaces it reaches", async () => {
    const { sent, connection } = fakeFetch((request) =>
      request.url.endsWith("/me")
        ? [
            200,
            {
              user: { name: "Ada", email: "ada@example.org" },
              token: { access: "write", workspace: { id: workspace, name: "Team" } },
            },
          ]
        : [
            200,
            {
              workspaces: [
                { id: workspace, name: "Team", encryption: "none" },
                { id: "w2", name: "Secret", encryption: "end-to-end" },
              ],
            },
          ],
    );
    expect(await account(connection)).toEqual({
      name: "Ada",
      email: "ada@example.org",
      access: "write",
      workspace,
    });
    expect(await workspaces(connection)).toEqual([
      { id: workspace, name: "Team", encrypted: false },
      { id: "w2", name: "Secret", encrypted: true },
    ]);
    expect(sent.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://nether.example.org/api/v1/me"],
      ["GET", "https://nether.example.org/api/v1/workspaces"],
    ]);
    expect(sent[0]?.headers.authorization).toBe("Bearer nether_abc");
  });

  it("tell a session apart from a read token", async () => {
    const session = fakeFetch(() => [200, { user: { name: "Ada", email: "a" }, token: null }]);
    expect(await account(session.connection)).toMatchObject({ access: "write", workspace: null });
    const reader = fakeFetch(() => [
      200,
      { user: { name: "Ada", email: "a" }, token: { access: "read", workspace: null } },
    ]);
    expect(await account(reader.connection)).toMatchObject({ access: "read" });
  });

  it("list databases and find notes in a workspace", async () => {
    const { sent, connection } = fakeFetch((request) =>
      request.url.includes("/databases")
        ? [200, { databases: [{ id: "d1", path: "Projects.md", title: "Projects", schema: {} }] }]
        : [200, { results: [{ note, title: "Reading", path: "Reading.md", snippet: "" }] }],
    );
    expect(await databases(connection, workspace)).toEqual([
      { id: "d1", path: "Projects.md", title: "Projects" },
    ]);
    expect(await findNotes(connection, workspace, "reading list")).toEqual([
      { id: note, path: "Reading.md", title: "Reading" },
    ]);
    expect(sent[0]?.url).toBe(
      `https://nether.example.org/api/v1/workspaces/${workspace}/databases?limit=1000`,
    );
    const search = new URL(sent[1]?.url ?? "");
    expect(search.pathname).toBe("/api/v1/search");
    expect(Object.fromEntries(search.searchParams)).toEqual({
      q: "reading list",
      workspace,
      limit: "20",
    });
  });

  it("make a note, and a database row, from their Markdown", async () => {
    const { sent, connection } = fakeFetch(() => [
      201,
      { id: note, path: "Clips/Tides.md", title: "Tides" },
    ]);
    expect(await makeNote(connection, workspace, "Clips/Tides.md", "Text\n")).toEqual({
      id: note,
      path: "Clips/Tides.md",
      title: "Tides",
    });
    await addRow(connection, workspace, "d1", {
      title: "Tides",
      properties: { source: "https://sea.example" },
      markdown: "Text\n",
    });
    expect(sent.map((request) => [request.method, request.url, request.body])).toEqual([
      [
        "POST",
        `https://nether.example.org/api/v1/workspaces/${workspace}/notes`,
        JSON.stringify({ path: "Clips/Tides.md", markdown: "Text\n" }),
      ],
      [
        "POST",
        `https://nether.example.org/api/v1/workspaces/${workspace}/databases/d1/rows`,
        JSON.stringify({
          title: "Tides",
          properties: { source: "https://sea.example" },
          markdown: "Text\n",
        }),
      ],
    ]);
    expect(sent[0]?.headers["content-type"]).toBe("application/json");
  });

  it("add to a note only as it was read, reading it again when someone changed it", async () => {
    let version = 1;
    let refusals = 1;
    const { sent, connection } = fakeFetch((request) => {
      if (request.method === "GET") {
        return [200, `Version ${String(version)}\n`, { etag: `"v${String(version)}"` }];
      }
      if (refusals > 0) {
        refusals -= 1;
        version += 1;
        return [412, { message: "The note changed since it was read." }];
      }
      return [200, { id: note, path: "Reading.md", title: "Reading" }];
    });
    const saved = await changeNote(connection, workspace, note, (text) => `${text}Added\n`);
    expect(saved).toEqual({ id: note, path: "Reading.md", title: "Reading" });
    const writes = sent.filter((request) => request.method === "PUT");
    expect(writes.map((request) => [request.headers["if-match"], request.body])).toEqual([
      ['"v1"', "Version 1\nAdded\n"],
      ['"v2"', "Version 2\nAdded\n"],
    ]);
    expect(writes[0]?.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(sent.find((request) => request.method === "GET")?.headers.accept).toBe("text/markdown");
  });

  it(`give up adding to a note after ${String(appendTries)} tries`, async () => {
    const { sent, connection } = fakeFetch((request) =>
      request.method === "GET" ? [200, "Text\n", { etag: '"v"' }] : [412, {}],
    );
    await expect(changeNote(connection, workspace, note, (text) => text)).rejects.toThrow(
      new Refused(412, "The note kept changing while the clip was added: try again."),
    );
    expect(sent.filter((request) => request.method === "PUT")).toHaveLength(appendTries);
  });

  it("call fetch as itself, as a browser's fetch asks", async () => {
    const { connection } = fakeFetch(() => [200, { workspaces: [] }]);
    const strict = function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined) return Promise.reject(new TypeError("Illegal invocation"));
      return connection.fetch(...args);
    } as typeof fetch;
    expect(await workspaces({ ...connection, fetch: strict })).toEqual([]);
  });

  it("say what the server refused, or that it could not be reached", async () => {
    const refusing = fakeFetch(() => [403, { message: "This token only reads." }]);
    await expect(makeNote(refusing.connection, workspace, "A.md", "")).rejects.toMatchObject({
      status: 403,
      message: "This token only reads.",
    });
    const odd = fakeFetch(() => [502, "Bad gateway"]);
    await expect(account(odd.connection)).rejects.toThrow("nether.example.org answered 502.");
    const away = {
      server: "https://nether.example.org",
      token: "t",
      fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch,
    };
    await expect(account(away)).rejects.toMatchObject({ status: 0 });
  });
});
