import { describe, expect, it } from "vitest";
import { longestSleep, readBindTarget, readButton, readLiteral } from "../src/index.ts";

describe("buttons, as Meta Bind writes them", () => {
  it("reads a button with one action, as Meta Bind's docs show it", () => {
    expect(
      readButton(
        [
          "style: primary",
          "label: Create Note",
          "action:",
          "  type: createNote",
          '  folderPath: "My Folder"',
          '  fileName: "New Note"',
          "  openNote: false",
        ].join("\n"),
      ),
    ).toEqual({
      button: {
        label: "Create Note",
        style: "primary",
        hidden: false,
        actions: [
          {
            type: "createNote",
            fileName: "New Note",
            folderPath: "My Folder",
            openNote: false,
            openIfAlreadyExists: false,
          },
        ],
        unsupported: [],
      },
    });
  });

  it("reads every action Nether runs, in order", () => {
    const read = readButton(
      [
        "label: Do it all",
        "tooltip: Every action",
        "id: all",
        "hidden: true",
        "style: nonsense",
        "actions:",
        "  - type: command",
        "    command: dayNote",
        "  - type: templaterCreateNote",
        '    templateFile: "templates/Lecture Template.md"',
        "    folderPath: Lectures",
        "    openNote: true",
        "    openIfAlreadyExists: true",
        "  - type: updateMetadata",
        "    bindTarget: count",
        "    evaluate: false",
        "    value: 0",
        "  - type: updateMetadata",
        "    bindTarget: frontmatter^Projects/Alpha#status",
        "    value: Done",
        "  - type: open",
        '    link: "[[Other Note]]"',
        "    newTab: true",
        "  - type: sleep",
        "    ms: 99999",
      ].join("\n"),
    );
    expect(read).toEqual({
      button: {
        label: "Do it all",
        style: "default",
        tooltip: "Every action",
        id: "all",
        hidden: true,
        actions: [
          { type: "command", command: "dayNote" },
          {
            type: "createNote",
            folderPath: "Lectures",
            templateFile: "templates/Lecture Template.md",
            openNote: true,
            openIfAlreadyExists: true,
          },
          { type: "updateMetadata", target: { property: "count" }, value: 0 },
          {
            type: "updateMetadata",
            target: { note: "Projects/Alpha", property: "status" },
            value: "Done",
          },
          { type: "open", link: "[[Other Note]]", newTab: true },
          { type: "sleep", ms: longestSleep },
        ],
        unsupported: [],
      },
    });
  });

  it("names what Nether does not run: code, input, edits of the note's text, unknown types", () => {
    const read = readButton(
      [
        "label: Run Custom JS",
        "actions:",
        "  - type: command",
        "    command: dayNote",
        "  - type: js",
        "    file: testJsFile.js",
        "  - type: updateMetadata",
        "    bindTarget: count",
        "    evaluate: true",
        '    value: "x + 1"',
        "  - type: insertIntoNote",
        "    line: 1",
        "    value: Hello",
        "  - type: somethingNew",
        "  - notAType: 1",
      ].join("\n"),
    );
    expect(read).toMatchObject({
      button: {
        unsupported: ["js", "updateMetadata with evaluate", "insertIntoNote", "somethingNew", "?"],
      },
    });
  });

  it("says why a block is not a button", () => {
    expect(readButton("label: [unclosed")).toMatchObject({ problem: { kind: "yaml" } });
    expect(readButton("- a list")).toEqual({ problem: { kind: "notMap" } });
    expect(readButton("style: primary\naction:\n  type: command\n  command: x")).toEqual({
      problem: { kind: "noLabel" },
    });
    expect(readButton("label: Nothing")).toEqual({ problem: { kind: "noAction" } });
    expect(readButton("label: Empty\nactions: []")).toEqual({ problem: { kind: "noAction" } });
    expect(readButton("label: Bad\naction:\n  type: command")).toEqual({
      problem: { kind: "badAction", action: "command", field: "command" },
    });
    expect(readButton("label: Bad\naction:\n  type: createNote")).toEqual({
      problem: { kind: "badAction", action: "createNote", field: "fileName" },
    });
    expect(readButton("label: Bad\naction:\n  type: templaterCreateNote")).toEqual({
      problem: { kind: "badAction", action: "templaterCreateNote", field: "templateFile" },
    });
    expect(
      readButton("label: Bad\naction:\n  type: updateMetadata\n  bindTarget: memory^x\n  value: 1"),
    ).toEqual({ problem: { kind: "badAction", action: "updateMetadata", field: "bindTarget" } });
    expect(readButton("label: Bad\naction:\n  type: open")).toEqual({
      problem: { kind: "badAction", action: "open", field: "link" },
    });
    expect(readButton("label: Bad\naction:\n  type: sleep\n  ms: soon")).toEqual({
      problem: { kind: "badAction", action: "sleep", field: "ms" },
    });
    expect(readButton("label: Bad\naction: just text")).toEqual({
      problem: { kind: "badAction", action: "", field: "type" },
    });
  });

  it("reads a bind target as Meta Bind writes one, and not its memory or nested properties", () => {
    expect(readBindTarget("status")).toEqual({ property: "status" });
    expect(readBindTarget(" Task A#completed ")).toEqual({ note: "Task A", property: "completed" });
    expect(readBindTarget('path/to/Task A#["is completed"]')).toEqual({
      note: "path/to/Task A",
      property: "is completed",
    });
    expect(readBindTarget("frontmatter^status")).toEqual({ property: "status" });
    expect(readBindTarget("memory^Note#x")).toBeUndefined();
    expect(readBindTarget("globalMemory^x")).toBeUndefined();
    expect(readBindTarget("this.is.nested")).toBeUndefined();
    expect(readBindTarget("#status")).toBeUndefined();
    expect(readBindTarget("Note#")).toBeUndefined();
  });

  it("reads a value as Meta Bind reads a literal, and keeps YAML's own values", () => {
    expect(readLiteral("NULL")).toBeNull();
    expect(readLiteral("true")).toBe(true);
    expect(readLiteral("false")).toBe(false);
    expect(readLiteral("-1.5")).toBe(-1.5);
    expect(readLiteral("Done")).toBe("Done");
    expect(readLiteral("True")).toBe("True");
    expect(readLiteral(3)).toBe(3);
    expect(readLiteral(false)).toBe(false);
    expect(readLiteral(["a", 1])).toEqual(["a", 1]);
    expect(readLiteral(undefined)).toBeNull();
  });
});
