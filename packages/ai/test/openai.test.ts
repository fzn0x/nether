// An OpenAI-compatible endpoint: streamed chat from OpenAI and Ollama, the
// requests as their APIs want them, errors in every place they come, and
// embeddings.
import { describe, expect, it } from "vitest";
import { AiError } from "../src/errors.ts";
import { openAiCompatible } from "../src/openai.ts";
import { collect, fakeFetch } from "./fake.ts";
import { ollamaReply, openAiReply } from "./streams.ts";

const openAi = { kind: "openai", url: "https://api.openai.com/v1/", model: "gpt-6-astra" } as const;
const ollama = { kind: "openai", url: "http://localhost:11434/v1", model: "llama3.2" } as const;

async function failure(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiError) return error;
    throw error;
  }
  throw new Error("It did not fail.");
}

describe("an OpenAI-compatible endpoint", () => {
  it("streams OpenAI's reply, at any chunk size, and asks as its API wants", async () => {
    for (const chunk of [1, 5, 64, 100_000]) {
      const fake = fakeFetch({ body: openAiReply, chunk });
      const provider = openAiCompatible(openAi, { fetch: fake.fetch, key: "sk-test" });
      const parts = await collect(
        provider.chat({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }] }),
      );
      expect(parts.join("")).toBe("Hello, wörld ✓");
      expect(fake.sent).toEqual([
        {
          url: "https://api.openai.com/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
          body: {
            model: "gpt-6-astra",
            messages: [
              { role: "system", content: "Be brief." },
              { role: "user", content: "Hi" },
            ],
            stream: true,
          },
        },
      ]);
    }
  });

  it("streams Ollama's reply, sending no key when it has none", async () => {
    const fake = fakeFetch({ body: ollamaReply, chunk: 7 });
    const provider = openAiCompatible(ollama, { fetch: fake.fetch });
    const parts = await collect(provider.chat({ messages: [{ role: "user", content: "Fix" }] }));
    expect(parts).toEqual(["Teh", " fixed"]);
    expect(fake.sent[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(fake.sent[0]?.headers).toEqual({ "content-type": "application/json" });
    expect((fake.sent[0]?.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "Fix" },
    ]);
  });

  it("takes a whole completion from a server that does not stream", async () => {
    const fake = fakeFetch({
      type: "application/json",
      body: JSON.stringify({
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "All at once" },
            finish_reason: "stop",
          },
        ],
      }),
    });
    const provider = openAiCompatible(openAi, { fetch: fake.fetch, key: "k" });
    expect(await collect(provider.chat({ messages: [] }))).toEqual(["All at once"]);
  });

  it("gives the provider's message when it answers with an error", async () => {
    const openAiError = fakeFetch({
      status: 401,
      type: "application/json",
      body: JSON.stringify({
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
    });
    const error = await failure(
      collect(
        openAiCompatible(openAi, { fetch: openAiError.fetch, key: "bad" }).chat({ messages: [] }),
      ),
    );
    expect(error).toMatchObject({
      kind: "http",
      status: 401,
      message: "Incorrect API key provided.",
    });

    const ollamaError = fakeFetch({
      status: 404,
      type: "application/json",
      body: JSON.stringify({ error: 'model "llama9" not found, try pulling it first' }),
    });
    const missing = await failure(
      collect(openAiCompatible(ollama, { fetch: ollamaError.fetch }).chat({ messages: [] })),
    );
    expect(missing).toMatchObject({
      kind: "http",
      status: 404,
      message: 'model "llama9" not found, try pulling it first',
    });

    const plain = fakeFetch({ status: 502, type: "text/html", body: "<h1>Bad gateway</h1>" });
    expect(
      await failure(
        collect(openAiCompatible(ollama, { fetch: plain.fetch }).chat({ messages: [] })),
      ),
    ).toMatchObject({ kind: "http", status: 502, message: "<h1>Bad gateway</h1>" });
  });

  it("stops at an error sent in the stream, and at the content filter", async () => {
    const midway = fakeFetch({
      body: [
        'data: {"choices":[{"index":0,"delta":{"content":"Part"},"finish_reason":null}]}',
        "",
        'data: {"error":{"message":"The server had an error while processing your request."}}',
        "",
        "",
      ].join("\n"),
    });
    const parts: string[] = [];
    const error = await failure(
      (async () => {
        for await (const part of openAiCompatible(openAi, { fetch: midway.fetch }).chat({
          messages: [],
        })) {
          parts.push(part);
        }
      })(),
    );
    expect(parts).toEqual(["Part"]);
    expect(error).toMatchObject({
      kind: "stream",
      message: "The server had an error while processing your request.",
    });

    const filtered = fakeFetch({
      body: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n',
    });
    expect(
      await failure(
        collect(openAiCompatible(openAi, { fetch: filtered.fetch }).chat({ messages: [] })),
      ),
    ).toMatchObject({ kind: "refused" });
  });

  it("tells a request that never reached the provider from one the caller stopped", async () => {
    const unreachable = fakeFetch();
    expect(
      await failure(
        collect(openAiCompatible(ollama, { fetch: unreachable.fetch }).chat({ messages: [] })),
      ),
    ).toMatchObject({ kind: "network", message: "fetch failed" });

    const controller = new AbortController();
    const fake = fakeFetch({ body: openAiReply, chunk: 50 });
    const stopped = (async () => {
      for await (const part of openAiCompatible(openAi, { fetch: fake.fetch }).chat({
        messages: [],
        signal: controller.signal,
      })) {
        if (part === "Hello") controller.abort(new DOMException("Stopped", "AbortError"));
      }
    })();
    await expect(stopped).rejects.toThrow("Stopped");

    const before = new AbortController();
    before.abort(new DOMException("Never sent", "AbortError"));
    const refusing: typeof fetch = (_input, init) => Promise.reject(init?.signal?.reason as Error);
    await expect(
      collect(
        openAiCompatible(openAi, { fetch: refusing }).chat({ messages: [], signal: before.signal }),
      ),
    ).rejects.toThrow("Never sent");
  });

  it("refuses an answer with no body", async () => {
    const empty: typeof fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    expect(
      await failure(collect(openAiCompatible(openAi, { fetch: empty }).chat({ messages: [] }))),
    ).toMatchObject({ kind: "response" });
  });

  it("embeds texts, each vector by its index", async () => {
    const fake = fakeFetch({
      type: "application/json",
      body: JSON.stringify({
        object: "list",
        data: [
          { object: "embedding", embedding: [0.3, 0.4], index: 1 },
          { object: "embedding", embedding: [0.1, 0.2], index: 0 },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    });
    const provider = openAiCompatible(openAi, { fetch: fake.fetch, key: "k" });
    expect(await provider.embed({ model: "text-embedding-3-small", input: ["a", "b"] })).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fake.sent[0]).toMatchObject({
      url: "https://api.openai.com/v1/embeddings",
      body: { model: "text-embedding-3-small", input: ["a", "b"] },
    });
    expect(await provider.embed({ model: "m", input: [] })).toEqual([]);
  });

  it("refuses embeddings that do not match the texts", async () => {
    const short = fakeFetch({
      type: "application/json",
      body: JSON.stringify({ data: [{ embedding: [1], index: 0 }] }),
    });
    expect(
      await failure(
        openAiCompatible(openAi, { fetch: short.fetch }).embed({ model: "m", input: ["a", "b"] }),
      ),
    ).toMatchObject({ kind: "response" });
    const words = fakeFetch({
      type: "application/json",
      body: JSON.stringify({ data: [{ embedding: "AAAA", index: 0 }] }),
    });
    expect(
      await failure(
        openAiCompatible(openAi, { fetch: words.fetch }).embed({ model: "m", input: ["a"] }),
      ),
    ).toMatchObject({ kind: "response" });
    const nothing = fakeFetch({ type: "application/json", body: "not json" });
    expect(
      await failure(
        openAiCompatible(openAi, { fetch: nothing.fetch }).embed({ model: "m", input: ["a"] }),
      ),
    ).toMatchObject({ kind: "response" });
  });
});
