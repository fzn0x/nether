// What the page knows of a phone (ADR 0087): its media queries, read where
// the page can read them, and the commands a phone leaves out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandIds } from "../src/commands.ts";
import { coarseQuery, matches, notOnPhones, phoneQuery } from "../src/phone.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matches", () => {
  it("matches nothing where the page cannot ask, as in tests", () => {
    expect(matches(phoneQuery)).toBe(false);
  });

  it("asks the page's media queries", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === coarseQuery }));
    expect(matches(coarseQuery)).toBe(true);
    expect(matches(phoneQuery)).toBe(false);
  });
});

describe("notOnPhones", () => {
  it("leaves out only tabs and the second pane, which a phone never shows", () => {
    expect([...notOnPhones].sort()).toEqual(["closeTab", "nextTab", "previousTab", "splitRight"]);
    for (const id of notOnPhones) expect(commandIds).toContain(id);
  });
});
