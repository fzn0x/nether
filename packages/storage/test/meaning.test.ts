// Passages for search by meaning, in memory and in SQLite alike: kept by
// note with the file they were made from, replaced whole, read back by ID
// and their signs a page at a time, and forgotten by note or all at once.
import type { NoteId } from "@nether/core";
import { describe, expect, it } from "vitest";
import { type IndexStore, type MeaningPassage, MemoryStore, SqliteStore } from "../src/index.ts";
import { nodeDatabase } from "./node-database.ts";

const id = (name: string) => name as NoteId;

const stores: [string, () => Promise<IndexStore>][] = [
  ["MemoryStore", () => Promise.resolve(new MemoryStore())],
  ["SqliteStore", () => SqliteStore.open(nodeDatabase())],
];

function passage(ordinal: number, text: string): MeaningPassage {
  return {
    ordinal,
    heading: ordinal === 0 ? "" : `Part ${String(ordinal)}`,
    hash: `hash-${text}`,
    preview: text,
    scale: 0.5 + ordinal,
    vector: new Uint8Array([ordinal, 255 - ordinal, 128]),
    signs: new Uint8Array([ordinal]),
  };
}

describe.each(stores)("%s passages", (_name, open) => {
  it("keeps a note's passages with the file they were made from", async () => {
    const store = await open();
    await store.putPassages({ note: id("a"), size: 10, modified: 100 }, [
      passage(0, "first"),
      passage(1, "second"),
    ]);
    expect(await store.meaningFiles()).toEqual([{ note: "a", size: 10, modified: 100 }]);
    const kept = await store.notePassages(id("a"));
    expect(kept.map((each) => [each.note, each.ordinal, each.heading, each.preview])).toEqual([
      ["a", 0, "", "first"],
      ["a", 1, "Part 1", "second"],
    ]);
    expect(kept[1]?.scale).toBe(1.5);
    expect([...(kept[1]?.vector ?? [])]).toEqual([1, 254, 128]);
    expect([...(kept[1]?.signs ?? [])]).toEqual([1]);
    expect(await store.notePassages(id("none"))).toEqual([]);
  });

  it("replaces a note's passages whole, and its file", async () => {
    const store = await open();
    await store.putPassages({ note: id("a"), size: 10, modified: 100 }, [
      passage(0, "old"),
      passage(1, "older"),
    ]);
    await store.putPassages({ note: id("a"), size: 12, modified: 200 }, [passage(0, "new")]);
    expect(await store.meaningFiles()).toEqual([{ note: "a", size: 12, modified: 200 }]);
    expect((await store.notePassages(id("a"))).map((each) => each.preview)).toEqual(["new"]);
    // A note with no passages left is still known, by the file it was read from.
    await store.putPassages({ note: id("a"), size: 0, modified: 300 }, []);
    expect(await store.notePassages(id("a"))).toEqual([]);
    expect(await store.meaningFiles()).toEqual([{ note: "a", size: 0, modified: 300 }]);
  });

  it("gives every passage's signs a page at a time, and passages by ID", async () => {
    const store = await open();
    await store.putPassages({ note: id("a"), size: 1, modified: 1 }, [
      passage(0, "a0"),
      passage(1, "a1"),
    ]);
    await store.putPassages({ note: id("b"), size: 1, modified: 1 }, [passage(2, "b2")]);
    const first = await store.passageSigns(0, 2);
    expect(first).toHaveLength(2);
    const rest = await store.passageSigns(first.at(-1)?.id ?? 0, 2);
    expect(rest).toHaveLength(1);
    const ids = [...first, ...rest].map((each) => each.id);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect([...(rest[0]?.signs ?? [])]).toEqual([2]);

    const found = await store.passagesById([ids[2] ?? 0, ids[0] ?? 0, 99_999]);
    expect(found.map((each) => each.preview).sort()).toEqual(["a0", "b2"]);
  });

  it("forgets notes' passages, or every one", async () => {
    const store = await open();
    await store.putPassages({ note: id("a"), size: 1, modified: 1 }, [passage(0, "a")]);
    await store.putPassages({ note: id("b"), size: 1, modified: 1 }, [passage(0, "b")]);
    await store.deletePassages([id("a")]);
    expect((await store.meaningFiles()).map((file) => file.note)).toEqual(["b"]);
    expect(await store.notePassages(id("a"))).toEqual([]);
    await store.clearPassages();
    expect(await store.meaningFiles()).toEqual([]);
    expect(await store.passageSigns(0, 10)).toEqual([]);
  });
});
