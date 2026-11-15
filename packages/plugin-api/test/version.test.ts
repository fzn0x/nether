import { describe, expect, it } from "vitest";
import { isRange, isVersion, satisfies } from "../src/version.ts";

describe("satisfies", () => {
  it("reads a caret as npm does after 1.0", () => {
    expect(satisfies("1.2.0", "^1.2")).toBe(true);
    expect(satisfies("1.9.4", "^1.2")).toBe(true);
    expect(satisfies("1.1.9", "^1.2")).toBe(false);
    expect(satisfies("2.0.0", "^1.2")).toBe(false);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
  });

  it("takes only the same minor version before 1.0", () => {
    expect(satisfies("0.1.0", "^0.1")).toBe(true);
    expect(satisfies("0.1.7", "^0.1.2")).toBe(true);
    expect(satisfies("0.1.1", "^0.1.2")).toBe(false);
    expect(satisfies("0.2.0", "^0.1")).toBe(false);
    expect(satisfies("1.0.0", "^0.1")).toBe(false);
  });

  it("takes only 0.0.x for ^0.0, and one version for ^0.0.3", () => {
    expect(satisfies("0.0.9", "^0.0")).toBe(true);
    expect(satisfies("0.1.0", "^0.0")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  it("takes a version alone as itself", () => {
    expect(satisfies("0.1.0", "0.1.0")).toBe(true);
    expect(satisfies("0.1.1", "0.1.0")).toBe(false);
  });

  it("takes nothing it cannot read", () => {
    expect(satisfies("0.1", "^0.1")).toBe(false);
    expect(satisfies("0.1.0", ">=0.1")).toBe(false);
    expect(satisfies("0.1.0", "0.1")).toBe(false);
  });
});

describe("isVersion and isRange", () => {
  it("tell versions and ranges apart", () => {
    expect(isVersion("1.0.2")).toBe(true);
    expect(isVersion("1.0")).toBe(false);
    expect(isVersion("01.0.0")).toBe(false);
    expect(isRange("^0.1")).toBe(true);
    expect(isRange("^0.1.2")).toBe(true);
    expect(isRange("0.1.2")).toBe(true);
    expect(isRange("0.1")).toBe(false);
    expect(isRange("~0.1")).toBe(false);
  });
});
