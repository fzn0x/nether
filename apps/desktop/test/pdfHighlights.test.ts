// A PDF's highlights in the vault (ADR 0061): found by their links, in
// whatever notes hold them; added to the note that holds most, or to a
// new one beside the PDF; commented on and removed in their note.
import type { BlockId, NoteId } from "@nether/core";
import { LinkGraph, indexNote } from "@nether/graph";
import { parseMarkdown } from "@nether/markdown";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  addPdfHighlight,
  highlightLink,
  highlightedPassage,
  highlightsHome,
  highlightsNotePath,
  notesWithPassages,
  readPdfMarks,
  removePdfHighlight,
  setHighlightColor,
  setHighlightComment,
} from "../src/pdfHighlights.ts";

const passage = (page: number, begin: number) => ({
  page,
  selection: { beginIndex: begin, beginOffset: 0, endIndex: begin, endOffset: 4 },
});

async function setUp(extra: Readonly<Record<string, string>> = {}) {
  const files: Record<string, string> = {
    "Papers/paper.pdf": "%PDF-1.4",
    "Other/paper.pdf": "%PDF-1.4",
    "Papers/paper highlights.md": `> [!quote] [[paper.pdf#page=2&selection=1,0,1,4|paper, page 2]]
> Four

^aaa111

> [!quote] [[paper.pdf#page=1&selection=0,0,0,4|paper, page 1]]
> Once

^bbb222
`,
    "Essay.md": `As read in [[Papers/paper.pdf#page=3&selection=2,0,2,4|paper, page 3]].

> [!quote] [[Papers/paper.pdf#page=3&selection=2,0,2,4|paper, page 3]]
> Here

^ccc333

> [!quote] [[Other/paper.pdf#page=1&selection=0,0,0,4]]
> Elsewhere

^ddd444
`,
    "Plain.md": "Links [[Papers/paper.pdf#page=4]] to a page only.",
    ...extra,
  };
  const vault = new Vault(new MemoryFiles(files), new MemoryStore());
  await vault.open();
  const graph = new LinkGraph();
  const index = async () => {
    for (const note of vault.notes()) {
      const file = await vault.read(note.id);
      const parsed = parseMarkdown(file.text);
      graph.set(note.id, note.path, indexNote(parsed, parsed.writtenIds));
    }
  };
  await index();
  const id = (path: string): NoteId => {
    const note = vault.noteAt(path);
    if (note === undefined) throw new Error(`${path} is not in the vault.`);
    return note.id;
  };
  const text = async (path: string) => (await vault.read(id(path))).text;
  return { vault, graph, index, id, text };
}

describe("a PDF's highlights", () => {
  it("are the callouts of any note whose link finds the PDF, notes in path order", async () => {
    const { vault, graph, id } = await setUp();
    const notes = notesWithPassages(vault, graph, "Papers/paper.pdf");
    expect(notes.sort()).toEqual([id("Essay.md"), id("Papers/paper highlights.md")].sort());
    const { highlights: found, links } = await readPdfMarks(vault, notes, "Papers/paper.pdf");
    expect(found.map(({ highlight }) => [highlight.id, highlight.words])).toEqual([
      ["ccc333", "Here"],
      ["aaa111", "Four"],
      ["bbb222", "Once"],
    ]);
    // Its other links to a passage: the prose of a note, not the highlights' titles.
    expect(links.map(({ link, written }) => [link.passage.page, link.words, written])).toEqual([
      [3, "As read in .", false],
    ]);
    // The other PDF of the same name has its own.
    const other = await readPdfMarks(
      vault,
      notesWithPassages(vault, graph, "Other/paper.pdf"),
      "Other/paper.pdf",
    );
    expect(other.highlights.map(({ highlight }) => highlight.id)).toEqual(["ddd444"]);
    expect(other.links).toEqual([]);
    expect(highlightsHome(found)).toBe(id("Papers/paper highlights.md"));
    expect(highlightsHome([])).toBeUndefined();
    // A note gone since is left out.
    expect(await readPdfMarks(vault, ["nope" as NoteId], "Papers/paper.pdf")).toEqual({
      highlights: [],
      links: [],
    });
  });

  it("go at the end of the note that holds most, linked as from it", async () => {
    const { vault, id, text } = await setUp();
    const before = await text("Papers/paper highlights.md");
    const added = await addPdfHighlight(
      vault,
      "Papers/paper.pdf",
      id("Papers/paper highlights.md"),
      "paper highlights",
      { passage: passage(5, 7), words: " New  words ", name: "paper, page 5" },
    );
    expect(added.note).toBe(id("Papers/paper highlights.md"));
    const after = await text("Papers/paper highlights.md");
    expect(after).toBe(
      `${before}\n> [!quote] [[paper.pdf#page=5&selection=7,0,7,4|paper, page 5]]\n> New words\n\n^${added.id}\n`,
    );
    expect(["aaa111", "bbb222"]).not.toContain(added.id);
  });

  it("start a note beside the PDF, the first free name, when none holds any", async () => {
    const { vault, text } = await setUp({ "Other/paper highlights.md": "Taken" });
    expect(highlightsNotePath(vault, "Other/paper.pdf", "paper highlights")).toBe(
      "Other/paper highlights 2.md",
    );
    expect(highlightsNotePath(vault, "top.pdf", "top: highlights?")).toBe("top highlights.md");
    const added = await addPdfHighlight(vault, "Other/paper.pdf", undefined, "paper highlights", {
      passage: passage(1, 0),
      words: "Fresh",
      name: "paper, page 1",
    });
    expect(vault.note(added.note)?.path).toBe("Other/paper highlights 2.md");
    // From beside it, its name alone finds the PDF.
    expect(await text("Other/paper highlights 2.md")).toBe(
      `> [!quote] [[paper.pdf#page=1&selection=0,0,0,4|paper, page 1]]\n> Fresh\n\n^${added.id}\n`,
    );
  });

  it("are commented on and removed in their note, and only highlights", async () => {
    const { vault, id, text } = await setUp();
    const note = id("Papers/paper highlights.md");
    expect(await setHighlightComment(vault, note, "aaa111" as BlockId, "Why **this**.")).toBe(true);
    expect(await text("Papers/paper highlights.md")).toContain("> Four\n>\n> Why **this**.\n");
    expect(await setHighlightComment(vault, note, "aaa111" as BlockId, "")).toBe(true);
    expect(await text("Papers/paper highlights.md")).toContain("> Four\n\n^aaa111");
    expect(await setHighlightColor(vault, note, "aaa111" as BlockId, "red")).toBe(true);
    expect(await text("Papers/paper highlights.md")).toContain(
      "[[paper.pdf#page=2&selection=1,0,1,4&color=red|paper, page 2]]",
    );
    expect(await setHighlightColor(vault, note, "zzz" as BlockId, "red")).toBe(false);
    expect(await removePdfHighlight(vault, note, "aaa111" as BlockId)).toBe(true);
    expect(await text("Papers/paper highlights.md")).not.toContain("aaa111");
    expect(await removePdfHighlight(vault, note, "aaa111" as BlockId)).toBe(false);
    expect(await setHighlightComment(vault, note, "zzz" as BlockId, "x")).toBe(false);
  });

  it("are linked to by their note's title, or its path where the title finds another", async () => {
    const { vault, graph, id } = await setUp({ "paper highlights.md": "Another" });
    expect(highlightLink(vault, graph, id("Essay.md"), "ccc333" as BlockId)).toBe(
      "[[Essay#^ccc333]]",
    );
    expect(highlightLink(vault, graph, id("Papers/paper highlights.md"), "aaa111" as BlockId)).toBe(
      "[[Papers/paper highlights#^aaa111]]",
    );
  });

  it("open their PDF at their passage when a link names their block", async () => {
    const { vault, id } = await setUp();
    expect(await highlightedPassage(vault, id("Essay.md"), "ccc333" as BlockId)).toEqual({
      path: "Papers/paper.pdf",
      part: "page=3&selection=2,0,2,4",
    });
    expect(await highlightedPassage(vault, id("Plain.md"), "nope" as BlockId)).toBeUndefined();
    expect(await highlightedPassage(vault, "gone" as NoteId, "ccc333" as BlockId)).toBeUndefined();
  });
});
