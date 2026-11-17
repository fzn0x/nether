// What a button does when clicked: its actions in order through the app,
// stopped at the first that fails, and its links read as Meta Bind reads them.
import { type ButtonAction, readButton } from "@nether/automations";
import type { JsonValue, LinkTarget, NoteId } from "@nether/core";
import { describe, expect, it } from "vitest";
import { type ButtonHost, problemText, readLink, runActions } from "../src/buttons.ts";
import type { CommandRun, NoteRequest } from "../src/plugins/codeBlocks.ts";

const here = "note-here" as NoteId;
const other = "note-other" as NoteId;

/** A host that records what each action asked of it. */
function recording(commands: Readonly<Record<string, CommandRun>> = {}) {
  const done: string[] = [];
  const host: ButtonHost = {
    note: here,
    runCommand: (command) => {
      const run = commands[command] ?? "missing";
      if (run === "ran") done.push(`command ${command}`);
      return run;
    },
    createNote: (request: NoteRequest) => {
      done.push(`create ${JSON.stringify(request)}`);
      return Promise.resolve();
    },
    findNote: (name) => (name === "Projects/Alpha" ? other : undefined),
    setProperty: (note: NoteId, key: string, value: JsonValue) => {
      done.push(`set ${note} ${key} ${JSON.stringify(value)}`);
      return Promise.resolve();
    },
    openLink: (target: LinkTarget) => {
      done.push(`open ${JSON.stringify(target)}`);
    },
    openUrl: (url) => {
      done.push(`browse ${url}`);
    },
    wait: (ms) => {
      done.push(`wait ${String(ms)}`);
      return Promise.resolve();
    },
  };
  return { done, host };
}

function actionsOf(source: string): readonly ButtonAction[] {
  const read = readButton(source);
  if (!("button" in read)) throw new Error("Not a button");
  return read.button.actions;
}

describe("runActions", () => {
  it("runs each action in order through the app", async () => {
    const { done, host } = recording({ dayNote: "ran" });
    await runActions(
      actionsOf(
        [
          "label: All",
          "actions:",
          "  - type: command",
          "    command: dayNote",
          "  - type: updateMetadata",
          "    bindTarget: status",
          "    evaluate: false",
          "    value: Done",
          "  - type: updateMetadata",
          "    bindTarget: Projects/Alpha#count",
          "    value: 2",
          "  - type: sleep",
          "    ms: 5",
          "  - type: templaterCreateNote",
          "    templateFile: templates/Lecture.md",
          "    folderPath: Lectures",
          "    openNote: true",
          "  - type: open",
          '    link: "[[Other#Plan]]"',
          "  - type: open",
          "    link: https://example.com/",
        ].join("\n"),
      ),
      host,
    );
    expect(done).toEqual([
      "command dayNote",
      `set ${here} status "Done"`,
      `set ${other} count 2`,
      "wait 5",
      `create ${JSON.stringify({ folder: "Lectures", template: "templates/Lecture.md", open: true, openIfExists: false })}`,
      `open ${JSON.stringify({ title: "Other", heading: "Plan" })}`,
      "browse https://example.com/",
    ]);
  });

  it("stops at an action that fails, and says why", async () => {
    const { done, host } = recording({ busy: "unavailable" });
    const stopped = (source: string) =>
      runActions(actionsOf(`label: x\nactions:\n${source}`), host);
    await expect(stopped("  - type: command\n    command: nope")).rejects.toThrow(
      "Nether has no command nope.",
    );
    await expect(stopped("  - type: command\n    command: busy")).rejects.toThrow(
      "The command busy cannot run now.",
    );
    await expect(
      stopped("  - type: updateMetadata\n    bindTarget: Gone#x\n    value: 1"),
    ).rejects.toThrow("No note is named Gone.");
    await expect(
      stopped("  - type: open\n    link: '[[]]'\n  - type: sleep\n    ms: 1"),
    ).rejects.toThrow("This button's link cannot be opened: [[]]");
    expect(done).toEqual([]);
  });
});

describe("readLink", () => {
  it("reads a wiki link, a Markdown link, a web address or a note's name", () => {
    expect(readLink("[[Note|Shown]]")).toEqual({ note: { title: "Note" } });
    expect(readLink("![[Note#^abc]]")).toEqual({ note: { title: "Note", block: "abc" } });
    expect(readLink("[[#Plan]]")).toEqual({ note: { heading: "Plan" } });
    expect(readLink("[Site](https://example.com/a)")).toEqual({ url: "https://example.com/a" });
    expect(readLink("[Note](My%20Note.md)")).toEqual({ note: { title: "My Note.md" } });
    expect(readLink("[Bad](100%)")).toEqual({ note: { title: "100%" } });
    expect(readLink(" mailto:ada@example.com ")).toEqual({ url: "mailto:ada@example.com" });
    expect(readLink("Projects/Alpha")).toEqual({ note: { title: "Projects/Alpha" } });
    expect(readLink("[[]]")).toBeUndefined();
    expect(readLink("#Plan")).toBeUndefined();
  });
});

describe("problemText", () => {
  it("says why a block is not a button", () => {
    expect(problemText({ kind: "yaml", detail: "bad" })).toBe("This button cannot be read: bad");
    expect(problemText({ kind: "notMap" })).toContain("keys and their values");
    expect(problemText({ kind: "noLabel" })).toBe("This button has no label.");
    expect(problemText({ kind: "noAction" })).toBe("This button has no action.");
    expect(problemText({ kind: "badAction", action: "", field: "type" })).toBe(
      "Each of this button's actions needs a type.",
    );
    expect(problemText({ kind: "badAction", action: "command", field: "command" })).toBe(
      "This button's command action needs its command.",
    );
  });
});
