// What a note's menu does: a copy beside it, its full path on disk, the
// vault's folders, and its tags, read and written in its frontmatter.
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buttonNotePath,
  cleanTag,
  copyNote,
  freeNotePath,
  fullPath,
  noteTags,
  setNoteTags,
  setNoteValue,
  tagsOf,
  vaultFolders,
  withProperty,
  withTags,
} from "../src/noteActions.ts";

const watching: AbortController[] = [];

afterEach(() => {
  for (const controller of watching.splice(0)) controller.abort();
});

async function openVault(files: Record<string, string>) {
  const memory = new MemoryFiles(files);
  const vault = new Vault(memory, new MemoryStore());
  await vault.open();
  const controller = new AbortController();
  watching.push(controller);
  void vault.watch(controller.signal);
  return { memory, vault };
}

describe("copyNote", () => {
  it("copies a note beside it under the next free name", async () => {
    const { memory, vault } = await openVault({
      "Projects/Plan.md": "---\ntags: [work]\n---\n\n# Plan\n",
      "Projects/Plan 2.md": "taken",
    });
    const id = vault.noteAt("Projects/Plan.md")?.id;
    if (id === undefined) throw new Error("No Plan.md");
    const copy = await copyNote(vault, id);
    expect(copy.path).toBe("Projects/Plan 3.md");
    expect(copy.id).not.toBe(id);
    expect((await memory.read("Projects/Plan 3.md")).text).toBe(
      "---\ntags: [work]\n---\n\n# Plan\n",
    );
  });
});

describe("fullPath", () => {
  it("joins the vault's folder and a note's path as the system writes paths", () => {
    expect(fullPath("C:\\Users\\Ada\\Notes", "Projects/Plan.md")).toBe(
      "C:\\Users\\Ada\\Notes\\Projects\\Plan.md",
    );
    expect(fullPath("/home/ada/Notes/", "Projects/Plan.md")).toBe(
      "/home/ada/Notes/Projects/Plan.md",
    );
  });
});

describe("vaultFolders", () => {
  it("lists every folder once, the top first, with the folders that only hold folders", () => {
    expect(vaultFolders(["Welcome.md", "a/b/c/Note.md", "a/x.png", "z/Other.md"])).toEqual([
      "",
      "a",
      "a/b",
      "a/b/c",
      "z",
    ]);
  });
});

describe("tags in frontmatter", () => {
  it("reads a list, or one string of tags, without the #", () => {
    expect(tagsOf(["work", "#home", 3])).toEqual(["work", "home"]);
    expect(tagsOf("work, #home area/project")).toEqual(["work", "home", "area/project"]);
    expect(tagsOf(undefined)).toEqual([]);
  });

  it("keeps a typed tag as frontmatter does: no #, and dashes for spaces", () => {
    expect(cleanTag("  #to read ")).toBe("to-read");
    expect(cleanTag("area/project")).toBe("area/project");
  });

  it("sets the tags under the key the note uses, and removes the key for none", () => {
    const entries = [
      { key: "status", value: "draft" },
      { key: "Tags", value: ["old"] },
    ];
    expect(withTags(entries, ["new"])).toEqual([
      { key: "status", value: "draft" },
      { key: "Tags", value: ["new"] },
    ]);
    expect(withTags(entries, [])).toEqual([{ key: "status", value: "draft" }]);
    expect(withTags([{ key: "status", value: "draft" }], ["a"])).toEqual([
      { key: "status", value: "draft" },
      { key: "tags", value: ["a"] },
    ]);
  });

  it("are read from and written to a note's file through its document", async () => {
    const { memory, vault } = await openVault({
      "Plan.md": "---\nstatus: draft\ntags: [work]\n---\n\n# Plan\n",
    });
    const id = vault.noteAt("Plan.md")?.id;
    if (id === undefined) throw new Error("No Plan.md");
    expect(await noteTags(vault, id)).toEqual(["work"]);
    await setNoteTags(vault, id, ["work", "area/project"]);
    await vi.waitFor(async () => {
      expect((await memory.read("Plan.md")).text).toBe(
        "---\nstatus: draft\ntags: [work, area/project]\n---\n\n# Plan\n",
      );
    });
  });
});

describe("what a button sets and makes", () => {
  it("sets a property in its place, or last when it is new", () => {
    const entries = [
      { key: "status", value: "draft" },
      { key: "due", value: "2026-11-20" },
    ];
    expect(withProperty(entries, "status", "Done")).toEqual([
      { key: "status", value: "Done" },
      { key: "due", value: "2026-11-20" },
    ]);
    expect(withProperty(entries, "count", 1)).toEqual([...entries, { key: "count", value: 1 }]);
  });

  it("writes a property to a note's file through its document", async () => {
    const { memory, vault } = await openVault({
      "Task.md": "---\nstatus: draft\n---\n\nText\n",
    });
    const id = vault.noteAt("Task.md")?.id;
    if (id === undefined) throw new Error("No Task.md");
    await setNoteValue(vault, id, "status", "Done");
    await setNoteValue(vault, id, "done", true);
    await vi.waitFor(async () => {
      expect((await memory.read("Task.md")).text).toBe(
        "---\nstatus: Done\ndone: true\n---\n\nText\n",
      );
    });
  });

  it("makes a note in the folder it names, and nowhere hidden or above the vault", () => {
    expect(buttonNotePath("My Folder", "New Note")).toBe("My Folder/New Note.md");
    expect(buttonNotePath("/", "New Note.md")).toBe("New Note.md");
    expect(buttonNotePath(" a/b/ ", "c/Note")).toBe("a/b/c/Note.md");
    expect(buttonNotePath("", "")).toBeUndefined();
    expect(buttonNotePath(".nether", "x")).toBeUndefined();
    expect(buttonNotePath("a", "../x")).toBeUndefined();
    expect(buttonNotePath("a", "b\\..\\x")).toBeUndefined();
  });

  it("numbers a note's name when a file has it", async () => {
    const { vault } = await openVault({ "Note.md": "", "Note 2.md": "" });
    expect(freeNotePath(vault, "Note.md")).toBe("Note 3.md");
    expect(freeNotePath(vault, "Other.md")).toBe("Other.md");
  });
});
