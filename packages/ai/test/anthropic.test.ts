// Anthropic's Messages API: the documented stream, a model that thinks
// first, events this reader does not know, errors midway, refusals, and no
// embeddings.
import { describe, expect, it } from "vitest";
import { anthropic, defaultMaxTokens } from "../src/anthropic.ts";
import { anthropicVersion } from "../src/endpoints.ts";
import { AiError } from "../src/errors.ts";
import { collect, fakeFetch } from "./fake.ts";
import {
  anthropicOverloaded,
  anthropicRefusal,
  anthropicReply,
  anthropicThinkingReply,
} from "./streams.ts";

const claude = {
  kind: "anthropic",
  url: "https://api.anthropic.com",
  model: "claude-opus-5-5",
} as const;

async function failure(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiError) return error;
    throw error;
  }
  throw new Error("It did not fail.");
}

describe("Anthropic's Messages API", () => {
  it("streams the documented reply, at any chunk size, and asks as the API wants", async () => {
    for (const chunk of [1, 3, 40, 100_000]) {
      const fake = fakeFetch({ body: anthropicReply, chunk });
      const provider = anthropic(claude, { fetch: fake.fetch, key: "sk-ant-test" });
      const parts = await collect(
        provider.chat({ system: "Be brief.", messages: [{ role: "user", content: "Hello" }] }),
      );
      expect(parts).toEqual(["Hello", "!"]);
      expect(fake.sent).toEqual([
        {
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": anthropicVersion,
            "x-api-key": "sk-ant-test",
          },
          body: {
            model: "claude-opus-5-5",
            max_tokens: defaultMaxTokens,
            system: "Be brief.",
            messages: [{ role: "user", content: "Hello" }],
            stream: true,
          },
        },
      ]);
    }
    expect(anthropicVersion).toBe("2026-10-21");
  });

  it("passes over thinking and event types it does not know", async () => {
    const fake = fakeFetch({ body: anthropicThinkingReply, chunk: 11 });
    const provider = anthropic(
      { ...claude, url: "https://gateway.example.org/anthropic/v1/", model: "claude-sonnet-5-5" },
      { fetch: fake.fetch },
    );
    const parts = await collect(
      provider.chat({ messages: [{ role: "user", content: "Salut" }], maxTokens: 500 }),
    );
    expect(parts.join("")).toBe("Bonjour, le café ☕");
    // An address typed with its version, and a request with a limit and no key.
    expect(fake.sent[0]?.url).toBe("https://gateway.example.org/anthropic/v1/messages");
    expect(fake.sent[0]?.headers["x-api-key"]).toBeUndefined();
    expect(fake.sent[0]?.body).toMatchObject({ max_tokens: 500 });
    expect(fake.sent[0]?.body).not.toHaveProperty("system");
  });

  it("stops at an error event, after the text that came before it", async () => {
    const fake = fakeFetch({ body: anthropicOverloaded, chunk: 17 });
    const parts: string[] = [];
    const error = await failure(
      (async () => {
        for await (const part of anthropic(claude, { fetch: fake.fetch, key: "k" }).chat({
          messages: [],
        })) {
          parts.push(part);
        }
      })(),
    );
    expect(parts).toEqual(["Partly"]);
    expect(error).toMatchObject({ kind: "stream", message: "Overloaded" });
  });

  it("tells a refusal", async () => {
    const fake = fakeFetch({ body: anthropicRefusal });
    expect(
      await failure(
        collect(anthropic(claude, { fetch: fake.fetch, key: "k" }).chat({ messages: [] })),
      ),
    ).toMatchObject({ kind: "refused" });
  });

  it("gives the API's message when it answers with an error", async () => {
    const fake = fakeFetch({
      status: 401,
      type: "application/json",
      body: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
        request_id: "req_011CSHoEeqs5C35K2UUqR7Fy",
      }),
    });
    expect(
      await failure(
        collect(anthropic(claude, { fetch: fake.fetch, key: "bad" }).chat({ messages: [] })),
      ),
    ).toMatchObject({ kind: "http", status: 401, message: "invalid x-api-key" });
  });

  it("takes a whole message from a server that does not stream", async () => {
    const whole = fakeFetch({
      type: "application/json",
      body: JSON.stringify({
        type: "message",
        content: [
          { type: "thinking", thinking: "", signature: "x" },
          { type: "text", text: "All " },
          { type: "text", text: "at once" },
        ],
        stop_reason: "end_turn",
      }),
    });
    expect(await collect(anthropic(claude, { fetch: whole.fetch }).chat({ messages: [] }))).toEqual(
      ["All at once"],
    );
    const declined = fakeFetch({
      type: "application/json",
      body: JSON.stringify({ type: "message", content: [], stop_reason: "refusal" }),
    });
    expect(
      await failure(collect(anthropic(claude, { fetch: declined.fetch }).chat({ messages: [] }))),
    ).toMatchObject({ kind: "refused" });
    const empty = fakeFetch({
      type: "application/json",
      body: JSON.stringify({ type: "message" }),
    });
    expect(await collect(anthropic(claude, { fetch: empty.fetch }).chat({ messages: [] }))).toEqual(
      [],
    );
  });

  it("refuses an answer with no body", async () => {
    const empty: typeof fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    expect(
      await failure(collect(anthropic(claude, { fetch: empty }).chat({ messages: [] }))),
    ).toMatchObject({ kind: "response" });
  });

  it("has no embeddings", async () => {
    const fake = fakeFetch();
    expect(
      await failure(
        anthropic(claude, { fetch: fake.fetch, key: "k" }).embed({ model: "m", input: ["a"] }),
      ),
    ).toMatchObject({ kind: "unsupported" });
    expect(fake.sent).toEqual([]);
  });
});
