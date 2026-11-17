# @nether/ai

AI from a provider the user chooses, with their own key
([ADR 0068](../../docs/adr/0068-ai-comes-from-the-users-own-provider-reached-from-their-device.md)):
one interface for streaming chat and embeddings, over any `fetch`, with an
adapter for each of two APIs.

- **OpenAI-compatible endpoints**: `POST <url>/chat/completions` streamed
  as server-sent events, and `POST <url>/embeddings`. This covers OpenAI,
  Ollama (`http://localhost:11434/v1`), vLLM, LM Studio, llama.cpp's server
  and most gateways.
- **Anthropic's Messages API**: `POST <url>/v1/messages`, streamed. Anthropic
  has no embeddings API.

No vendor's SDK: each adapter is a request and a reader of its stream, so
no provider is a dependency (principle 8). Model names are whatever the
user types.

```ts
import { assistRequest, createProvider } from "@nether/ai";

const provider = createProvider(
  { kind: "openai", url: "http://localhost:11434/v1", model: "llama3.2" },
  { fetch },
);
for await (const text of provider.chat(assistRequest("fixGrammar", "Teh quick fox."))) {
  show(text);
}
```

Writing assist's requests, `assistRequest`, and `cleanReply` for its
replies, are here too
([ADR 0069](../../docs/adr/0069-writing-assist-streams-into-a-preview-and-goes-in-as-one-edit.md)).

Tests run every adapter against a fake `fetch` that serves streams written
as each provider's documentation shows them; no test reaches a provider.
