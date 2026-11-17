// Server-sent events, as both APIs stream their replies: a reader of the
// event stream format of the HTML standard, over a response's body as it
// arrives. Lines end in LF, CRLF or CR, a chunk may end anywhere, even
// inside a character or between a CR and its LF, and a blank line ends an
// event.

export interface ServerSentEvent {
  /** The event's type: its `event:` field, or `message` when it has none. */
  readonly event: string;
  /** Its `data:` lines, joined by newlines. */
  readonly data: string;
}

/** The events of a stream, in order, as they arrive; stopping early cancels the stream. */
export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let type = "";
  let data: string[] = [];
  let finished = false;

  /** Takes one line; gives the event a blank line ends, if one does. */
  const take = (line: string): ServerSentEvent | undefined => {
    if (line === "") {
      if (data.length === 0) {
        type = "";
        return undefined;
      }
      const event = { event: type === "" ? "message" : type, data: data.join("\n") };
      type = "";
      data = [];
      return event;
    }
    // A comment, as servers send to keep a connection open.
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      for (let at = 0; at < buffer.length; at++) {
        const char = buffer[at];
        if (char !== "\n" && char !== "\r") continue;
        // A CR last in what came may have its LF in the next chunk.
        if (char === "\r" && at + 1 === buffer.length && !done) break;
        const line = buffer.slice(start, at);
        if (char === "\r" && buffer[at + 1] === "\n") at++;
        start = at + 1;
        const event = take(line);
        if (event !== undefined) yield event;
      }
      buffer = buffer.slice(start);
      if (done) {
        // A stream that ends without its last blank line still ends that event.
        const last = (buffer === "" ? undefined : take(buffer)) ?? take("");
        if (last !== undefined) yield last;
        finished = true;
        return;
      }
    }
  } finally {
    // Stopped before the end, as when the caller has what it wanted.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
