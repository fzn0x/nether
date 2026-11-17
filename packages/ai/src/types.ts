// What a provider is to the app (ADR 0068): one interface, streaming chat
// and embeddings, whichever API is behind it.

/**
 * How a provider is spoken to: `openai` for any OpenAI-compatible endpoint
 * (OpenAI itself, Ollama, vLLM, LM Studio, llama.cpp's server, gateways),
 * `anthropic` for Anthropic's Messages API.
 */
export type ProviderKind = "openai" | "anthropic";

export const providerKinds: readonly ProviderKind[] = ["openai", "anthropic"];

/** Where a provider is, and which of its models to chat with. */
export interface ProviderConfig {
  readonly kind: ProviderKind;
  /**
   * The API's address. For an OpenAI-compatible endpoint, its base with its
   * version, as `https://api.openai.com/v1` or `http://localhost:11434/v1`;
   * for Anthropic, `https://api.anthropic.com`.
   */
  readonly url: string;
  /** The model to chat with, as the provider names it; the user types it. */
  readonly model: string;
}

/** How to reach a provider: the fetch to send with, and the user's key. */
export interface ProviderAccess {
  readonly fetch: typeof fetch;
  /** The provider's key; none for a local model that asks for none. */
  readonly key?: string | undefined;
}

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  /** What the model is told before the conversation. */
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  /**
   * The most tokens the reply may take. Anthropic needs a limit, and gets
   * 16,000 when none is given; OpenAI-compatible endpoints get none, so
   * their own default applies.
   */
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface EmbedRequest {
  /** The embedding model, as the provider names it. */
  readonly model: string;
  readonly input: readonly string[];
  readonly signal?: AbortSignal;
}

export interface Provider {
  /** The reply's text, piece by piece as it streams in. */
  chat(request: ChatRequest): AsyncIterable<string>;
  /** One vector for each text of `input`, in its order. */
  embed(request: EmbedRequest): Promise<number[][]>;
}
