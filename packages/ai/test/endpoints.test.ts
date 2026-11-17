// Where each API's calls go, and what they carry, as the adapters and the
// server's relay both take them.
import { describe, expect, it } from "vitest";
import { anthropicVersion, apiBase, callOf, callPath, requestHeaders } from "../src/endpoints.ts";

describe("endpoints", () => {
  it("give each API's calls their paths, and none it lacks", () => {
    expect(callPath("openai", "chat")).toBe("/chat/completions");
    expect(callPath("openai", "embed")).toBe("/embeddings");
    expect(callPath("anthropic", "chat")).toBe("/v1/messages");
    expect(callPath("anthropic", "embed")).toBeUndefined();
  });

  it("tell a call by its path, and nothing else", () => {
    expect(callOf("openai", "/chat/completions")).toBe("chat");
    expect(callOf("openai", "/embeddings")).toBe("embed");
    expect(callOf("anthropic", "/v1/messages")).toBe("chat");
    for (const path of ["/v1/messages", "/models", "/chat/completions/../x", "", "/"]) {
      if (path === "/v1/messages") expect(callOf("openai", path)).toBeUndefined();
      else expect(callOf("anthropic", path)).toBeUndefined();
    }
    expect(callOf("openai", "/v1/chat/completions")).toBeUndefined();
  });

  it("take addresses as the SDKs do", () => {
    expect(apiBase("openai", "http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(apiBase("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(apiBase("anthropic", "https://api.anthropic.com/")).toBe("https://api.anthropic.com");
  });

  it("put the key in each API's own header, and none without one", () => {
    expect(requestHeaders("openai", "sk")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk",
    });
    expect(requestHeaders("openai", "")).toEqual({ "content-type": "application/json" });
    expect(requestHeaders("anthropic", "sk-ant")).toEqual({
      "content-type": "application/json",
      "anthropic-version": anthropicVersion,
      "x-api-key": "sk-ant",
    });
    expect(requestHeaders("anthropic", undefined)).not.toHaveProperty("x-api-key");
  });
});
