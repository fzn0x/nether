// Anthropic's Messages API: POST /v1/messages with the key in `x-api-key`
// and the API's version in `anthropic-version`. A reply streams as named
// server-sent events: `message_start`, then for each content block a
// `content_block_start`, its `content_block_delta`s and a
// `content_block_stop`, then `message_delta` with why it stopped and
// `message_stop`, with `ping`s anywhere and an `error` event when the API
// fails midway. Text comes as `text_delta`s; thinking and other blocks are
// not the reply's text, and event types it does not know are passed over,
// as Anthropic's documentation asks. Anthropic has no embeddings API.
import { apiBase, callPath, requestHeaders } from "./endpoints.ts";
import { AiError, errorMessage, isJson, parseJson, record, send } from "./errors.ts";
import { serverSentEvents } from "./sse.ts";
import type { ChatRequest, Provider, ProviderAccess, ProviderConfig } from "./types.ts";

/** The reply's limit when the request sets none: room for a model that thinks first. */
export const defaultMaxTokens = 16_000;

function refused(stopReason: unknown): void {
  if (stopReason === "refusal") throw new AiError("refused", "The model declined to answer.");
}

/** The text blocks of a whole message, as a server that does not stream sends it. */
function messageText(body: unknown): string {
  const content = record(body)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => record(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block?.text))
    .join("");
}

export function anthropic(config: ProviderConfig, access: ProviderAccess): Provider {
  // Anthropic's SDKs take the address without the version; one typed with it works too.
  const base = apiBase("anthropic", config.url);

  return {
    async *chat(request: ChatRequest) {
      const response = await send(access.fetch, `${base}${callPath("anthropic", "chat") ?? ""}`, {
        method: "POST",
        headers: requestHeaders("anthropic", access.key),
        body: JSON.stringify({
          model: config.model,
          max_tokens: request.maxTokens ?? defaultMaxTokens,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: request.messages,
          stream: true,
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (isJson(response)) {
        const body: unknown = await response.json();
        refused(record(body)?.stop_reason);
        const text = messageText(body);
        if (text !== "") yield text;
        return;
      }
      if (response.body === null) throw new AiError("response", "The provider sent no reply.");
      for await (const { event, data } of serverSentEvents(response.body)) {
        const payload = record(parseJson(data));
        const type = payload?.type ?? event;
        if (type === "content_block_delta") {
          const delta = record(payload?.delta);
          if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
            yield delta.text;
          }
        } else if (type === "message_delta") {
          refused(record(payload?.delta)?.stop_reason);
        } else if (type === "error") {
          throw new AiError("stream", errorMessage(payload) ?? "The provider sent an error.");
        } else if (type === "message_stop") {
          return;
        }
      }
    },

    embed() {
      return Promise.reject(
        new AiError(
          "unsupported",
          "Anthropic has no embeddings API: choose an OpenAI-compatible provider for embeddings.",
        ),
      );
    },
  };
}
