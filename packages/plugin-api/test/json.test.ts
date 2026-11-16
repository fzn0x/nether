import { describe, expect, it } from "vitest";
import { isJson, isJsonObject } from "../src/json.ts";

describe("isJson", () => {
  it("takes what JSON writes and reads back the same", () => {
    for (const value of [null, true, 0, -1.5, "", "a", [], [1, [null]], {}, { a: { b: [] } }]) {
      expect(isJson(value)).toBe(true);
    }
  });

  it("refuses what JSON would change or drop", () => {
    const values: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      Symbol("a"),
      new Date(0),
      new Map(),
      [undefined],
      { a: undefined },
      Object.create(null),
    ];
    for (const value of values) expect(isJson(value)).toBe(false);
  });
});

describe("isJsonObject", () => {
  it("takes only objects", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("a")).toBe(false);
  });
});
