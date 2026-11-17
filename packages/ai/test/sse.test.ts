// The event stream reader: fields, comments and line ends as the HTML
// standard has them, at every chunk boundary.
import { describe, expect, it } from "vitest";
import { type ServerSentEvent, serverSentEvents } from "../src/sse.ts";
import { fakeFetch } from "./fake.ts";

async function events(text: string, chunk?: number): Promise<ServerSentEvent[]> {
  const fake = fakeFetch({ body: text, ...(chunk === undefined ? {} : { chunk }) });
  const response = await fake.fetch("https://example.org/stream");
  if (response.body === null) throw new Error("No body");
  const found: ServerSentEvent[] = [];
  for await (const event of serverSentEvents(response.body)) found.push(event);
  return found;
}

const stream = [
  ": a comment, to keep the connection open",
  "event: first",
  "data: one",
  "data:two, without a space",
  "id: 7",
  "retry: 1000",
  "",
  'data: {"text": "é ✓ 🙂"}',
  "",
  "event: empty",
  "",
  "data",
  "",
  "",
].join("\r\n");

const expected: ServerSentEvent[] = [
  { event: "first", data: "one\ntwo, without a space" },
  { event: "message", data: '{"text": "é ✓ 🙂"}' },
  { event: "message", data: "" },
];

describe("server-sent events", () => {
  it("reads fields, joins data lines, and skips comments and events without data", async () => {
    expect(await events(stream)).toEqual(expected);
  });

  it("reads the same events however the stream is cut", async () => {
    for (let size = 1; size <= 12; size++) {
      expect(await events(stream, size)).toEqual(expected);
    }
  });

  it("takes LF, CRLF and CR alike", async () => {
    for (const end of ["\n", "\r\n", "\r"]) {
      const text = ["data: a", "", "event: b", "data: c", "", ""].join(end);
      for (const size of [1, 2, 3, 100]) {
        expect(await events(text, size)).toEqual([
          { event: "message", data: "a" },
          { event: "b", data: "c" },
        ]);
      }
    }
  });

  it("ends the last event when the stream ends without its blank line", async () => {
    expect(await events("data: a\n\ndata: last")).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "last" },
    ]);
    expect(await events("data: a\n")).toEqual([{ event: "message", data: "a" }]);
  });

  it("cancels the stream when the reader stops early", async () => {
    const fake = fakeFetch({ body: "data: 1\n\ndata: 2\n\ndata: 3\n\n", chunk: 9 });
    const response = await fake.fetch("https://example.org/stream");
    if (response.body === null) throw new Error("No body");
    for await (const event of serverSentEvents(response.body)) {
      expect(event.data).toBe("1");
      break;
    }
    expect(fake.cancelled()).toBe(true);
  });
});
