// A database's rules as its properties change: renamed in every rule that
// names a renamed property, and dropped where a deleted one leaves a rule
// with nothing to watch or set. Rules kept and not run follow, and are
// written back as they were.
import type { DatabaseSchema } from "@nether/core";
import { describe, expect, it } from "vitest";
import { deleteFromTriggers, readDatabase, renameInTriggers, writeDatabase } from "../src/index.ts";

const properties = [
  { key: "Status", type: "select", options: [{ name: "Done" }] },
  { key: "Completed", type: "date" },
  { key: "Stage", type: "text" },
];

const read = (triggers: unknown): DatabaseSchema =>
  readDatabase({ properties, views: [], triggers }, () => undefined);

describe("rules as properties change", () => {
  it("rename a property in every rule that names it, and in rules kept that do not run", () => {
    const schema = read([
      { when: "Status", is: "Done", set: { Completed: "{{date}}", Stage: "Closed" } },
      { when: "Stage", is: "Closed", set: { Status: "Done" } },
      { when: "Gone", is: 1, set: { Status: "x" } },
      "not a rule",
    ]);
    const renamed = renameInTriggers(schema, "Status", "State");
    expect(renamed.properties).toBe(schema.properties);
    expect(renamed.triggers).toEqual([
      { when: "State", is: "Done", set: { Completed: "{{date}}", Stage: "Closed" } },
      { when: "Stage", is: "Closed", set: { State: "Done" } },
    ]);
    expect(renamed.skippedTriggers?.map((rule) => rule.value)).toEqual([
      { when: "Gone", is: 1, set: { State: "x" } },
      "not a rule",
    ]);
    // A rule kept and not run becomes one that runs, once its property is there.
    const stale = read([{ when: "Gone", is: 1, set: { Stage: "x" } }]);
    const written = writeDatabase(renameInTriggers(stale, "Gone", "Stage"), () => "") as {
      readonly triggers: unknown;
    };
    expect(read(written.triggers).triggers).toEqual([
      { when: "Stage", is: 1, set: { Stage: "x" } },
    ]);
  });

  it("drop a deleted property from what rules set, with a rule on it or left setting nothing", () => {
    const schema = read([
      { when: "Status", is: "Done", set: { Completed: "{{date}}", Stage: "Closed" } },
      { when: "Stage", is: "Closed", set: { Completed: null } },
      { when: "Status", is: "Doing", set: { Stage: "Open" } },
      { when: "Gone", is: 1, set: { Stage: "x" } },
      { when: "Gone", is: 2, set: { Completed: "y" } },
    ]);
    const deleted = deleteFromTriggers(schema, "Stage");
    expect(deleted.triggers).toEqual([
      { when: "Status", is: "Done", set: { Completed: "{{date}}" } },
    ]);
    expect(deleted.skippedTriggers?.map((rule) => rule.value)).toEqual([
      { when: "Gone", is: 2, set: { Completed: "y" } },
    ]);
    // With no rules left, none are written.
    const none = deleteFromTriggers(deleteFromTriggers(deleted, "Completed"), "Gone");
    expect(none).toEqual({ properties: schema.properties, views: [] });
    expect(writeDatabase(none, () => "")).toEqual({ properties, views: [] });
  });

  it("write rules that do not run after those that do, as they were written", () => {
    const schema = read([
      { when: "Gone", is: 1, set: { Stage: "x" } },
      { when: "Status", is: "Done", set: { Completed: "{{date}}" } },
    ]);
    expect(writeDatabase(schema, () => "")).toEqual({
      properties,
      views: [],
      triggers: [
        { when: "Status", is: "Done", set: { Completed: "{{date}}" } },
        { when: "Gone", is: 1, set: { Stage: "x" } },
      ],
    });
  });
});
