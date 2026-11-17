// A fetch that serves a provider's answers from what a test gives it, the
// body cut into chunks of a size, so a reader meets every boundary: inside
// a line, between a CR and its LF, inside a character. It records each
// request, and never reaches the network.

export interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface Answer {
  readonly status?: number;
  readonly type?: string;
  readonly body: string;
  /** The size in bytes of each chunk the body arrives in; all at once when not given. */
  readonly chunk?: number;
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly sent: Sent[];
  /** Whether the reader cancelled the last body before it ended. */
  cancelled(): boolean;
}

export function fakeFetch(...answers: Answer[]): FakeFetch {
  const sent: Sent[] = [];
  let cancelled = false;
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text = typeof init?.body === "string" ? init.body : "";
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new TypeError("fetch failed"));
    const bytes = new TextEncoder().encode(answer.body);
    const size = answer.chunk ?? Math.max(bytes.length, 1);
    let at = 0;
    cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted === true) {
          controller.error(init.signal.reason);
          return;
        }
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: answer.status ?? 200,
        headers: { "content-type": answer.type ?? "text/event-stream" },
      }),
    );
  };
  return { fetch: fetcher, sent, cancelled: () => cancelled };
}

/** Everything a stream of text gives, joined. */
export async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const parts: string[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}
