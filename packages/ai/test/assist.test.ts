// Writing assist's requests and the replies it puts in a note.
import { describe, expect, it } from "vitest";
import { assistActions, assistPlacement, assistRequest, cleanReply } from "../src/assist.ts";
import { createProvider, hostOf, isLocal, providerUrl } from "../src/provider.ts";
import { collect, fakeFetch } from "./fake.ts";
import { anthropicReply, ollamaReply } from "./streams.ts";

describe("writing assist", () => {
  it("asks for each action, with the text apart from the instruction", () => {
    for (const action of assistActions) {
      const request = assistRequest(action, "Some *text*.");
      expect(request.system).toContain("Markdown");
      expect(request.messages).toHaveLength(1);
      const content = request.messages[0]?.content ?? "";
      expect(content.endsWith("<text>\nSome *text*.\n</text>")).toBe(true);
    }
    expect(
      assistRequest("translate", "Hallo", { language: " Japanese " }).messages[0]?.content,
    ).toContain("Translate this text into Japanese.");
    expect(assistRequest("translate", "Hallo").messages[0]?.content).toContain("into English.");
    expect(assistRequest("rewrite", "x", { how: "shorter" }).messages[0]?.content).toContain(
      "Make it: shorter",
    );
    expect(assistRequest("rewrite", "x", { how: "  " }).messages[0]?.content).toContain(
      "so it reads better",
    );
  });

  it("puts summaries and continuations after the text, and the rest in its place", () => {
    expect(assistActions.map(assistPlacement)).toEqual([
      "replace",
      "replace",
      "after",
      "replace",
      "after",
    ]);
  });

  it("takes a reply out of the fence or tags some models wrap it in", () => {
    expect(cleanReply("  Fixed text.\n")).toBe("Fixed text.");
    expect(cleanReply("```markdown\n# Title\n\n- one\n```")).toBe("# Title\n\n- one");
    expect(cleanReply("```\nplain\n```")).toBe("plain");
    expect(cleanReply("<text>\nTagged\n</text>")).toBe("Tagged");
    // A code block that is only part of the reply stays.
    expect(cleanReply("Run:\n\n```sh\nls\n```")).toBe("Run:\n\n```sh\nls\n```");
    expect(cleanReply("```js\ncode\n```")).toBe("```js\ncode\n```");
  });
});

describe("providers", () => {
  it("are made by their kind", async () => {
    const openAi = fakeFetch({ body: ollamaReply });
    const local = createProvider(
      { kind: "openai", url: "http://localhost:11434/v1", model: "llama3.2" },
      { fetch: openAi.fetch },
    );
    expect((await collect(local.chat({ messages: [] }))).join("")).toBe("Teh fixed");
    const claude = fakeFetch({ body: anthropicReply });
    const remote = createProvider(
      { kind: "anthropic", url: "https://api.anthropic.com", model: "claude-haiku-5-5" },
      { fetch: claude.fetch, key: "k" },
    );
    expect((await collect(remote.chat({ messages: [] }))).join("")).toBe("Hello!");
    expect(claude.sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("read addresses as people type them", () => {
    expect(providerUrl("api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(providerUrl(" http://localhost:11434/v1 ")).toBe("http://localhost:11434/v1");
    expect(providerUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
    for (const bad of [
      "",
      "ftp://example.org",
      "https://user:pw@example.org",
      "https://e.org/?q=1",
      "https://e.org/#x",
      "http://",
    ]) {
      expect(providerUrl(bad)).toBeUndefined();
    }
  });

  it("tell this computer's addresses from others", () => {
    for (const local of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8000/v1",
      "http://[::1]:1234/v1",
      "http://ollama.localhost",
    ]) {
      expect(isLocal(local)).toBe(true);
    }
    for (const remote of [
      "https://api.openai.com/v1",
      "http://10.0.0.2:11434/v1",
      "http://localhost.example.org",
      "not a url",
    ]) {
      expect(isLocal(remote)).toBe(false);
    }
    expect(hostOf("http://localhost:11434/v1")).toBe("localhost:11434");
    expect(hostOf("nonsense")).toBe("nonsense");
  });
});
