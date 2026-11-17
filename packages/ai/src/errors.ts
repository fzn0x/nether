// What went wrong reaching a provider, in a form the app can word itself.

/**
 * - `network`: the request did not reach the provider, or broke off.
 * - `http`: the provider answered with an error status.
 * - `stream`: the provider sent an error while the reply streamed.
 * - `refused`: the provider declined to answer.
 * - `response`: the provider answered with something that is not its API's.
 * - `unsupported`: the provider has no such API, as Anthropic has no embeddings.
 */
export type AiErrorKind = "network" | "http" | "stream" | "refused" | "response" | "unsupported";

export class AiError extends Error {
  override readonly name = "AiError";
  readonly kind: AiErrorKind;
  /** The HTTP status, for an `http` error. */
  readonly status: number | undefined;

  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** A JSON object's fields; undefined when the value is not an object. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The message in an error a provider sent: `{"error": {"message": ...}}`
 * from OpenAI and Anthropic, `{"error": "..."}` from Ollama and others, or
 * `{"message": ...}`; undefined when there is none.
 */
export function errorMessage(body: unknown): string | undefined {
  const top = record(body);
  if (top === undefined) return undefined;
  const error = top.error;
  if (typeof error === "string" && error !== "") return error;
  const inner = record(error)?.message;
  if (typeof inner === "string" && inner !== "") return inner;
  return typeof top.message === "string" && top.message !== "" ? top.message : undefined;
}

/** JSON's value, or undefined when the text is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Sends a request and returns the provider's answer when it succeeded; an
 * error status becomes an `http` error with the provider's message.
 */
export async function send(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    // An abort is the caller's, not the provider's.
    if (init.signal?.aborted === true) throw error;
    throw new AiError("network", error instanceof Error ? error.message : String(error));
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  const message =
    errorMessage(parseJson(text)) ?? (text.trim().slice(0, 300) || response.statusText);
  throw new AiError("http", message, response.status);
}

/** Whether an answer is one JSON document rather than a stream of events. */
export function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}
