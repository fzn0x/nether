// Triggers on this device (ADR 0072): the changes the app tells of run the
// rules of a row's database, once, and what they write runs none; changes
// that arrive by sync or from another app's edit run nothing.
import { LinkGraph, indexNote } from "@nether/graph";
import { parseMarkdown } from "@nether/markdown";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { noteDocuments, whenLoaded } from "../src/noteDocuments.ts";
import { setDocumentProperties, documentProperties } from "@nether/editor";
import { type PropertyChange, PropertyChangeRegistry } from "../src/plugins/propertyChanges.ts";
import { databaseNoteOf, runTriggers } from "../src/triggers.ts";

const watching: AbortController[] = [];

afterEach(() => {
  for (const controller of watching.splice(0)) controller.abort();
});

// Friday, 6 November 2026, at 9:30 where the tests run.
const friday = new Date(2026, 10, 6, 9, 30);

const database = `---
database:
  properties:
    - key: status
      type: select
      options:
        - name: Doing
        - name: Done
    - key: stage
      type: text
    - key: completed
      type: date
    - key: archived
      type: checkbox
  views: []
  triggers:
    - when: status
      is: Done
      set:
        completed: "{{date}}"
        stage: Closed
    - when: stage
      is: Closed
      set:
        archived: true
---
`;

async function setUp(files: Record<string, string>) {
  const memory = new MemoryFiles(files);
  const vault = new Vault(memory, new MemoryStore());
  await vault.open();
  const controller = new AbortController();
  watching.push(controller);
  void vault.watch(controller.signal);
  const graph = new LinkGraph();
  for (const note of vault.notes()) {
    const parsed = parseMarkdown(files[note.path] ?? "");
    graph.set(note.id, note.path, indexNote(parsed, parsed.writtenIds));
  }
  const text = async (path: string) => (await memory.read(path)).text;
  const id = (path: string) => {
    const note = vault.noteAt(path);
    if (note === undefined) throw new Error(`No ${path}`);
    return note.id;
  };
  return { memory, vault, graph, text, id };
}

describe("PropertyChangeRegistry", () => {
  const change = (key: string): PropertyChange => ({
    vault: undefined as unknown as Vault,
    graph: new LinkGraph(),
    note: "note" as PropertyChange["note"],
    key,
    before: undefined,
    after: 1,
  });

  it("tells each plugin that watches, and says when one does", async () => {
    const changes = new PropertyChangeRegistry();
    const told: string[] = [];
    const listener = vi.fn();
    changes.subscribe(listener);
    expect(changes.watched()).toBe(false);
    const stop = changes.add("automations", (each) => {
      told.push(`automations ${each.key}`);
      return Promise.resolve();
    });
    expect(() => changes.add("automations", () => Promise.resolve())).toThrow(
      "The plugin automations watches already.",
    );
    expect(changes.watched()).toBe(true);
    await changes.changed(change("status"));
    expect(told).toEqual(["automations status"]);
    stop();
    expect(changes.watched()).toBe(false);
    await changes.changed(change("status"));
    expect(told).toEqual(["automations status"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("tells every watcher, then rejects with the first that failed", async () => {
    const changes = new PropertyChangeRegistry();
    const told: string[] = [];
    changes.add("a", () => Promise.reject(new Error("a failed")));
    changes.add("b", () => {
      told.push("b");
      return Promise.resolve();
    });
    await expect(changes.changed(change("x"))).rejects.toThrow("a failed");
    expect(told).toEqual(["b"]);
  });

  it("tells of each property that differs between two lists, one after another", async () => {
    const changes = new PropertyChangeRegistry();
    const told: unknown[] = [];
    changes.add("a", ({ key, before, after }) => {
      told.push([key, before, after]);
      return Promise.resolve();
    });
    await changes.changedFrom(
      { vault: undefined as unknown as Vault, graph: new LinkGraph(), note: change("").note },
      [
        { key: "status", value: "Doing" },
        { key: "kept", value: [1] },
        { key: "gone", value: "x" },
      ],
      [
        { key: "status", value: "Done" },
        { key: "kept", value: [1] },
        { key: "new", value: null },
      ],
    );
    expect(told).toEqual([
      ["status", "Doing", "Done"],
      ["gone", "x", undefined],
      ["new", undefined, null],
    ]);
  });
});

describe("runTriggers", () => {
  it("finds a row's database beside its folder, whatever its case", async () => {
    const { vault } = await setUp({
      "Projects.md": database,
      "projects/Launch.md": "",
      "Top.md": "",
    });
    expect(databaseNoteOf(vault, "projects/Launch.md")?.path).toBe("Projects.md");
    expect(databaseNoteOf(vault, "Top.md")).toBeUndefined();
    expect(databaseNoteOf(vault, "Elsewhere/Note.md")).toBeUndefined();
  });

  it("sets what a change into a rule's value sets, once, and runs no rule on what it set", async () => {
    const { vault, graph, text, id } = await setUp({
      "Projects.md": database,
      "Projects/Launch.md": "---\nstatus: Done\n---\n\nThe launch.\n",
    });
    const note = id("Projects/Launch.md");
    await runTriggers(
      { vault, graph, note, key: "status", before: "Doing", after: "Done" },
      friday,
    );
    // The stage rule does not run on what the first rule set: archived stays unset.
    await vi.waitFor(async () => {
      expect(await text("Projects/Launch.md")).toBe(
        "---\nstatus: Done\ncompleted: 2026-11-06\nstage: Closed\n---\n\nThe launch.\n",
      );
    });
  });

  it("runs the rules that are right beside one that names a property the database has not", async () => {
    const stale = database.replace(
      "  triggers:\n",
      "  triggers:\n    - when: Gone\n      is: Done\n      set:\n        archived: true\n",
    );
    const { vault, graph, text, id } = await setUp({
      "Projects.md": stale,
      "Projects/Launch.md": "---\nstatus: Done\n---\n",
    });
    await runTriggers(
      {
        vault,
        graph,
        note: id("Projects/Launch.md"),
        key: "status",
        before: "Doing",
        after: "Done",
      },
      friday,
    );
    await vi.waitFor(async () => {
      expect(await text("Projects/Launch.md")).toBe(
        "---\nstatus: Done\ncompleted: 2026-11-06\nstage: Closed\n---\n",
      );
    });
  });

  it("sets nothing for a change that stays, one of another note, or of a database it cannot read", async () => {
    const { vault, graph, text, id } = await setUp({
      "Projects.md": database,
      "Projects/Launch.md": "---\nstatus: Done\n---\n",
      "Ideas.md": "---\nstatus: x\n---\n",
      "Ideas/One.md": "---\nstatus: Done\n---\n",
      "Broken.md": "---\ndatabase:\n  properties: 3\n---\n",
      "Broken/Row.md": "---\nstatus: Done\n---\n",
      "Loose.md": "---\nstatus: Done\n---\n",
    });
    for (const [path, before] of [
      ["Projects/Launch.md", "Done"],
      ["Ideas/One.md", "Doing"],
      ["Broken/Row.md", "Doing"],
      ["Loose.md", "Doing"],
    ] as const) {
      await runTriggers(
        { vault, graph, note: id(path), key: "status", before, after: "Done" },
        friday,
      );
    }
    await runTriggers(
      { vault, graph, note: id("Projects/Launch.md"), key: "stage", before: "a", after: "b" },
      friday,
    );
    expect(await text("Projects/Launch.md")).toBe("---\nstatus: Done\n---\n");
    expect(await text("Ideas/One.md")).toBe("---\nstatus: Done\n---\n");
    expect(await text("Broken/Row.md")).toBe("---\nstatus: Done\n---\n");
    expect(await text("Loose.md")).toBe("---\nstatus: Done\n---\n");
  });

  it("runs for the app's changes only: not for a change by sync, nor another app's edit", async () => {
    const { memory, vault, graph, text, id } = await setUp({
      "Projects.md": database,
      "Projects/Launch.md": "---\nstatus: Doing\n---\n",
      "Projects/Site.md": "---\nstatus: Doing\n---\n",
    });
    const changes = new PropertyChangeRegistry();
    const ran: string[] = [];
    changes.add("automations", async (change) => {
      ran.push(change.key);
      await runTriggers(change, friday);
    });

    // Another app, such as Obsidian, edits the file.
    memory.edit("Projects/Launch.md", "---\nstatus: Done\n---\n");
    // A change arrives by sync, into the note's document.
    const site = id("Projects/Site.md");
    const hold = noteDocuments(vault).open(site);
    await whenLoaded(hold.note);
    const { state } = hold.note.snapshot;
    if (state.status !== "ready") throw new Error("Site.md is not ready");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(state.document));
    setDocumentProperties(
      remote,
      documentProperties(remote).map((entry) =>
        entry.key === "status" ? { key: "status", value: "Done" } : entry,
      ),
    );
    Y.applyUpdate(state.document, Y.encodeStateAsUpdate(remote), "sync");
    hold.release();
    await vi.waitFor(async () => {
      expect(await text("Projects/Site.md")).toBe("---\nstatus: Done\n---\n");
    });
    await vi.waitFor(() => {
      expect(vault.note(id("Projects/Launch.md"))).toBeDefined();
    });
    expect(ran).toEqual([]);
    expect(await text("Projects/Launch.md")).toBe("---\nstatus: Done\n---\n");

    // The app's own change, told, runs the rules.
    await changes.changed({
      vault,
      graph,
      note: site,
      key: "status",
      before: "Doing",
      after: "Done",
    });
    expect(ran).toEqual(["status"]);
    await vi.waitFor(async () => {
      expect(await text("Projects/Site.md")).toBe(
        "---\nstatus: Done\ncompleted: 2026-11-06\nstage: Closed\n---\n",
      );
    });
  });
});
