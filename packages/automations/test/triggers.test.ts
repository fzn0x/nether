// Triggers: a change into a rule's value fires it, not one that stays, and
// what it sets is filled as a template is.
import type { Trigger } from "@nether/core";
import { describe, expect, it } from "vitest";
import { firedValues, fires, holds } from "../src/index.ts";

const done: Trigger = { when: "status", is: "Done", set: { completed: "{{date}}" } };
// Friday, 6 November 2026, at 9:30 where the tests run.
const now = new Date(2026, 10, 6, 9, 30);
const values = { title: "Launch", now };

describe("holds", () => {
  it("is the value, one of a list's, or none for null", () => {
    expect(holds("Done", "Done")).toBe(true);
    expect(holds("done", "Done")).toBe(false);
    expect(holds(["Doing", "Done"], "Done")).toBe(true);
    expect(holds(["a", "b"], ["a", "b"])).toBe(true);
    expect(holds([["a"]], ["a"])).toBe(false);
    expect(holds(true, true)).toBe(true);
    expect(holds(1, "1")).toBe(false);
    expect(holds(undefined, "Done")).toBe(false);
    for (const none of [undefined, null, "", []]) expect(holds(none, null)).toBe(true);
    expect(holds("x", null)).toBe(false);
  });
});

describe("fires", () => {
  it("on a change into its value, from another or from none", () => {
    expect(fires(done, { key: "status", before: "Doing", after: "Done" })).toBe(true);
    expect(fires(done, { key: "status", before: undefined, after: "Done" })).toBe(true);
    expect(fires(done, { key: "status", before: ["a"], after: ["a", "Done"] })).toBe(true);
  });

  it("not while it stays, nor away from it, nor for another property", () => {
    expect(fires(done, { key: "status", before: "Done", after: "Done" })).toBe(false);
    expect(fires(done, { key: "status", before: ["Done"], after: ["Done", "b"] })).toBe(false);
    expect(fires(done, { key: "status", before: "Done", after: "Doing" })).toBe(false);
    expect(fires(done, { key: "stage", before: "Doing", after: "Done" })).toBe(false);
  });
});

describe("firedValues", () => {
  it("sets what the rules a change fires set, their variables filled", () => {
    expect(firedValues([done], { key: "status", before: "Doing", after: "Done" }, values)).toEqual({
      completed: "2026-11-06",
    });
    const more: Trigger = {
      when: "status",
      is: "Done",
      set: {
        note: "{{title}} closed at {{time}}, {{date:dddd}}",
        labels: ["done {{date:YYYY}}", 3],
        count: 1,
        done: true,
        completed: null,
        extra: { kept: "{{date}}" },
      },
    };
    expect(
      firedValues([done, more], { key: "status", before: null, after: "Done" }, values),
    ).toEqual({
      // The later rule's value wins.
      completed: null,
      note: "Launch closed at 09:30, Friday",
      labels: ["done 2026", 3],
      count: 1,
      done: true,
      extra: { kept: "{{date}}" },
    });
  });

  it("sets nothing for a change that fires nothing, and starts no other rule", () => {
    const closed: Trigger = { when: "stage", is: "Closed", set: { archived: true } };
    const stage: Trigger = { when: "status", is: "Done", set: { stage: "Closed" } };
    expect(
      firedValues([done, closed], { key: "status", before: "Done", after: "Done" }, values),
    ).toEqual({});
    // What one rule sets is not a change: the rule on what it sets does not fire.
    expect(
      firedValues([stage, closed], { key: "status", before: "Doing", after: "Done" }, values),
    ).toEqual({ stage: "Closed" });
    expect(firedValues([], { key: "status", before: "Doing", after: "Done" }, values)).toEqual({});
  });
});
