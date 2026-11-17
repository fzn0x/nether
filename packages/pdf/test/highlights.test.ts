import type { BlockId, ContentBlock } from "@nether/core";
import { parseMarkdown } from "@nether/markdown";
import { describe, expect, it } from "vitest";
import {
  addHighlight,
  commentBlocks,
  commentMarkdown,
  highlightCallout,
  highlightsNote,
  readHighlight,
  readHighlights,
  rewrite,
  withColor,
  withComment,
  withoutHighlight,
} from "../src/index.ts";

const note = `# Reading

Some thoughts first.

> [!quote] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]
> The words   highlighted.
>
> A comment with **bold**.
>
> - and a list

^k3x9q2ab

> [!note] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]
> Not a highlight: not a quote.

> [!quote] [[paper.pdf#page=3|paper, page 3]]
> Not a highlight: a page, not a passage.

> [!quote] See [[paper.pdf#page=3&selection=1,0,1,2]]
> Not a highlight: more than the link in its title.

- A list
  > [!quote] [[Papers/other.pdf#page=1&selection=0,0,0,5]]
  > Deeper.

  ^deep01
`;

const id = (text: string) => text as BlockId;

describe("highlights in a note", () => {
  it("reads callouts of the quote kind whose title is a link to a passage", () => {
    const highlights = readHighlights(parseMarkdown(note).content);
    expect(highlights.map((each) => each.id)).toEqual(["k3x9q2ab", "deep01"]);
    const [first, deeper] = highlights;
    expect(first).toMatchObject({
      target: "paper.pdf",
      passage: {
        page: 3,
        selection: { beginIndex: 4, beginOffset: 0, endIndex: 5, endOffset: 20 },
      },
      words: "The words highlighted.",
    });
    expect(commentMarkdown(first?.comment ?? [])).toBe("A comment with **bold**.\n\n- and a list");
    expect(deeper).toMatchObject({ target: "Papers/other.pdf", words: "Deeper.", comment: [] });
  });

  it("reads its words as their text, whatever another app wrote in them", () => {
    const [block] = parseMarkdown(
      "> [!quote] [[a.pdf#page=1&selection=0,0,0,1]]\n" +
        "> A #tag, [[Note|a note]], [[Other]], $x^2$ and <b>bold</b>  \n> on two lines\n",
    ).content;
    if (block === undefined) throw new Error("no block");
    expect(readHighlight(block)?.words).toBe(
      "A #tag, a note, Other, x^2 and <b>bold</b> on two lines",
    );
  });

  it("reads a highlight with no words as all comment", () => {
    const [block] = parseMarkdown(
      "> [!quote] [[a.pdf#page=1&selection=0,0,0,1]]\n> - a list first\n",
    ).content;
    if (block === undefined) throw new Error("no block");
    expect(readHighlight(block)).toMatchObject({ words: "" });
    expect(readHighlight(block)?.comment).toHaveLength(1);
  });

  it("makes a highlight that writes as Obsidian's link in a quote callout, its ID after it", () => {
    const callout = highlightCallout({
      id: id("h1"),
      target: "paper.pdf",
      passage: {
        page: 2,
        selection: { beginIndex: 1, beginOffset: 2, endIndex: 3, endOffset: 4 },
      },
      name: "paper, page 2",
      words: "  Words with #tag, [[a link]] and *stars*\n",
    });
    const text = highlightsNote(callout);
    expect(text).toBe(
      "> [!quote] [[paper.pdf#page=2&selection=1,2,3,4|paper, page 2]]\n" +
        "> Words with \\#tag, \\[\\[a link]] and \\*stars\\*\n\n^h1\n",
    );
    // Read back, it is the same highlight, its words as they were.
    const [read] = readHighlights(parseMarkdown(text).content);
    expect(read).toMatchObject({ id: "h1", words: "Words with #tag, [[a link]] and *stars*" });
  });

  it("adds a highlight at a note's end and keeps the rest of the note as it was", () => {
    const parsed = parseMarkdown(note);
    const callout = highlightCallout({
      id: id("new1"),
      target: "paper.pdf",
      passage: { page: 1, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 4 } },
      name: "paper, page 1",
      words: "Four",
      comment: commentBlocks("Why it matters."),
    });
    const text = addHighlight(parsed, callout);
    expect(text.startsWith(note)).toBe(true);
    expect(text.slice(note.length)).toBe(
      "\n> [!quote] [[paper.pdf#page=1&selection=0,0,0,4|paper, page 1]]\n> Four\n>\n> Why it matters.\n\n^new1\n",
    );
    expect(readHighlights(parseMarkdown(text).content).map((each) => each.id)).toEqual([
      "k3x9q2ab",
      "deep01",
      "new1",
    ]);
  });

  it("keeps a highlight's color, writes one, and changes or clears it in its link only", () => {
    const callout = highlightCallout({
      id: id("c1"),
      target: "paper.pdf",
      passage: {
        page: 2,
        selection: { beginIndex: 1, beginOffset: 2, endIndex: 3, endOffset: 4 },
        color: "red",
      },
      name: "paper, page 2",
      words: "Red words",
    });
    const text = highlightsNote(callout);
    expect(text).toContain("[[paper.pdf#page=2&selection=1,2,3,4&color=red|paper, page 2]]");
    const parsed = parseMarkdown(text);
    expect(readHighlights(parsed.content)[0]?.passage.color).toBe("red");

    const blue = withColor(parsed.content, id("c1"), "note");
    expect(rewrite(parsed, blue ?? [])).toBe(
      "> [!quote] [[paper.pdf#page=2&selection=1,2,3,4&color=note|paper, page 2]]\n> Red words\n\n^c1\n",
    );
    const plain = withColor(parsed.content, id("c1"), undefined);
    expect(rewrite(parsed, plain ?? [])).toContain(
      "[[paper.pdf#page=2&selection=1,2,3,4|paper, page 2]]",
    );
    expect(withColor(parsed.content, id("nothing"), "red")).toBeUndefined();
  });

  it("changes a highlight's comment, and only its comment", () => {
    const parsed = parseMarkdown(note);
    const content = withComment(parsed.content, id("k3x9q2ab"), commentBlocks("Now *this*."));
    if (content === undefined) throw new Error("not changed");
    const text = rewrite(parsed, content);
    expect(text).toContain(
      "> [!quote] [[paper.pdf#page=3&selection=4,0,5,20|paper, page 3]]\n> The words   highlighted.\n>\n> Now *this*.\n\n^k3x9q2ab\n",
    );
    const [first] = readHighlights(parseMarkdown(text).content);
    expect(commentMarkdown(first?.comment ?? [])).toBe("Now *this*.");

    const cleared = withComment(parsed.content, id("k3x9q2ab"), commentBlocks("  \n"));
    expect(readHighlights(cleared ?? [])[0]?.comment).toEqual([]);
  });

  it("does not change what is not a highlight, nor one without its words", () => {
    const parsed = parseMarkdown(note);
    const [, second] = parsed.content;
    expect(withComment(parsed.content, id("nothing"), [])).toBeUndefined();
    expect(withComment(parsed.content, second?.id ?? id("x"), [])).toBeUndefined();
    const [noWords] = parseMarkdown("> [!quote] [[a.pdf#page=1&selection=0,0,0,1]]\n> - a list\n")
      .content as ContentBlock[];
    if (noWords === undefined) throw new Error("no block");
    expect(withComment([noWords], noWords.id, commentBlocks("x"))).toBeUndefined();
  });

  it("removes a highlight at any depth, and nothing else", () => {
    const parsed = parseMarkdown(note);
    const top = withoutHighlight(parsed.content, id("k3x9q2ab"));
    expect(readHighlights(top ?? []).map((each) => each.id)).toEqual(["deep01"]);
    expect(rewrite(parsed, top ?? [])).not.toContain("The words");
    const deep = withoutHighlight(parsed.content, id("deep01"));
    expect(readHighlights(deep ?? []).map((each) => each.id)).toEqual(["k3x9q2ab"]);
    const [heading] = parsed.content;
    expect(withoutHighlight(parsed.content, heading?.id ?? id("x"))).toBeUndefined();
    expect(withoutHighlight(parsed.content, id("nothing"))).toBeUndefined();
  });

  it("reads, makes, comments on and recolors a highlight of an area, all of it comment", () => {
    const callout = highlightCallout({
      id: id("area1"),
      target: "paper.pdf",
      passage: { page: 3, rect: [72, 400, 300, 600] },
      name: "paper, page 3",
      words: "ignored for an area",
      comment: commentBlocks("The figure."),
    });
    const text = highlightsNote(callout);
    expect(text).toBe(
      "> [!quote] [[paper.pdf#page=3&rect=72,400,300,600|paper, page 3]]\n> The figure.\n\n^area1\n",
    );
    const parsed = parseMarkdown(text);
    const [read] = readHighlights(parsed.content);
    expect(read).toMatchObject({ passage: { page: 3, rect: [72, 400, 300, 600] }, words: "" });
    expect(commentMarkdown(read?.comment ?? [])).toBe("The figure.");

    const changed = withComment(parsed.content, id("area1"), commentBlocks("Now *this*."));
    expect(rewrite(parsed, changed ?? [])).toContain(
      "> [!quote] [[paper.pdf#page=3&rect=72,400,300,600|paper, page 3]]\n> Now *this*.\n",
    );
    const red = withColor(parsed.content, id("area1"), "red");
    expect(rewrite(parsed, red ?? [])).toContain(
      "[[paper.pdf#page=3&rect=72,400,300,600&color=red|paper, page 3]]",
    );
  });

  it("has no comment for no Markdown", () => {
    expect(commentBlocks("")).toEqual([]);
    expect(commentMarkdown([])).toBe("");
  });
});
