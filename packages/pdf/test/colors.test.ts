import { describe, expect, it } from "vitest";
import { colorValue, defaultColor, highlightColors, offeredColor } from "../src/index.ts";

describe("highlight colors, as PDF++ writes them", () => {
  it("offers PDF++'s default palette, yellow first", () => {
    expect(highlightColors.map((each) => each.name)).toEqual([
      "yellow",
      "red",
      "note",
      "important",
    ]);
    expect(defaultColor).toBe("yellow");
  });

  it("shows PDF++'s names whatever their case, and three numbers", () => {
    expect(colorValue("Red")).toBe("#ea5252");
    expect(colorValue(" IMPORTANT ")).toBe("#bb61e5");
    expect(colorValue("255, 208,0")).toBe("rgb(255, 208, 0)");
    expect(colorValue("256,0,0")).toBeUndefined();
    expect(colorValue(undefined)).toBeUndefined();
  });

  it("shows a CSS color's name as itself, and nothing else", () => {
    const css = (name: string) => ["green", "teal"].includes(name);
    expect(colorValue("Green", css)).toBe("green");
    expect(colorValue("green")).toBeUndefined();
    expect(colorValue("my-color", css)).toBeUndefined();
    expect(colorValue("url(x)", () => true)).toBeUndefined();
  });

  it("knows which of the offered colors a link's color is", () => {
    expect(offeredColor(undefined)).toBe("yellow");
    expect(offeredColor("Note")).toBe("note");
    expect(offeredColor("green")).toBeUndefined();
  });
});
