// Replies as each provider streams them, written out as their documentation
// shows: OpenAI's chat completion chunks (and Ollama's, which follow them),
// and Anthropic's Messages events, taken from its streaming guide.

/** OpenAI's chat completions, streamed with usage, ending in [DONE]. */
export const openAiReply = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1767225600,"model":"gpt-6-astra","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"usage":null}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1767225600,"model":"gpt-6-astra","choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}],"usage":null}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1767225600,"model":"gpt-6-astra","choices":[{"index":0,"delta":{"content":", wörld ✓"},"logprobs":null,"finish_reason":null}],"usage":null}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1767225600,"model":"gpt-6-astra","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1767225600,"model":"gpt-6-astra","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

/** Ollama's OpenAI-compatible chunks, with CRLF line ends as some servers send. */
export const ollamaReply = [
  'data: {"id":"chatcmpl-42","object":"chat.completion.chunk","created":1767225600,"model":"llama3.2","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":"Teh"},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-42","object":"chat.completion.chunk","created":1767225600,"model":"llama3.2","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":" fixed"},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-42","object":"chat.completion.chunk","created":1767225600,"model":"llama3.2","system_fingerprint":"fp_ollama","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\r\n");

/** Anthropic's documented stream: a text block with a ping inside it. */
export const anthropicReply = [
  "event: message_start",
  'data: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}',
  "",
  "event: content_block_start",
  'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
  "",
  "event: ping",
  'data: {"type": "ping"}',
  "",
  "event: content_block_delta",
  'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}',
  "",
  "event: content_block_delta",
  'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}',
  "",
  "event: content_block_stop",
  'data: {"type": "content_block_stop", "index": 0}',
  "",
  "event: message_delta",
  'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}',
  "",
  "event: message_stop",
  'data: {"type": "message_stop"}',
  "",
  "",
].join("\n");

/**
 * A stream from a model that thinks first, with its thinking omitted, an
 * event type this reader does not know, and text with characters beyond
 * ASCII.
 */
export const anthropicThinkingReply = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":40,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":0}',
  "",
  "event: something_new",
  'data: {"type":"something_new","detail":{"text":"not the reply"}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Bonjour, "}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"le café ☕"}}',
  "",
  "event: content_block_stop",
  'data: {"type":"content_block_stop","index":1}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":30}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

/** A stream the API breaks off with an error, as its streaming guide shows one. */
export const anthropicOverloaded = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_3","type":"message","role":"assistant","content":[],"model":"claude-haiku-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}',
  "",
  "event: content_block_start",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partly"}}',
  "",
  "event: error",
  'data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}',
  "",
  "",
].join("\n");

/** A reply the model declined, with the refusal stop reason. */
export const anthropicRefusal = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_4","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":1}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");
