// Approved endpoints (ADR 0086): how an address is compared, and which
// provider addresses an approved endpoint allows.
import { describe, expect, it } from "vitest";
import { endpointOf, isApproved } from "../src/approved.ts";

describe("an approved endpoint", () => {
  it("is compared by scheme, host and port in lower case, with no trailing slash", () => {
    expect(endpointOf("HTTPS://LLM.Corp.Example:443/v1/")).toBe("https://llm.corp.example/v1");
    expect(endpointOf("http://10.0.0.5:8080")).toBe("http://10.0.0.5:8080");
    expect(endpointOf("https://llm.corp.example/v1/../admin")).toBe(
      "https://llm.corp.example/admin",
    );
    for (const text of [
      "llm.corp.example",
      "ftp://llm.corp.example",
      "https://user:secret@llm.corp.example/v1",
      "https://llm.corp.example/?a=1",
      "https://llm.corp.example/#a",
    ]) {
      expect(endpointOf(text)).toBeUndefined();
    }
  });

  it("allows addresses at or under it at a slash, and nothing else", () => {
    const list = ["https://llm.corp.example/v1"];
    expect(isApproved("https://llm.corp.example/v1", list)).toBe(true);
    expect(isApproved("https://LLM.corp.example/v1/", list)).toBe(true);
    expect(isApproved("https://llm.corp.example/v1/team", list)).toBe(true);
    expect(isApproved("https://llm.corp.example/v10", list)).toBe(false);
    expect(isApproved("https://llm.corp.example", list)).toBe(false);
    expect(isApproved("http://llm.corp.example/v1", list)).toBe(false);
    expect(isApproved("https://llm.corp.example:8443/v1", list)).toBe(false);
    expect(isApproved("https://llm.corp.example/v1/../other", list)).toBe(false);
    expect(isApproved("https://api.anthropic.com", list)).toBe(false);
    expect(isApproved("not an address", list)).toBe(false);
  });
});
