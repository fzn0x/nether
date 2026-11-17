// Published sites from the Share dialog (ADR 0076): the requests it sends,
// the sites a page is on, and the name a site takes from a title.
import { describe, expect, it } from "vitest";
import {
  type PublishedSite,
  folderOf,
  listSites,
  publishSite,
  showsNote,
  siteNameFor,
  switchPublishing,
  unpublishSite,
} from "../src/sites.ts";

const base = "https://nether.example.org";
const workspace = "0b6f3f4e-7c43-4a4e-9a51-2f4b8c1d9e00";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** A fetch that answers each request with what `answer` gives, and keeps what it was sent. */
function fakeFetch(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request: Sent = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    sent.push(request);
    return Promise.resolve(answer(request));
  };
  return { fetcher, sent };
}

const site = {
  id: "site-1",
  name: "handbook",
  title: "Handbook",
  note: "note-1",
  folder: null,
  url: `${base}/p/handbook/`,
  publishedBy: { id: "user-1", name: "Ada" },
  createdAt: "2026-11-17T10:00:00.000Z",
};

describe("the site requests", () => {
  it("list a workspace's sites and its switch", async () => {
    const { fetcher, sent } = fakeFetch(() =>
      Response.json({ publishing: true, manages: false, sites: [site] }),
    );
    expect(await listSites(fetcher, base, "t0k", workspace)).toEqual({
      publishing: true,
      manages: false,
      sites: [
        {
          id: "site-1",
          name: "handbook",
          title: "Handbook",
          note: "note-1",
          folder: null,
          url: `${base}/p/handbook/`,
          publishedBy: "Ada",
        },
      ],
    });
    expect(sent[0]).toMatchObject({
      url: `${base}/api/workspaces/${workspace}/sites`,
      method: "GET",
    });
  });

  it("publish, unpublish and switch publishing", async () => {
    const { fetcher, sent } = fakeFetch((request) =>
      request.method === "POST"
        ? Response.json(site, { status: 201 })
        : new Response(null, { status: request.method === "DELETE" ? 204 : 200 }),
    );
    const made = await publishSite(fetcher, base, "t0k", workspace, {
      name: "handbook",
      note: "note-1",
    });
    expect(made.url).toBe(`${base}/p/handbook/`);
    await unpublishSite(fetcher, base, "t0k", workspace, "site-1");
    await switchPublishing(fetcher, base, "t0k", workspace, false);
    expect(sent.map(({ method, url, body }) => [method, url.slice(base.length), body])).toEqual([
      ["POST", `/api/workspaces/${workspace}/sites`, { name: "handbook", note: "note-1" }],
      ["DELETE", `/api/workspaces/${workspace}/sites/site-1`, undefined],
      ["PUT", `/api/workspaces/${workspace}/publishing`, { enabled: false }],
    ]);
  });

  it("give the server's reason when it refuses", async () => {
    const { fetcher } = fakeFetch(() =>
      Response.json({ message: "A site has that name already." }, { status: 409 }),
    );
    await expect(
      publishSite(fetcher, base, "t0k", workspace, { name: "taken", folder: "Docs" }),
    ).rejects.toThrow("A site has that name already.");
  });
});

describe("the sites a page is on", () => {
  const page = { id: "note-1", path: "Docs/Guide/Setup.md" };
  const of = (fields: Partial<PublishedSite>): PublishedSite => ({
    id: "s",
    name: "s",
    title: "S",
    note: null,
    folder: null,
    url: "",
    publishedBy: "",
    ...fields,
  });

  it("are its own, and those of the folders it is in", () => {
    expect(showsNote(of({ note: "note-1" }), page)).toBe(true);
    expect(showsNote(of({ note: "note-2" }), page)).toBe(false);
    expect(showsNote(of({ folder: "Docs" }), page)).toBe(true);
    expect(showsNote(of({ folder: "Docs/Guide" }), page)).toBe(true);
    expect(showsNote(of({ folder: "Doc" }), page)).toBe(false);
    expect(folderOf(page.path)).toBe("Docs/Guide");
    expect(folderOf("Top.md")).toBe("");
  });
});

describe("siteNameFor", () => {
  it("makes a name the server takes from a title", () => {
    expect(siteNameFor("Team Handbook")).toBe("team-handbook");
    expect(siteNameFor("  Café & Crème!  ")).toBe("cafe-creme");
    expect(siteNameFor("Q4")).toBe("q4-site");
    expect(siteNameFor("日本語")).toBe("site");
    const long = siteNameFor("a".repeat(62) + " b");
    expect(long).toBe("a".repeat(62));
    expect(siteNameFor("x".repeat(80))).toHaveLength(63);
  });
});
