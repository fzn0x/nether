// Asking your notes: the words a question is searched by, the notes found
// by each word's search and by meaning, fused by rank, and the passages cut
// under headings and chosen within the limits, each opening at a block the
// note's document has.
import { type BlockId, type ContentBlock, type NoteId, newBlockId } from "@nether/core";
import { documentBlocks } from "@nether/editor";
import { plainText } from "@nether/graph";
import { parseMarkdown } from "@nether/markdown";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  askLimits,
  choosePassages,
  conversationNote,
  findNotes,
  keywordsOf,
  passagesOf,
  retrieve,
} from "../src/askNotes.ts";
import { noteDocuments, whenLoaded } from "../src/noteDocuments.ts";

const files: Record<string, string> = {
  "Launch plan.md":
    "# Launch plan\n\nThe launch is on 12 May.\n\n## Party\n\nA party after the launch, at Mia's.\n",
  "Party ideas.md": "Balloons, and a cake for the party.\n",
  "Groceries.md": "Milk and bread.\n",
};

async function setUp() {
  const store = new MemoryStore();
  const vault = new Vault(new MemoryFiles(files), store);
  await vault.open();
  for (const note of vault.notes()) {
    const parsed = parseMarkdown(files[note.path] ?? "");
    await store.putNoteTexts([
      { note: note.id, title: note.title, body: plainText(parsed.content) },
    ]);
  }
  const id = (title: string): NoteId => {
    const found = vault.notes().find((note) => note.title === title);
    if (found === undefined) throw new Error(`No note ${title}`);
    return found.id;
  };
  return { vault, id };
}

const paragraph = (id: string, text: string): ContentBlock => ({
  id: id as BlockId,
  type: "paragraph",
  content: [{ type: "text", text }],
});

const heading = (id: string, text: string): ContentBlock => ({
  id: id as BlockId,
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});

describe("asking your notes", () => {
  it("searches by a question's words, the common ones aside", () => {
    expect(keywordsOf("When is the launch party, and what about the CAFÉ?")).toEqual([
      "launch",
      "party",
      "cafe",
    ]);
    expect(keywordsOf("a b c")).toEqual([]);
    expect(keywordsOf("one two three four five six seven eight nine ten")).toHaveLength(8);
  });

  it("finds the notes with more of the words first, and those search by meaning adds", async () => {
    const { vault, id } = await setUp();
    const found = await findNotes(vault, "When is the launch party?");
    expect(found.notes).toEqual([id("Launch plan"), id("Party ideas")]);
    // By meaning, a note with none of the words joins them.
    const meaning = (_question: string, limit: number) => {
      expect(limit).toBe(askLimits.notes * 2);
      return Promise.resolve([{ note: id("Groceries"), heading: undefined }]);
    };
    const both = await findNotes(vault, "When is the launch party?", meaning);
    expect(both.notes).toContain(id("Groceries"));
    expect(both.meaning.get(id("Groceries"))).toEqual({
      note: id("Groceries"),
      heading: undefined,
    });
    expect((await findNotes(vault, "the of and")).notes).toEqual([]);
  });

  it("cuts a note into passages under its headings, each opening at its first block", () => {
    const long = "word ".repeat(200).trim();
    const passages = passagesOf("n" as NoteId, "Plan", [
      paragraph("p1", "Before any heading."),
      heading("h1", "Dates"),
      paragraph("p2", "The launch is on 12 May."),
      paragraph("p3", long),
      paragraph("empty", ""),
      heading("h2", "Party"),
      paragraph("p4", "At Mia's."),
    ]);
    expect(passages.map((each) => [each.heading, each.part, each.text.slice(0, 30)])).toEqual([
      [undefined, { block: "p1" }, "Before any heading."],
      ["Dates", { block: "h1" }, "Dates\nThe launch is on 12 May."],
      ["Dates", { block: "p3" }, long.slice(0, 30)],
      ["Party", { block: "h2" }, "Party\nAt Mia's."],
    ]);
    // A block longer than a passage is cut, marked so.
    expect(passages[2]?.text.endsWith("…")).toBe(true);
    expect(passages[2]?.text.length).toBe(askLimits.length + 1);
  });

  it("chooses each note's best passages, within the limits", () => {
    const note = (name: string, count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        note: name as NoteId,
        title: name,
        heading: undefined,
        part: { block: `${name}-${String(index)}` },
        text: index === 1 ? "launch day" : `other text ${String(index)}`,
      }));
    const chosen = choosePassages([note("a", 3), note("b", 3), note("c", 1)], "launch");
    // Each note's passage with the word; one with none gives its first.
    expect(chosen.map((each) => each.part.block)).toEqual(["a-1", "b-1", "c-0"]);
    const many = Array.from({ length: 12 }, (_value, index) => note(`n${String(index)}`, 2));
    expect(choosePassages(many, "launch")).toHaveLength(askLimits.passages);
    const big = Array.from({ length: 3 }, (_value, index) => [
      { ...note(`big${String(index)}`, 1)[0], text: "launch ".repeat(400) } as never,
    ]);
    expect(choosePassages(big, "launch").length).toBeLessThan(3);
    // The heading search by meaning named is preferred.
    const named = [
      { ...note("m", 1)[0], heading: "Elsewhere", text: "nothing" },
      { ...note("m", 1)[0], heading: "Here", text: "nothing", part: { block: "m-here" } },
    ] as never[];
    expect(
      choosePassages(
        [named],
        "launch",
        new Map([["m" as NoteId, { note: "m" as NoteId, heading: "Here" }]]),
      )[0]?.part,
    ).toEqual({ block: "m-here" });
  });

  it("writes a conversation as a note, each citation a link, the unverified as they came", () => {
    const passages = [
      {
        note: "n1" as NoteId,
        title: "Launch plan",
        heading: "Party",
        part: { block: "b1" },
        text: "A party after the launch.",
      },
      {
        note: "n2" as NoteId,
        title: "Party ideas",
        heading: undefined,
        part: { block: "b2" },
        text: "Balloons.",
      },
    ];
    const titles: Record<string, string> = { n1: "Launch plan", n2: "Party ideas" };
    const text = conversationNote(
      [
        {
          question: "What about the party?",
          answer:
            "A party after the launch [1], with balloons [2], in [[Party ideas]]; and cake [5] from [[Nowhere]].",
          passages,
          status: "done",
        },
        { question: "Nothing here?", answer: "", passages: [], status: "empty" },
      ],
      (note) => titles[note],
    );
    expect(text).toBe(
      [
        "## What about the party?",
        "",
        "A party after the launch [[Launch plan#Party|1]], with balloons [[Party ideas|2]], in [[Party ideas]]; and cake [5] from Nowhere.",
        "",
        "### Sources",
        "",
        "1. [[Launch plan#Party]]",
        "2. [[Party ideas]]",
        "",
      ].join("\n"),
    );
  });

  it("retrieves passages whose blocks are the note's document's own", async () => {
    const { vault, id } = await setUp();
    const passages = await retrieve(vault, "When is the launch party?");
    expect(passages.map((each) => [each.title, each.heading])).toEqual([
      ["Launch plan", "Launch plan"],
      ["Launch plan", "Party"],
      ["Party ideas", undefined],
    ]);
    const hold = noteDocuments(vault).open(id("Launch plan"));
    await whenLoaded(hold.note);
    const state = hold.note.snapshot.state;
    if (state.status !== "ready") throw new Error("not ready");
    const ids = documentBlocks(state.document, newBlockId).map((block) => block.id);
    hold.release();
    expect(ids).toContain(passages[0]?.part.block);
    expect(ids).toContain(passages[1]?.part.block);
  });
});
