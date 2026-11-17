import { describe, expect, it } from "vitest";
import {
  type KeptConnection,
  RequestRefused,
  answerLimit,
  checkConnection,
  credentialOf,
  feedConnection,
  isCalendar,
  isOrigin,
  mayFollow,
  readAddress,
  readKeptConnections,
  readPluginRequest,
  readSecret,
  requestUrl,
  sendRequest,
  shownConnection,
  writeSecret,
} from "../src/index.ts";

/** A feed as Google Calendar's secret address has it, its secret in the path. */
const feedUrl = "https://calendar.example.org/ical/ada%40example.org/private-abc123/basic.ics";

function feed(user?: string): ReturnType<typeof feedConnection> {
  const url = readAddress(feedUrl, false).url;
  if (url === undefined) throw new Error("No address.");
  return feedConnection({
    id: "c1",
    name: " Work ",
    url,
    ...(user === undefined ? {} : { user, password: "pa:ss" }),
  });
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly redirect: string | undefined;
}

/** A fetch that answers from a list, and records each request. */
function fakeFetch(answers: (() => Response)[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    sent.push({
      url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error(`no answer for ${feedUrl}`));
    return Promise.resolve(answer());
  };
  return { fetch, sent };
}

const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function request(over: Record<string, unknown> = {}) {
  return readPluginRequest({
    connection: "c1",
    url: "",
    method: "GET",
    headers: {},
    as: "text",
    ...over,
  });
}

describe("readAddress", () => {
  it("reads webcal as https, keeps the path and query, and drops a fragment", () => {
    expect(readAddress(" webcal://cal.example.org/a.ics?k=1#x ", false).url?.href).toBe(
      "https://cal.example.org/a.ics?k=1",
    );
    expect(readAddress("WEBCALS://cal.example.org/a.ics", false).url?.protocol).toBe("https:");
  });

  it("allows http only where the device says, and refuses what is no address", () => {
    expect(readAddress("http://nas.local/cal.ics", true).url?.href).toBe(
      "http://nas.local/cal.ics",
    );
    expect(readAddress("http://nas.local/cal.ics", false).problem).toBe("scheme");
    expect(readAddress("ftp://example.org/a.ics", true).problem).toBe("scheme");
    expect(readAddress("   ", true).problem).toBe("empty");
    expect(readAddress("calendar ics", true).problem).toBe("host");
    expect(readAddress("https://ada:secret@example.org/a.ics", true).problem).toBe("credentials");
    expect(readAddress("file:///etc/passwd", true).problem).toBe("scheme");
  });

  it("knows an origin when it reads one", () => {
    expect(isOrigin("https://example.org")).toBe(true);
    expect(isOrigin("https://example.org/")).toBe(false);
    expect(isOrigin("ftp://example.org")).toBe(false);
    expect(isOrigin("nothing")).toBe(false);
  });
});

describe("connections", () => {
  it("shows a feed by its host, and keeps its whole address as its secret", () => {
    const { connection, secret } = feed();
    expect(connection).toEqual({
      id: "c1",
      service: "ics",
      name: "Work",
      account: "",
      address: "calendar.example.org",
      web: "",
      origins: ["https://calendar.example.org"],
    });
    expect(secret).toEqual({ address: feedUrl });
    expect(shownConnection(connection, "device")).toEqual({
      id: "c1",
      service: "ics",
      name: "Work",
      address: "calendar.example.org",
      where: "device",
    });
    expect(
      shownConnection({ ...connection, account: "ada", web: "example.org" }, "server"),
    ).toMatchObject({ account: "ada", web: "example.org", where: "server" });
  });

  it("names a feed by its host when the person gives no name", () => {
    const url = new URL(feedUrl);
    expect(feedConnection({ id: "c2", name: "", url }).connection.name).toBe(
      "calendar.example.org",
    );
  });

  it("reads secrets and kept connections, leaving out what does not read", () => {
    const { connection } = feed();
    expect(readSecret(writeSecret({ address: feedUrl, user: "ada", password: "p" }))).toEqual({
      address: feedUrl,
      user: "ada",
      password: "p",
    });
    expect(readSecret(writeSecret({ token: "t" }))).toEqual({ token: "t" });
    for (const odd of [undefined, "", "{", "[1]", "null", '{"user":3}']) {
      expect(readSecret(odd)).toEqual({});
    }
    expect(
      readKeptConnections([
        connection,
        { ...connection, id: "c2", account: 3, web: undefined, origins: ["https://a.org", 4] },
        { ...connection, service: "dropbox" },
        { ...connection, origins: "https://a.org" },
        null,
      ]),
    ).toEqual([connection, { ...connection, id: "c2", origins: ["https://a.org"] }]);
    expect(readKeptConnections("none")).toEqual([]);
  });
});

describe("readPluginRequest", () => {
  it("reads a request, its headers lowercased", () => {
    expect(
      request({ method: "REPORT", headers: { Depth: "1" }, body: "<x/>", as: "bytes" }),
    ).toEqual({
      connection: "c1",
      url: "",
      method: "REPORT",
      headers: { depth: "1" },
      body: "<x/>",
      as: "bytes",
    });
  });

  it("refuses the app's own headers, odd methods, and bodies over the limit", () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ headers: { Authorization: "Bearer x" } }, "Only the app sets the header Authorization."],
      [{ headers: { cookie: "a=1" } }, "Only the app sets the header cookie."],
      [{ headers: { Host: "evil.example" } }, "Only the app sets the header Host."],
      [
        { headers: { "Proxy-Authorization": "x" } },
        "Only the app sets the header Proxy-Authorization.",
      ],
      [{ headers: { depth: 1 } }, "The header depth is not text."],
      [{ headers: [] }, "A request's headers are an object."],
      [{ method: "CONNECT" }, "A request's method is one of"],
      [{ connection: "" }, "A request names its connection."],
      [{ url: 3 }, "A request's url is text."],
      [{ body: 4 }, "A request's body is text."],
      [{ body: "x".repeat(1024 * 1024 + 1) }, "A request's body is 1 MB at most."],
      [{ as: "json" }, "An answer is text or bytes."],
    ];
    for (const [over, message] of refusals) {
      expect(() => request(over)).toThrow(message);
    }
    expect(() => readPluginRequest(null)).toThrow("A request is an object.");
    expect(() => readPluginRequest(undefined)).toThrow(RequestRefused);
  });
});

describe("requestUrl", () => {
  it("resolves against the secret address, a path under it, a full address at an origin", () => {
    const { connection, secret } = feed();
    expect(requestUrl(connection, secret, "").href).toBe(feedUrl);
    expect(requestUrl(connection, secret, "other.ics").href).toBe(
      "https://calendar.example.org/ical/ada%40example.org/private-abc123/other.ics",
    );
    expect(requestUrl(connection, secret, "/dav/").href).toBe("https://calendar.example.org/dav/");
    expect(requestUrl(connection, secret, "https://calendar.example.org/x#y").href).toBe(
      "https://calendar.example.org/x",
    );
  });

  it("refuses another origin, without naming the secret address", () => {
    const { connection, secret } = feed();
    expect(() => requestUrl(connection, secret, "https://elsewhere.example/")).toThrow(
      "The connection does not reach https://elsewhere.example.",
    );
    expect(() => requestUrl(connection, secret, "//elsewhere.example/a")).toThrow(
      "The connection's address does not read as one it reaches.",
    );
    expect(() => requestUrl({ ...connection }, {}, "")).toThrow(
      "The request's address does not read as one.",
    );
  });

  it("follows a feed's redirects anywhere it may, another service's only to its origins", () => {
    const { connection } = feed();
    const elsewhere = new URL("https://cdn.example.net/a.ics");
    expect(mayFollow(connection, elsewhere, false)).toBe(true);
    expect(mayFollow(connection, new URL("http://cdn.example.net/a.ics"), false)).toBe(false);
    expect(mayFollow(connection, new URL("http://cdn.example.net/a.ics"), true)).toBe(true);
    const other: KeptConnection = { ...connection, service: "caldav" };
    expect(mayFollow(other, elsewhere, true)).toBe(false);
    expect(mayFollow(other, new URL("https://calendar.example.org/dav/"), false)).toBe(true);
  });

  it("gives Bearer for a token and Basic for a user, in UTF-8", () => {
    expect(credentialOf({ token: "abc" })).toBe("Bearer abc");
    expect(credentialOf({ user: "ada", password: "pa:ss" })).toBe(`Basic ${btoa("ada:pa:ss")}`);
    expect(credentialOf({ user: "zo\u00EB" })).toBe(`Basic ${btoa("zo\u00C3\u00AB:")}`);
    expect(credentialOf({})).toBeUndefined();
  });
});

describe("sendRequest", () => {
  it("sends to the feed with the credential, manual redirects, and keeps only the headers a plugin needs", async () => {
    const { connection, secret } = feed("ada");
    const { fetch, sent } = fakeFetch([
      () =>
        new Response(ics, {
          status: 200,
          headers: {
            "content-type": "text/calendar; charset=utf-8",
            etag: '"7"',
            "set-cookie": "s=1",
            "x-ratelimit-remaining": "9",
            server: "cal",
          },
        }),
    ]);
    const answer = await sendRequest({
      connection,
      secret,
      request: request({ headers: { "if-none-match": '"6"' } }),
      fetch,
      http: false,
    });
    expect(answer).toEqual({
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        etag: '"7"',
        "x-ratelimit-remaining": "9",
      },
      text: ics,
    });
    expect(sent).toEqual([
      {
        url: feedUrl,
        method: "GET",
        headers: { authorization: `Basic ${btoa("ada:pa:ss")}`, "if-none-match": '"6"' },
        body: undefined,
        redirect: "manual",
      },
    ]);
  });

  it("follows redirects, dropping the credential away from the connection's origin", async () => {
    const { connection, secret } = feed("ada");
    const { fetch, sent } = fakeFetch([
      () => new Response(null, { status: 301, headers: { location: "/moved.ics" } }),
      () => new Response(null, { status: 302, headers: { location: "https://cdn.example.net/a" } }),
      () => new Response(ics, { status: 200 }),
    ]);
    const answer = await sendRequest({
      connection,
      secret,
      request: request(),
      fetch,
      http: false,
    });
    expect(answer.text).toBe(ics);
    expect(sent.map((each) => [each.url, each.headers.authorization !== undefined])).toEqual([
      [feedUrl, true],
      ["https://calendar.example.org/moved.ics", true],
      ["https://cdn.example.net/a", false],
    ]);
  });

  it("turns a POST sent on by a 303 or 302 into a GET, and keeps it through a 307", async () => {
    const { connection, secret } = feed();
    const { fetch, sent } = fakeFetch([
      () => new Response(null, { status: 307, headers: { location: "/b" } }),
      () => new Response(null, { status: 303, headers: { location: "/c" } }),
      () => new Response("done", { status: 200 }),
    ]);
    await sendRequest({
      connection,
      secret,
      request: request({ method: "POST", body: "x" }),
      fetch,
      http: false,
    });
    expect(sent.map((each) => `${each.method} ${String(each.body)}`)).toEqual([
      "POST x",
      "POST x",
      "GET undefined",
    ]);
  });

  it("refuses redirects it may not follow, too many, and ones to no address", async () => {
    const { connection, secret } = feed();
    const caldav: KeptConnection = { ...connection, service: "caldav" };
    const away = () =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    await expect(
      sendRequest({
        connection: caldav,
        secret,
        request: request(),
        fetch: fakeFetch([away]).fetch,
        http: false,
      }),
    ).rejects.toThrow(
      "https://calendar.example.org sent the request on to https://elsewhere.example, which the connection does not reach.",
    );
    const loop = () => new Response(null, { status: 302, headers: { location: "/again" } });
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch(Array.from({ length: 7 }, () => loop)).fetch,
        http: false,
      }),
    ).rejects.toThrow("The request was sent on too many times.");
    const plain = () =>
      new Response(null, { status: 302, headers: { location: "http://x.example/" } });
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch([plain]).fetch,
        http: false,
      }),
    ).rejects.toThrow("sent the request on to http://x.example");
    const nowhere = () => new Response(null, { status: 302, headers: { location: "http://[" } });
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch([nowhere]).fetch,
        http: false,
      }),
    ).rejects.toThrow("sent the request on to no address.");
  });

  it("gives bytes as Base64, a HEAD no body, and text in its charset", async () => {
    const { connection, secret } = feed();
    const bytes = await sendRequest({
      connection,
      secret,
      request: request({ as: "bytes" }),
      fetch: fakeFetch([() => new Response(new Uint8Array([0, 255]), { status: 200 })]).fetch,
      http: false,
    });
    expect(bytes.base64).toBe(btoa(String.fromCharCode(0, 255)));
    const head = await sendRequest({
      connection,
      secret,
      request: request({ method: "HEAD" }),
      fetch: fakeFetch([() => new Response(null, { status: 204 })]).fetch,
      http: false,
    });
    expect(head).toEqual({ status: 204, headers: {} });
    const latin = await sendRequest({
      connection,
      secret,
      request: request(),
      fetch: fakeFetch([
        () =>
          new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
            headers: { "content-type": "text/calendar; charset=iso-8859-1" },
          }),
      ]).fetch,
      http: false,
    });
    expect(latin.text).toBe("caf\u00E9");
    const unknown = await sendRequest({
      connection,
      secret,
      request: request(),
      fetch: fakeFetch([
        () => new Response("ok", { headers: { "content-type": "text/plain; charset=klingon" } }),
      ]).fetch,
      http: false,
    });
    expect(unknown.text).toBe("ok");
  });

  it("refuses answers over the limit, said or streamed", async () => {
    const { connection, secret } = feed();
    const said = () =>
      new Response("x", { headers: { "content-length": String(answerLimit + 1) } });
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch([said]).fetch,
        http: false,
      }),
    ).rejects.toThrow("The answer is larger than 20 MB.");
    const chunk = new Uint8Array(1024 * 1024);
    const streamed = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
      );
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch([streamed]).fetch,
        http: false,
      }),
    ).rejects.toThrow("The answer is larger than 20 MB.");
  });

  it("names the origin alone when a request fails, never the secret address", async () => {
    const { connection, secret } = feed();
    const failing = fakeFetch([]);
    const error = await sendRequest({
      connection,
      secret,
      request: request(),
      fetch: failing.fetch,
      http: false,
    }).catch((reason: unknown) => reason as Error);
    expect(error).toBeInstanceOf(RequestRefused);
    expect((error as Error).message).toBe("https://calendar.example.org could not be reached.");
    // What a browser's fetch gives for a redirect it was told not to follow.
    const fake = (): Response => {
      const response = new Response(null);
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    };
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: fakeFetch([fake]).fetch,
        http: false,
      }),
    ).rejects.toThrow("sent the request on, which this app cannot follow.");
  });

  it("says when the request was stopped, and refuses a scheme the device does not allow", async () => {
    const { connection, secret } = feed();
    const stop = new AbortController();
    stop.abort();
    const refusing: typeof fetch = (_input, init) =>
      init?.signal?.aborted === true
        ? Promise.reject(new DOMException("stopped", "AbortError"))
        : Promise.resolve(new Response(ics));
    await expect(
      sendRequest({
        connection,
        secret,
        request: request(),
        fetch: refusing,
        http: false,
        signal: stop.signal,
      }),
    ).rejects.toThrow("The request was stopped.");
    const plain = { ...connection, origins: ["http://nas.local"] };
    await expect(
      sendRequest({
        connection: plain,
        secret: { address: "http://nas.local/a.ics" },
        request: request(),
        fetch: refusing,
        http: false,
      }),
    ).rejects.toThrow("The app reaches no http: address.");
  });
});

describe("checkConnection", () => {
  it("passes a calendar, and says why another answer does not", async () => {
    const { connection, secret } = feed();
    const check = (answer: () => Response) =>
      checkConnection(connection, secret, fakeFetch([answer]).fetch, false);
    expect(await check(() => new Response(`\uFEFF\r\n${ics}`))).toBeUndefined();
    expect(await check(() => new Response("<html>", { status: 200 }))).toEqual({
      problem: "notCalendar",
    });
    expect(await check(() => new Response("gone", { status: 404 }))).toEqual({
      problem: "status",
      status: 404,
    });
    expect(await checkConnection(connection, secret, fakeFetch([]).fetch, false)).toEqual({
      problem: "unreachable",
      message: "https://calendar.example.org could not be reached.",
    });
    const throwing: typeof fetch = () => {
      throw new TypeError("odd");
    };
    expect(
      await checkConnection({ ...connection, origins: [] }, secret, throwing, false),
    ).toMatchObject({ problem: "unreachable" });
    expect(isCalendar("BEGIN:VEVENT")).toBe(false);
  });
});
