// A database's triggers as its settings show and add them: a sentence for
// each, a value read by its property's type, and a rule added beside one of
// the same property and value.
import { describe, expect, it } from "vitest";
import { triggerText, typedValue, valueText, withTrigger } from "../src/DatabaseTriggers.tsx";

describe("the triggers' editor", () => {
  it("reads a typed value by its property's type, and nothing as none", () => {
    expect(typedValue("checkbox", "true")).toBe(true);
    expect(typedValue("checkbox", "false")).toBe(false);
    expect(typedValue("checkbox", "yes")).toBe("yes");
    expect(typedValue("number", " 2.5 ")).toBe(2.5);
    expect(typedValue("number", "many")).toBe("many");
    expect(typedValue("select", "Done")).toBe("Done");
    expect(typedValue("date", "{{date}}")).toBe("{{date}}");
    expect(typedValue("text", "  ")).toBeNull();
    expect(typedValue(undefined, "x")).toBe("x");
  });

  it("writes each trigger as a sentence", () => {
    expect(valueText(null)).toBe("empty");
    expect(valueText(true)).toBe("true");
    expect(valueText(["a"])).toBe('["a"]');
    expect(
      triggerText({
        when: "status",
        is: "Done",
        set: { completed: "{{date}}", archived: true, stage: null },
      }),
    ).toBe("When status becomes Done, set completed to {{date}}, archived to true, stage to empty");
  });

  it("adds a rule last, or beside one of the same property and value", () => {
    const done = { when: "status", is: "Done", set: { completed: "{{date}}" } };
    expect(withTrigger([], "status", "Done", "completed", "{{date}}")).toEqual([done]);
    expect(withTrigger([done], "status", "Done", "archived", true)).toEqual([
      { when: "status", is: "Done", set: { completed: "{{date}}", archived: true } },
    ]);
    expect(withTrigger([done], "status", "Doing", "completed", null)).toEqual([
      done,
      { when: "status", is: "Doing", set: { completed: null } },
    ]);
  });
});
