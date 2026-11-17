// An OpenAI-compatible endpoint: the chat completions and embeddings API
// that OpenAI defined and that Ollama, vLLM, LM Studio, llama.cpp's server
// and most gateways also serve. A reply streams as server-sent events, each
// a `chat.completion.chunk` whose first choice's `delta.content` is the next
// piece of text, and the stream ends with `data: [DONE]`.
import { AiError, errorMessage, isJson, parseJson, record, send } from "./errors.ts";
import { serverSentEvents } from "./sse.ts";
import type {
  ChatRequest,
  EmbedRequest,
  Provider,
  ProviderAccess,
  ProviderConfig,
} from "./types.ts";

/** The text of a chunk's, or a whole completion's, first choice; and why it stopped. */
function firstChoice(body: unknown): { text: string; finish: unknown } {
  const choices = record(body)?.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : undefined;
  const part = record(choice?.delta) ?? record(choice?.message);
  return {
    text: typeof part?.content === "string" ? part.content : "",
    finish: choice?.finish_reason,
  };
}

function refused(finish: unknown): void {
  if (finish === "content_filter") {
    throw new AiError("refused", "The provider's content filter stopped the reply.");
  }
}

export function openAiCompatible(config: ProviderConfig, access: ProviderAccess): Provider {
  const base = config.url.replace(/\/+$/, "");
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(access.key === undefined || access.key === ""
      ? {}
      : { authorization: `Bearer ${access.key}` }),
  });

  return {
    async *chat(request: ChatRequest) {
      const messages = [
        ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
        ...request.messages,
      ];
      const response = await send(access.fetch, `${base}/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: config.model, messages, stream: true }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      // A server that does not stream answers with the whole completion.
      if (isJson(response)) {
        const { text, finish } = firstChoice(await response.json());
        refused(finish);
        if (text !== "") yield text;
        return;
      }
      if (response.body === null) throw new AiError("response", "The provider sent no reply.");
      for await (const event of serverSentEvents(response.body)) {
        if (event.data.trim() === "[DONE]") return;
        const chunk = parseJson(event.data);
        // Some servers send an error as a chunk of its own.
        if (record(chunk)?.error !== undefined) {
          throw new AiError("stream", errorMessage(chunk) ?? "The provider sent an error.");
        }
        const { text, finish } = firstChoice(chunk);
        if (text !== "") yield text;
        refused(finish);
      }
    },

    async embed(request: EmbedRequest) {
      if (request.input.length === 0) return [];
      const response = await send(access.fetch, `${base}/embeddings`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: request.model, input: request.input }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const data = record(parseJson(await response.text()))?.data;
      const items = Array.isArray(data) ? data.map((item) => record(item)) : [];
      const vectors = new Map<number, number[]>();
      for (const [order, item] of items.entries()) {
        const vector = item?.embedding;
        const index = typeof item?.index === "number" ? item.index : order;
        if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) {
          throw new AiError("response", "The provider's embeddings are not lists of numbers.");
        }
        vectors.set(index, vector);
      }
      // Each text's vector, by its index, which the provider may send out of order.
      return request.input.map((_text, index) => {
        const vector = vectors.get(index);
        if (vector === undefined || vectors.size !== request.input.length) {
          throw new AiError("response", "The provider sent a different number of embeddings.");
        }
        return vector;
      });
    },
  };
}
